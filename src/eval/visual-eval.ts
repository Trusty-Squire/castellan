/**
 * Eval harness for the live visual review (the clairvoyance catch). Pure scorer
 * here (hermetic, unit-tested); the live judge is `visualReview` in
 * src/review/visual.ts, driven by scripts/visual-eval.ts. Measures whether the
 * judge CATCHES known design defects (recall) without flagging clean controls
 * (precision) — the same recall/precision contract as poker-bench.
 */
import type { VisualVerdict } from "../review/types.js";
import { blockingFixes } from "../review/visual.js";

/** A build with KNOWN, labeled design defects (or a clean control). */
export interface LabeledVisualFixture {
  id: string;
  /** Path to the built UI (contains index.html). */
  buildDir: string;
  spec: { thesis: string; stories: string[] };
  /** A clean control: ANY blocking fix is a false positive. */
  isControl: boolean;
  /** Each defect is "caught" if a finding/unsatisfied-story/low dimension mentions any keyword. */
  defects: { tag: string; keywords: string[] }[];
}

export interface VisualEvalScore {
  id: string;
  caught: string[];
  missed: string[];
  recall: number; // caught / total defects (1 for controls with no defects)
  blocking: number; // # blocking fixes the verdict produces
  falsePositive: boolean; // control that got blocked
}

const hay = (verdict: VisualVerdict): string => {
  const parts: string[] = [];
  for (const d of verdict.dimensions) if (d.score <= 5) parts.push(d.name);
  for (const f of verdict.findings) parts.push(f.note, f.principle);
  for (const s of verdict.storyChecks) if (!s.satisfied) parts.push(s.story, s.note);
  return parts.join("  ").toLowerCase();
};

/** Pure: does the verdict catch the fixture's labeled defects, and does it (not) block? */
export function scoreVisualVerdict(fx: LabeledVisualFixture, verdict: VisualVerdict): VisualEvalScore {
  const text = hay(verdict);
  const caught: string[] = [];
  const missed: string[] = [];
  for (const d of fx.defects) {
    if (d.keywords.some((k) => text.includes(k.toLowerCase()))) caught.push(d.tag);
    else missed.push(d.tag);
  }
  const blocking = blockingFixes(verdict).length;
  return {
    id: fx.id,
    caught,
    missed,
    recall: fx.defects.length ? caught.length / fx.defects.length : 1,
    blocking,
    falsePositive: fx.isControl && blocking > 0,
  };
}

export interface VisualEvalGate {
  passed: boolean;
  defectRecall: number; // mean recall over defective fixtures
  defectiveBlocked: number; // defective fixtures that got blocked (should be all)
  defectiveTotal: number;
  falsePositives: number; // controls blocked (should be 0)
}

/**
 * Aggregate gate (poker-bench style): every defective fixture must be BLOCKED and
 * its labeled defects caught; no control may be blocked.
 */
export function gateVisualEval(scores: VisualEvalScore[], fixtures: LabeledVisualFixture[]): VisualEvalGate {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const defective = scores.filter((s) => !byId.get(s.id)?.isControl);
  const defectiveBlocked = defective.filter((s) => s.blocking > 0).length;
  const recall = defective.length ? defective.reduce((a, s) => a + s.recall, 0) / defective.length : 1;
  const falsePositives = scores.filter((s) => s.falsePositive).length;
  return {
    passed: defectiveBlocked === defective.length && recall >= 0.75 && falsePositives === 0,
    defectRecall: recall,
    defectiveBlocked,
    defectiveTotal: defective.length,
    falsePositives,
  };
}
