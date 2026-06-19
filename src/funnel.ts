import type { Spec } from "./contract/spec.js";
import type { VisualVerdict, ReviewDimension } from "./review/types.js";
import { blockingFixes } from "./review/visual.js";
import { isTestOnlyDelta } from "./review/raise.js";

/**
 * Shared funnel core — the spec-review and visual-audit LOGIC the CLI
 * (cmdPipeline) and the TUI (app) funnels run identically. The two funnels keep
 * their own interaction shells (the CLI is an autonomous batch; the TUI is an
 * interactive, turn-based session), because those shapes are genuinely different.
 * The logic lives here ONCE so it can't drift between them again — the CLI lacking
 * the rebuild loop, or the two handling a visual block differently, were both
 * drift bugs this module exists to prevent.
 */

type Requirement = Spec["requirements"][number];

/**
 * Apply a spec review's objective patches as tier-1 gated requirements, continuing
 * the R<n> numbering. Mutates `spec.requirements`; returns the added requirements
 * so each shell can present them its own way (CLI prints, TUI renders).
 */
export function applyReviewPatches(
  spec: Spec,
  patches: { statement: string; gate: string }[],
): { added: Requirement[]; skipped: { statement: string; gate: string }[] } {
  let rn = spec.requirements.length;
  const added: Requirement[] = [];
  const skipped: { statement: string; gate: string }[] = [];
  for (const p of patches) {
    // A coverage-only patch ("add a test for X") raises no product floor — reject
    // it so the spec doesn't fill with test-for-test's-sake requirements.
    if (isTestOnlyDelta(p.statement)) {
      skipped.push(p);
      continue;
    }
    const req: Requirement = { id: `R${++rn}`, statement: p.statement, acceptance: { tier: 1, gate: p.gate } };
    spec.requirements.push(req);
    added.push(req);
  }
  return { added, skipped };
}

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
