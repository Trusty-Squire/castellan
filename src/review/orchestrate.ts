/**
 * reviewPlan — the Phase 2 orchestrator (gstack autoplan, native fork). Runs the
 * four reviewers ceo→design→eng→dx SEQUENTIALLY as a FOLD: each reviewer's
 * objective patches are appended to a working spec copy BEFORE the next reviewer
 * sees them, so eng reviews the design-hardened spec, etc. The orchestrator does
 * NO LLM work — classification (mechanical | taste | user_challenge) comes from
 * the reviewers themselves, so the auto-decide logic here is fully MockLlm-testable.
 *
 *   mechanical    → auto-take options[0] silently (the 6 principles settled it).
 *   taste         → apply the recommendation but surface it at the ONE final gate.
 *   user_challenge→ never auto-decide; surface at the final gate with context.
 */
import type { LlmClient } from "../llm/types.js";
import type { Spec } from "../contract/spec.js";
import { ceoReview, designReview, engReview, dxReview, type ReviewerName, type ReviewSpecInput } from "./reviewers.js";
import type { PipelineResult, ReviewPatch, ReviewDecision, ReviewerResult } from "./types.js";

export interface ReviewPlanOpts {
  /** Called with each reviewer's name just before its call — for CLI/TUI progress. */
  onReviewer?: (reviewer: ReviewerName) => void;
}

type Reviewer = (spec: Spec | ReviewSpecInput, llm: LlmClient, model: string) => Promise<ReviewerResult>;

/** gstack order: scope (ceo) → UX (design) → execution (eng) → developer surface (dx). */
const PIPELINE: readonly [ReviewerName, Reviewer][] = [
  ["ceo", ceoReview],
  ["design", designReview],
  ["eng", engReview],
  ["dx", dxReview],
];

export async function reviewPlan(
  spec: Spec,
  llm: LlmClient,
  model: string,
  opts: ReviewPlanOpts = {},
): Promise<PipelineResult> {
  // A working copy of the review-relevant spec. Objective patches fold in as new
  // requirements between reviewers; the original `spec` is never mutated.
  const working: ReviewSpecInput = {
    thesis: spec.thesis,
    stories: [...spec.stories],
    requirements: spec.requirements.map((r) => ({
      id: r.id,
      statement: r.statement,
      acceptance: { ...r.acceptance },
    })),
  };
  let rn = working.requirements.length;

  const reviewers: ReviewerResult[] = [];
  const patches: ReviewPatch[] = [];
  const finalGate: ReviewDecision[] = [];
  const scores: PipelineResult["scores"] = {};

  for (const [name, fn] of PIPELINE) {
    opts.onReviewer?.(name);
    const result = await fn(working, llm, model);
    reviewers.push(result);
    scores[name] = result.overall;

    for (const p of result.patches) {
      patches.push(p);
      // Only OBJECTIVE patches fold into the spec the next reviewer reads — they
      // are real gated requirements. Visual patches are for the audit-layer judge.
      if (p.kind === "objective") {
        working.requirements.push({ id: `R${++rn}`, statement: p.statement, acceptance: { tier: 1, gate: p.gate } });
      }
    }

    for (const d of result.decisions) {
      // mechanical decisions are auto-resolved (the recommended/options[0] direction)
      // and intentionally NOT surfaced; only genuine taste/user-challenge forks reach
      // the single human gate.
      if (d.classification !== "mechanical") finalGate.push(d);
    }
  }

  return { reviewers, patches, finalGate, scores };
}
