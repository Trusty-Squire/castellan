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
  /** Hard cap on objective patches folded into the spec (scope governor). Default 8. */
  maxObjectivePatches?: number;
  /** Per-reviewer patch cap (belt-and-braces with the prompt's "at most 3"). Default 3. */
  maxPatchesPerReviewer?: number;
}

/** Normalize a patch statement for dedupe (whitespace/case/punctuation-insensitive). */
const normStatement = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
  const maxObjective = opts.maxObjectivePatches ?? 8;
  const perReviewer = opts.maxPatchesPerReviewer ?? 3;

  const reviewers: ReviewerResult[] = [];
  const patches: ReviewPatch[] = [];
  const finalGate: ReviewDecision[] = [];
  const scores: PipelineResult["scores"] = {};
  const seen = new Set(working.requirements.map((r) => normStatement(r.statement)));
  let objectiveCount = 0;

  for (const [name, fn] of PIPELINE) {
    opts.onReviewer?.(name);
    const result = await fn(working, llm, model);
    reviewers.push(result);
    scores[name] = result.overall;

    // Scope governor: take at most `perReviewer` patches, and fold objective ones
    // only up to the global cap, de-duped. `patches` holds exactly what was KEPT so
    // the reviewSpec adapter maps requirements 1:1. Visual patches (rare) pass
    // through to the audit judge.
    for (const p of result.patches.slice(0, perReviewer)) {
      if (p.kind !== "objective") {
        patches.push(p);
        continue;
      }
      const key = normStatement(p.statement);
      if (objectiveCount >= maxObjective || seen.has(key)) continue;
      seen.add(key);
      objectiveCount += 1;
      patches.push(p);
      working.requirements.push({ id: `R${++rn}`, statement: p.statement, acceptance: { tier: 1, gate: p.gate } });
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
