import "dotenv/config";
import { buildServer } from "./server.js";

const port = Number(process.env.CONTENT_SERVICE_PORT ?? 18002);
const host = process.env.CONTENT_SERVICE_HOST ?? "127.0.0.1";
const dbPath = process.env.CONTENT_DB_PATH ?? "./.data/content.sqlite";
const deploymentPath = process.env.CONTENT_DEPLOYMENT_PATH ?? process.env.DAIO_DEPLOYMENT_PATH ?? "./.deployments/local.json";
const rpcUrl = process.env.CONTENT_CHAIN_RPC_URL ?? process.env.RPC_URL;
const relayerPrivateKey = process.env.CONTENT_RELAYER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
const relayerConfirmations = Number(process.env.CONTENT_RELAYER_CONFIRMATIONS ?? "1");
const requireAgentSignatures = !["0", "false", "no", "off"].includes(
  (process.env.CONTENT_REQUIRE_AGENT_SIGNATURES ?? "true").trim().toLowerCase(),
);

const { app, db } = buildServer({
  dbPath,
  logger: process.env.CONTENT_SERVICE_LOG === "1",
  chain: { deploymentPath, rpcUrl },
  relayer: {
    privateKey: relayerPrivateKey,
    confirmations: Number.isFinite(relayerConfirmations) && relayerConfirmations >= 0 ? relayerConfirmations : 1,
  },
  requireAgentSignatures,
});

async function main() {
  await app.listen({ host, port });
  process.stdout.write(`[content-service] listening http://${host}:${port} db=${dbPath}\n`);
}

async function shutdown(signal: string) {
  process.stdout.write(`[content-service] received ${signal}, shutting down\n`);
  try {
    await app.close();
  } finally {
    db.close();
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  process.stderr.write(`[content-service] fatal: ${err}\n`);
  process.exit(1);
});
