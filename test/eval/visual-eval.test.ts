import { describe, it, expect } from "vitest";
import { VisualVerdictSchema, SeveritySchema } from "../../src/review/types.js";
import { blockingFixes } from "../../src/review/visual.js";
import { scoreVisualVerdict, gateVisualEval, type LabeledVisualFixture } from "../../src/eval/visual-eval.js";

// A representative verdict the live judge actually returned for clairvoyance.
const CLAIR_VERDICT = VisualVerdictSchema.parse({
  dimensions: [
    { name: "Empty states are features", score: 2, whatMakesIt10: "designed empty state" },
    { name: "AI slop is the enemy", score: 2, whatMakesIt10: "replace bare tables" },
    { name: "Every screen has a hierarchy", score: 3, whatMakesIt10: "section distinction" },
  ],
  findings: [
    { principle: "AI slop", severity: "high", note: "Bare unstyled tables on a plain background with no hierarchy", fix: "Wrap tables in cards" },
    { principle: "Specificity", severity: "high", note: "The opportunity size/edge percentage is not displayed at all", fix: "Show edge % per opportunity" },
    { principle: "Empty states", severity: "high", note: "Opportunities section shows blank space instead of a designed empty state", fix: "Design an empty state" },
    { principle: "Consistency", severity: "medium", note: "No consistent spacing system", fix: "Define spacing scale" },
  ],
  storyChecks: [
    { story: "user sees a table of lines across multiple books", satisfied: false, note: "no book names visible — can't see which book offers which odds" },
    { story: "user sees opportunities ranked by size, largest first", satisfied: false, note: "one item but no size/edge percentage displayed, no ranking" },
    { story: "detector finds arb or reports none", satisfied: true, note: "" },
  ],
});

// A clean control verdict: all high, all stories delivered.
const CLEAN_VERDICT = VisualVerdictSchema.parse({
  dimensions: [
    { name: "Every screen has a hierarchy", score: 8, whatMakesIt10: "tighten spacing" },
    { name: "AI slop is the enemy", score: 8, whatMakesIt10: "more brand character" },
  ],
  findings: [{ principle: "Subtraction", severity: "low", note: "could trim a label", fix: "" }],
  storyChecks: [
    { story: "lines table", satisfied: true, note: "" },
    { story: "opportunities ranked by size", satisfied: true, note: "edge % shown, sorted desc" },
  ],
});

const FIX: LabeledVisualFixture = {
  id: "clairvoyance",
  buildDir: "/x",
  spec: { thesis: "", stories: [] },
  isControl: false,
  defects: [
    { tag: "size-not-displayed", keywords: ["size", "edge", "percentage"] },
    { tag: "ai-slop-bare-ui", keywords: ["bare", "unstyled", "hierarchy"] },
    { tag: "no-empty-state", keywords: ["empty state"] },
    { tag: "trivial-fake-data", keywords: ["book name"] },
  ],
};
const CONTROL: LabeledVisualFixture = { id: "clean", buildDir: "/y", spec: { thesis: "", stories: [] }, isControl: true, defects: [] };

describe("SeveritySchema normalizes model variants", () => {
  it("maps medium→med, critical→high, minor→low", () => {
    expect(SeveritySchema.parse("medium")).toBe("med");
    expect(SeveritySchema.parse("critical")).toBe("high");
    expect(SeveritySchema.parse("minor")).toBe("low");
    expect(SeveritySchema.parse("HIGH")).toBe("high");
  });
});

describe("blockingFixes (the teeth)", () => {
  it("blocks clairvoyance (unsatisfied stories + multiple highs)", () => {
    expect(blockingFixes(CLAIR_VERDICT).length).toBeGreaterThan(0);
  });
  it("does not block a clean verdict (satisfied stories, no/low findings)", () => {
    expect(blockingFixes(CLEAN_VERDICT).length).toBe(0);
  });
  it("an unsatisfied story alone blocks (the headline-value catch)", () => {
    const v = VisualVerdictSchema.parse({
      dimensions: [{ name: "Hierarchy", score: 8, whatMakesIt10: "" }],
      findings: [],
      storyChecks: [{ story: "shows the size", satisfied: false, note: "size not visible" }],
    });
    expect(blockingFixes(v).length).toBe(1);
  });
  it("a LONE borderline high finding does NOT block (judge-noise tolerance)", () => {
    const v = VisualVerdictSchema.parse({
      dimensions: [{ name: "Trust", score: 8, whatMakesIt10: "" }],
      findings: [{ principle: "Accessibility", severity: "high", note: "contrast may be low", fix: "darken" }],
      storyChecks: [{ story: "shows the size", satisfied: true, note: "" }],
    });
    expect(blockingFixes(v).length).toBe(0);
  });
});

describe("scoreVisualVerdict catches clairvoyance defects", () => {
  it("catches all 4 labeled defects and marks it blocked", () => {
    const s = scoreVisualVerdict(FIX, CLAIR_VERDICT);
    expect(s.missed).toEqual([]);
    expect(s.recall).toBe(1);
    expect(s.blocking).toBeGreaterThan(0);
    expect(s.falsePositive).toBe(false);
  });
  it("a clean control is not a false positive", () => {
    const s = scoreVisualVerdict(CONTROL, CLEAN_VERDICT);
    expect(s.falsePositive).toBe(false);
    expect(s.blocking).toBe(0);
  });
});

describe("gateVisualEval", () => {
  it("passes when defective is blocked+caught and control is clean", () => {
    const scores = [scoreVisualVerdict(FIX, CLAIR_VERDICT), scoreVisualVerdict(CONTROL, CLEAN_VERDICT)];
    const g = gateVisualEval(scores, [FIX, CONTROL]);
    expect(g.passed).toBe(true);
    expect(g.defectRecall).toBe(1);
    expect(g.falsePositives).toBe(0);
  });
});
