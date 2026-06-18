import { z } from "zod";

/**
 * Shared schemas for the gstack-style review pipeline. A reviewer (ceo/design/
 * eng/dx) rates dimensions 0-10, emits patches (each a NEW gated requirement), and
 * classifies decisions it can't settle itself. The orchestrator auto-applies
 * mechanical decisions and surfaces taste/user-challenge at one final gate.
 */

/** One scored dimension, with the gstack "what would make it a 10" forcing function. */
export const ReviewDimensionSchema = z.object({
  name: z.string().min(1),
  score: z.number().int().min(0).max(10),
  whatMakesIt10: z.string().default(""),
});
export type ReviewDimension = z.infer<typeof ReviewDimensionSchema>;

/**
 * A patch turns a finding into a NEW gated requirement.
 *  - kind "objective": `gate` is a runnable shell command (exit 0 = pass) the
 *    build loop verifies directly — the same contract as today's spec patches.
 *  - kind "visual": needs the live screenshot judge (handled in the audit layer),
 *    because no shell assertion fairly captures it (aesthetic balance, spacing).
 */
export const ReviewPatchSchema = z.object({
  statement: z.string().min(1),
  gate: z.string().min(1),
  kind: z.enum(["objective", "visual"]).default("objective"),
});
export type ReviewPatch = z.infer<typeof ReviewPatchSchema>;

/**
 * A decision the reviewer can't settle by patching. Classification drives the
 * orchestrator (gstack autoplan): mechanical = auto-take options[0]; taste =
 * auto-take options[0] but surface at the final gate; user_challenge = NEVER
 * auto-decide (both the plan and the reviewer think the user's direction is wrong).
 */
export const ReviewDecisionSchema = z.object({
  text: z.string().min(1),
  options: z.array(z.string().min(1)).default([]),
  classification: z.enum(["mechanical", "taste", "user_challenge"]).default("taste"),
  recommendation: z.string().default(""),
  why: z.string().default(""),
  ifWrongCost: z.string().default(""),
  blocking: z.boolean().default(false),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const ReviewerResultSchema = z.object({
  reviewer: z.enum(["ceo", "design", "eng", "dx"]),
  overall: z.number().int().min(0).max(10).default(0),
  dimensions: z.array(ReviewDimensionSchema).default([]),
  patches: z.array(ReviewPatchSchema).default([]),
  decisions: z.array(ReviewDecisionSchema).default([]),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

/** Aggregate of all reviewers after orchestration. */
export interface PipelineResult {
  reviewers: ReviewerResult[];
  /** Auto-applied patches (objective build gates + visual checks for the audit layer). */
  patches: ReviewPatch[];
  /** Decisions surfaced for the ONE final human gate (taste + user_challenge). */
  finalGate: ReviewDecision[];
  scores: Partial<Record<"ceo" | "design" | "eng" | "dx", number>>;
}

// ---------------- live visual review (audit layer) ----------------

/**
 * The multimodal judge's verdict on a screenshot of the built UI. `storyChecks`
 * is the teeth: an unsatisfied story (e.g. "shows opportunities by size" when the
 * size never renders) blocks ship, even though every build gate was green.
 */
/** Severity, tolerant of model variants ("medium"→"med", "critical"→"high"). */
export const SeveritySchema = z.preprocess(
  (v) => {
    const s = typeof v === "string" ? v.toLowerCase().trim() : v;
    if (s === "medium") return "med";
    if (s === "critical" || s === "blocker") return "high";
    if (s === "minor" || s === "info" || s === "nit") return "low";
    return s;
  },
  z.enum(["high", "med", "low"]),
);

export const VisualVerdictSchema = z.object({
  dimensions: z.array(ReviewDimensionSchema).default([]),
  findings: z
    .array(
      z.object({
        principle: z.string().min(1),
        severity: SeveritySchema,
        note: z.string().min(1),
        fix: z.string().default(""),
      }),
    )
    .default([]),
  storyChecks: z
    .array(z.object({ story: z.string().min(1), satisfied: z.boolean(), note: z.string().default("") }))
    .default([]),
});
export type VisualVerdict = z.infer<typeof VisualVerdictSchema>;
