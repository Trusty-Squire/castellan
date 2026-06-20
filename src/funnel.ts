import type { VisualVerdict, ReviewDimension } from "./review/types.js";
import { blockingFixes } from "./review/visual.js";

/**
 * Shared funnel core — the visual-audit LOGIC the CLI (cmdPipeline) and the TUI
 * (app) funnels run identically. The two funnels keep their own interaction shells
 * (the CLI is an autonomous batch; the TUI is an interactive, turn-based session),
 * because those shapes are genuinely different. The logic lives here ONCE so it
 * can't drift between them again — the two handling a visual block differently was a
 * drift bug this module exists to prevent.
 */

/**
 * Pure summary of a visual verdict for the audit layer: the under-scored design
 * dimensions (to show) and the fixes that must BLOCK ship (the teeth). Both shells
 * compute this identically.
 */
export function visualAuditSummary(verdict: VisualVerdict): {
  lowDims: ReviewDimension[];
  fixes: { note: string; fix: string }[];
} {
  const lowDims = verdict.dimensions.filter((d) => d.score <= 5).sort((a, b) => a.score - b.score);
  return { lowDims, fixes: blockingFixes(verdict) };
}

/** The change string both funnels fold into the spec when the visual review blocks ship. */
export function visualBlockChange(fixes: { fix: string }[]): string {
  return (
    "the built UI failed its visual design review. Apply these fixes so each is visibly delivered: " +
    fixes.map((f) => f.fix).join("; ")
  );
}
