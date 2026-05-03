import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Interface, Wallet, getAddress, keccak256, toUtf8Bytes, type LogDescription } from "ethers";
import { ContentServiceClient } from "../shared/content-client.js";
import { Artifacts } from "../shared/abis.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { RequestStatus } from "../shared/types.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import { makeChainContext } from "../reviewer-agent/chain/provider.js";
import { waitForTransactionWithRetries } from "../shared/rpc.js";

type Mode = "relayed" | "direct";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDeployment(file: string): DeploymentSnapshot {
  return JSON.parse(readFileSync(file, "utf8")) as DeploymentSnapshot;
}

function safeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "document";
}

async function convertPdf(input: { markitdownUrl: string; pdfPath: string }): Promise<string> {
  const raw = readFileSync(input.pdfPath);
  const filename = path.basename(input.pdfPath);
  const res = await fetch(`${input.markitdownUrl.replace(/\/$/, "")}/convert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Filename": filename,
    },
    body: raw,
  });
  if (!res.ok) throw new Error(`markitdown convert failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { markdown?: string };
  if (!json.markdown) throw new Error("markitdown returned empty markdown");
  return json.markdown;
}

async function submitRelayed(input: {
  content: ContentServiceClient;
  requester: Wallet;
  id: string;
  text: string;
  domainMask: string;
  tier: number;
  priorityFee: string;
}) {
  const requester = getAddress(input.requester.address);
  const intent = await input.content.createUSDAIORequestIntent({
    requester,
    id: input.id,
    text: input.text,
    domainMask: input.domainMask,
    tier: input.tier,
    priorityFee: input.priorityFee,
    mimeType: "text/markdown",
  });
  const signature = await input.requester.signTypedData(
    intent.typedData.domain,
    intent.typedData.types,
    intent.typedData.message,
  );
  const relayed = await input.content.submitRelayedRequestDocument({
    requester,
    signature,
    deadline: intent.deadline,
    id: intent.id,
    text: input.text,
    domainMask: input.domainMask,
    tier: input.tier,
    priorityFee: input.priorityFee,
    mimeType: "text/markdown",
  });
  return {
    requestId: BigInt(relayed.relayed.requestId),
    txHash: relayed.relayed.txHash,
  };
}

async function submitDirect(input: {
  content: ContentServiceClient;
  deployment: DeploymentSnapshot;
  requester: Wallet;
  id: string;
  text: string;
  domainMask: string;
  tier: number;
  priorityFee: bigint;
}) {
  const handles = loadContracts(input.deployment, input.requester);
  const proposalURI = `content://proposals/${input.id}`;
  const proposalHash = keccak256(toUtf8Bytes(input.text));
  const rubricHash = keccak256(toUtf8Bytes(`${input.id}:rubric`));
  const requiredUsdaio = ((await handles.core.baseRequestFee()) as bigint) + input.priorityFee;
  const paymentRouter = getAddress(input.deployment.contracts.paymentRouter);
  const allowance = (await handles.usdaio.allowance(input.requester.address, paymentRouter)) as bigint;
  if (allowance < requiredUsdaio) {
    const approveTx = await handles.usdaio.approve(paymentRouter, requiredUsdaio);
    const approveReceipt = await waitForTransactionWithRetries(approveTx);
    if (!approveReceipt || approveReceipt.status !== 1) throw new Error(`USDAIO approve failed: ${approveTx.hash}`);
    process.stdout.write(`[live-e2e] approved USDAIO tx=${approveReceipt.hash}\n`);
  }

  const tx = await handles.paymentRouter.createRequestWithUSDAIO(
    proposalURI,
    proposalHash,
    rubricHash,
    input.domainMask,
    input.tier,
    input.priorityFee,
  );
  const receipt = await waitForTransactionWithRetries(tx);
  if (!receipt || receipt.status !== 1) throw new Error(`direct request tx failed: ${tx.hash}`);

  const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
  const paid = receipt.logs
    .filter((log: { address: string }) => getAddress(log.address) === paymentRouter)
    .flatMap((log: { topics: readonly string[]; data: string }): LogDescription[] => {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "RequestPaid" ? [parsed] : [];
      } catch (_err) {
        return [];
      }
    })
    .find((event: LogDescription) => getAddress(String(event.args.requester)) === getAddress(input.requester.address));
  if (!paid) throw new Error("RequestPaid event not found");
  const requestId = BigInt(paid.args.requestId);

  await input.content.submitRequestDocument({
    requestId,
    txHash: receipt.hash,
    requester: input.requester.address,
    id: input.id,
    text: input.text,
    mimeType: "text/markdown",
  });

  return { requestId, txHash: receipt.hash };
}

async function maybeStartQueued(handles: ReturnType<typeof loadContracts>): Promise<string | undefined> {
  try {
    await handles.core.startNextRequest.staticCall();
  } catch (_err) {
    return undefined;
  }
  const tx = await handles.core.startNextRequest();
  const receipt = await waitForTransactionWithRetries(tx);
  if (!receipt || receipt.status !== 1) throw new Error(`startNextRequest failed: ${tx.hash}`);
  return receipt.hash;
}

