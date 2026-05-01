import { z } from "zod";

const Score = z.number().int().min(0).max(10000);

const HexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be 0x-prefixed 20-byte address");
const HexBytes32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be 0x-prefixed 32-byte hex");

export const RubricAssessment = z.object({
  criterion: z.string().min(1).max(80),
  score: Score,
  rationale: z.string().min(1).max(2000),
});

export const ReviewReport = z.object({
  summary: z.string().min(1).max(4000),
  rubricAssessments: z.array(RubricAssessment).min(1).max(12),
  strengths: z.array(z.string().min(1).max(800)).min(0).max(10),
  weaknesses: z.array(z.string().min(1).max(800)).min(0).max(10),
  risks: z.array(z.string().min(1).max(800)).min(0).max(10).optional().default([]),
  recommendation: z.enum(["accept", "weak_accept", "borderline", "weak_reject", "reject"]),
  confidence: Score,
});

export const ReviewOutput = z.object({
  schema: z.literal("daio.review.output.v1"),
  requestId: z.string().regex(/^\d+$/),
  reviewer: HexAddress,
  proposalScore: Score,
  report: ReviewReport,
  metadata: z
    .object({
      model: z.string().optional(),
      createdAt: z.string().optional(),
    })
    .partial()
    .optional()
    .default({}),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const TargetEvaluation = z.object({
  targetReviewer: HexAddress,
  score: Score,
  rationale: z.string().min(1).max(2000),
  confidence: Score.optional(),
});

export const AuditOutput = z.object({
  schema: z.literal("daio.audit.output.v1"),
  requestId: z.string().regex(/^\d+$/),
  auditor: HexAddress,
  targetEvaluations: z.array(TargetEvaluation).min(1).max(12),
  metadata: z
    .object({
      model: z.string().optional(),
      createdAt: z.string().optional(),
    })
    .partial()
    .optional()
    .default({}),
});
export type AuditOutput = z.infer<typeof AuditOutput>;

export const ReviewArtifact = z.object({
  schema: z.literal("daio.review.artifact.v1"),
  requestId: z.string().regex(/^\d+$/),
  reviewer: HexAddress,
  proposalScore: Score,
  report: ReviewReport,
  source: z.object({
    proposalURI: z.string(),
    proposalHash: HexBytes32,
    rubricHash: HexBytes32,
  }),
  metadata: z.record(z.unknown()).optional().default({}),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

export const AuditArtifact = z.object({
  schema: z.literal("daio.audit.artifact.v1"),
  requestId: z.string().regex(/^\d+$/),
  auditor: HexAddress,
  targets: z.array(HexAddress),
  scores: z.array(Score),
  rationales: z.array(z.string()),
  source: z.object({
    proposalURI: z.string(),
    proposalHash: HexBytes32,
  }),
  metadata: z.record(z.unknown()).optional().default({}),
});
export type AuditArtifact = z.infer<typeof AuditArtifact>;
