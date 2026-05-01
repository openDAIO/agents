export interface ProposalContent {
  uri: string;
  hash: string;
  mimeType: string;
  text: string;
}

export interface TargetReportContent {
  targetReviewer: string;
  proposalScore: number;
  reportURI: string;
  reportHash: string;
  report: unknown;
}

const DEFAULT_PROPOSAL_BUDGET = 350_000;
const TARGET_REPORT_CHAR_CAP = 8_000;

export function budgetProposal(text: string): string {
  const budget = Number(process.env.LLM_PROPOSAL_CHAR_BUDGET ?? DEFAULT_PROPOSAL_BUDGET);
  if (text.length <= budget) return text;
  // keep abstract + first half of body, then a marker
  const head = text.slice(0, Math.floor(budget * 0.85));
  const tail = text.slice(text.length - Math.floor(budget * 0.1));
  return `${head}\n\n[... document truncated for context budget ...]\n\n${tail}`;
}

export function budgetTargetReport(report: unknown): unknown {
  const json = JSON.stringify(report);
  if (json.length <= TARGET_REPORT_CHAR_CAP) return report;
  // gracefully degrade: keep summary + score-only assessments
  if (typeof report === "object" && report !== null) {
    const r = report as Record<string, unknown>;
    return {
      summary: r.summary,
      rubricAssessments: Array.isArray(r.rubricAssessments)
        ? r.rubricAssessments.map((a) => {
            const x = a as Record<string, unknown>;
            return { criterion: x.criterion, score: x.score };
          })
        : undefined,
      recommendation: r.recommendation,
      confidence: r.confidence,
      _truncated: true,
    };
  }
  return { _truncated: true };
}