async function waitFinalized(input: {
  handles: ReturnType<typeof loadContracts>;
  startHandles?: ReturnType<typeof loadContracts>;
  requestId: bigint;
  manualStart: boolean;
  timeoutMs: number;
  pollMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const lifecycle = await input.handles.core.getRequestLifecycle(input.requestId);
    const status = Number(lifecycle[1] as bigint | number) as RequestStatus;
    const statusName = RequestStatus[status] ?? `Status${status}`;
    process.stdout.write(`[live-e2e] requestId=${input.requestId} status=${statusName}\n`);
    if (status === RequestStatus.Finalized) return lifecycle;
    if ([RequestStatus.Cancelled, RequestStatus.Failed, RequestStatus.Unresolved].includes(status)) {
      throw new Error(`request ended as ${statusName}`);
    }
    if (status === RequestStatus.Queued && input.manualStart) {
      const txHash = await maybeStartQueued(input.startHandles ?? input.handles);
      if (txHash) process.stdout.write(`[live-e2e] manual startNextRequest tx=${txHash}\n`);
    }
    await delay(input.pollMs);
  }
  throw new Error(`timed out waiting for request ${input.requestId} to finalize`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "relayed" },
      pdf: { type: "string" },
      id: { type: "string" },
      "manual-start": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      "poll-ms": { type: "string" },
      tier: { type: "string" },
      "domain-mask": { type: "string" },
      "priority-fee": { type: "string" },
    },
  });
  const mode = values.mode as Mode;
  if (!["relayed", "direct"].includes(mode)) throw new Error("--mode must be relayed or direct");
  const pdfPath = values.pdf;
  if (!pdfPath) throw new Error("--pdf is required");

  const deploymentPath =
    process.env.DAIO_DEPLOYMENT_PATH ??
    (process.env.DAIO_DEPLOYMENT_FILE ? path.join(".deployments", process.env.DAIO_DEPLOYMENT_FILE) : ".deployments/sepolia.json");
  const deployment = loadDeployment(deploymentPath);
  const rpcUrl = requiredEnv("RPC_URL");
  const requesterKey = requiredEnv("DAIO_REQUESTER_PRIVATE_KEY");
  const contentUrl = process.env.CONTENT_SERVICE_URL ?? "http://127.0.0.1:18002";
  const markitdownUrl = process.env.MARKITDOWN_URL ?? "http://127.0.0.1:18003";
  const ctx = makeChainContext(rpcUrl, requesterKey, process.env.RPC_URLS);
  const requester = ctx.wallet;
  const content = new ContentServiceClient(contentUrl);
  const handles = loadContracts(deployment, requester);
  const startHandles =
    values["manual-start"] && process.env.DAIO_KEEPER_PRIVATE_KEY
      ? loadContracts(deployment, makeChainContext(rpcUrl, process.env.DAIO_KEEPER_PRIVATE_KEY, process.env.RPC_URLS).wallet)
      : handles;
  const id = values.id ?? `live-${Date.now()}-${safeId(path.basename(pdfPath, path.extname(pdfPath)))}`;
  const domainMask = values["domain-mask"] ?? "1";
  const tier = Number.parseInt(values.tier ?? "0", 10);
  const priorityFee = BigInt(values["priority-fee"] ?? "0");
  const timeoutMs = values["timeout-ms"] ? Number.parseInt(values["timeout-ms"], 10) : integerEnv("LIVE_E2E_TIMEOUT_MS", 900_000, 1);
  const pollMs = values["poll-ms"] ? Number.parseInt(values["poll-ms"], 10) : integerEnv("LIVE_E2E_POLL_MS", 15_000, 1);

  process.stdout.write(`[live-e2e] converting ${pdfPath}\n`);
  const text = await convertPdf({ markitdownUrl, pdfPath });
  process.stdout.write(`[live-e2e] markdown bytes=${Buffer.byteLength(text, "utf8")} id=${id}\n`);

  const submitted =
    mode === "relayed"
      ? await submitRelayed({
          content,
          requester,
          id,
          text,
          domainMask,
          tier,
          priorityFee: priorityFee.toString(),
        })
      : await submitDirect({
          content,
          deployment,
          requester,
          id,
          text,
          domainMask,
          tier,
          priorityFee,
        });
  process.stdout.write(`[live-e2e] submitted mode=${mode} requestId=${submitted.requestId} tx=${submitted.txHash}\n`);

  const lifecycle = await waitFinalized({
    handles,
    startHandles,
    requestId: submitted.requestId,
    manualStart: Boolean(values["manual-start"]),
    timeoutMs,
    pollMs,
  });
  process.stdout.write(
    `[live-e2e] finalized requestId=${submitted.requestId} feePaid=${lifecycle[2]} retryCount=${lifecycle[4]} lowConfidence=${lifecycle[8]}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[live-e2e] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
