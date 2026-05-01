import { getAddress } from "ethers";
import { ReviewOutput, AuditOutput, type ReviewOutput as ReviewOutputT, type AuditOutput as AuditOutputT } from "../../shared/schemas.js";

export function parseReview(raw: unknown, expect: { requestId: string; reviewer: string }): ReviewOutputT {
  const parsed = ReviewOutput.parse(raw);
  if (parsed.requestId !== expect.requestId) {
    throw new Error(`review.requestId mismatch: got ${parsed.requestId}, expected ${expect.requestId}`);
  }
  if (getAddress(parsed.reviewer) !== getAddress(expect.reviewer)) {
    throw new Error(`review.reviewer mismatch: got ${parsed.reviewer}, expected ${expect.reviewer}`);
  }
  return parsed;
}

export function parseAudit(
  raw: unknown,
  expect: { requestId: string; auditor: string; targets: string[] },
): AuditOutputT {
  const parsed = AuditOutput.parse(raw);
  if (parsed.requestId !== expect.requestId) {
    throw new Error(`audit.requestId mismatch`);
  }
  if (getAddress(parsed.auditor) !== getAddress(expect.auditor)) {
    throw new Error(`audit.auditor mismatch`);
  }
  if (parsed.targetEvaluations.length !== expect.targets.length) {
    throw new Error(
      `audit.targetEvaluations length mismatch: got ${parsed.targetEvaluations.length}, expected ${expect.targets.length}`,
    );
  }
  for (let i = 0; i < expect.targets.length; i++) {
    const got = getAddress(parsed.targetEvaluations[i]!.targetReviewer);
    const want = getAddress(expect.targets[i]!);
    if (got !== want) {
      throw new Error(`audit.targetEvaluations[${i}] order mismatch: got ${got}, expected ${want}`);
    }
  }
  return parsed;
}
