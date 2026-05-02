import { getAddress, verifyMessage } from "ethers";
import { canonicalJson } from "./canonical.js";

export type ArtifactKind = "review" | "audit";

export interface AgentStatusSigningPayload {
  requestId: string;
  agent: string;
  phase: string;
  status: string;
  detail?: string | null;
  payload?: Record<string, unknown>;
}

export function agentArtifactMessage(kind: ArtifactKind, hash: string): string {
  return `DAIO ${kind} artifact\nhash:${hash.toLowerCase()}`;
}

export function agentStatusMessage(input: AgentStatusSigningPayload): string {
  return `DAIO agent status\n${canonicalJson({
    requestId: input.requestId,
    agent: getAddress(input.agent),
    phase: input.phase,
    status: input.status,
    detail: input.detail ?? null,
    payload: input.payload ?? {},
  })}`;
}

export function verifyAgentSignature(expectedSigner: string, message: string, signature: string): boolean {
  return getAddress(verifyMessage(message, signature)) === getAddress(expectedSigner);
}
