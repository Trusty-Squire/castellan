/**
 * Eval harness for the spec reviewers (ceo/design/eng/dx). Pure scorer here
 * (hermetic, unit-tested with a canned ReviewerResult); the live judge is the
 * reviewers themselves, driven by scripts/review-eval.ts. Measures whether each
 * reviewer CATCHES known spec defects (recall) without flagging clean controls
 * (precision) — the same recall/precision contract as poker-bench/visual-eval.
 *
 * "Caught" = the reviewer's haystack (patch statements/gates, low-scored
 * dimensions, decisions) mentions any keyword of a labeled defect. On a clean
 * CONTROL, a probe match is a FALSE POSITIVE — the reviewer flagged a defect that
 * isn't there.
 */
import type { ReviewerResult } from "../review/types.js";
import type { ReviewSpecInput } from "../review/reviewers.js";

export type ReviewerName = ReviewerResult["reviewer"];

export interface LabeledDefect {
  tag: string;
  keywords: string[];
}

/** A spec with KNOWN, labeled defects a specific reviewer should catch (or a clean control). */
export interface LabeledSpecFixture {
  id: string;
  /** The spec fed to the reviewer in the live run (a full Spec is assignable). */
  spec: ReviewSpecInput;
  /** Which reviewer's defects this fixture targets. */
  reviewer: ReviewerName;
  /** A clean control: ANY probe match is a false positive. */
  isControl: boolean;
  /** Defects the reviewer SHOULD catch (empty for a clean control). */
  defects: LabeledDefect[];
  /** Probes a clean impl should NOT trigger (matches = false positives). */
  probes: LabeledDefect[];
}

export interface ReviewEvalScore {
  id: string;
  reviewer: ReviewerName;
  isControl: boolean;
  caught: string[];
  missed: string[];
  recall: number; // caught / total defects (1 for fixtures with no defects)
  falsePositives: string[]; // probe tags the reviewer matched
}

/** The text a defect can be "caught" in: patches, low dimensions, decisions. */
function haystack(r: ReviewerResult): string {
  const parts: string[] = [];
  for (const d of r.dimensions) if (d.score <= 5) parts.push(d.name, d.whatMakesIt10);
  for (const p of r.patches) parts.push(p.statement, p.gate);
  for (const dec of r.decisions) parts.push(dec.text, dec.recommendation, dec.why);
  return parts.join("  ").toLowerCase();
}

const matches = (text: string, d: LabeledDefect): boolean => d.keywords.some((k) => text.includes(k.toLowerCase()));

/** Pure: does the reviewer catch the fixture's labeled defects, and does it over-flag? */
export function scoreReviewerResult(fx: LabeledSpecFixture, r: ReviewerResult): ReviewEvalScore {
  const text = haystack(r);
  const caught: string[] = [];
  const missed: string[] = [];
  for (const d of fx.defects) (matches(text, d) ? caught : missed).push(d.tag);
  const falsePositives = fx.probes.filter((p) => matches(text, p)).map((p) => p.tag);
  return {
    id: fx.id,
    reviewer: fx.reviewer,
    isControl: fx.isControl,
    caught,
    missed,
    recall: fx.defects.length ? caught.length / fx.defects.length : 1,
    falsePositives,
  };
}

export interface ReviewEvalThresholds {
  minRecall: number;
  /** Optional precision floor (TP / (TP+FP)). Omit to skip. */
  minPrecision?: number;
  /** Optional cap on false positives across the reviewer's control fixtures. Omit to skip. */
  maxControlFalsePositives?: number;
}

export interface ReviewEvalGate {
  reviewer: ReviewerName;
  passed: boolean;
  recall: number; // mean recall over the reviewer's DEFECTIVE fixtures
  precision: number; // TP / (TP + FP) across all the reviewer's fixtures
  controlFalsePositives: number;
  defectiveTotal: number;
}

/** Aggregate gate for one reviewer (poker-bench style): recall + precision + control FP. */
export function gateReviewEval(
  reviewer: ReviewerName,
  scores: ReviewEvalScore[],
  thresholds: ReviewEvalThresholds,
): ReviewEvalGate {
  const mine = scores.filter((s) => s.reviewer === reviewer);
  // recall over DEFECTIVE fixtures that actually carry defects (a vacuous dx
  // self-skip has none, so it doesn't drag recall down).
  const withDefects = mine.filter((s) => !s.isControl && s.caught.length + s.missed.length > 0);
  const recall = withDefects.length ? withDefects.reduce((a, s) => a + s.recall, 0) / withDefects.length : 1;
  // precision over the whole reviewer: caught are true positives; probe matches
  // (only controls carry probes) are false positives.
  const tp = mine.reduce((a, s) => a + s.caught.length, 0);
  const fp = mine.reduce((a, s) => a + s.falsePositives.length, 0);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const controlFalsePositives = mine.filter((s) => s.isControl).reduce((a, s) => a + s.falsePositives.length, 0);
  const passed =
    recall >= thresholds.minRecall &&
    (thresholds.minPrecision === undefined || precision >= thresholds.minPrecision) &&
    (thresholds.maxControlFalsePositives === undefined || controlFalsePositives <= thresholds.maxControlFalsePositives);
  return { reviewer, passed, recall, precision, controlFalsePositives, defectiveTotal: withDefects.length };
}
