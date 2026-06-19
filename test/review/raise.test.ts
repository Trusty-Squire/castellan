import { describe, expect, it } from "vitest";
import { isTestOnlyDelta, planOuterDelta, reviewOuterDeltaBatch, reviewOuterDeltaCandidate } from "../../src/review/raise.js";
import { VisualVerdictSchema } from "../../src/review/types.js";

describe("planOuterDelta", () => {
  it("turns visual polish and audit recommendations into a small outer-loop delta", () => {
    const verdict = VisualVerdictSchema.parse({
      dimensions: [
        { name: "Hierarchy", score: 6, whatMakesIt10: "make the primary result dominate the first viewport" },
        { name: "Responsive", score: 7, whatMakesIt10: "tighten the phone layout" },
      ],
      findings: [{ principle: "Hierarchy", severity: "med", note: "primary value is buried", fix: "bring the primary result above the long prose" }],
      storyChecks: [{ story: "shows readings", satisfied: true, note: "" }],
    });
    const plan = planOuterDelta(
      { stories: ["a user sees tarot, tea leaves, and constellations"] },
      [{ lens: "design", severity: "med", note: "the restart control is easy to miss on completed readings" }],
      verdict,
    );
    expect(plan.stories).toEqual([
      "make the primary result dominate the first viewport",
      "bring the primary result above the long prose",
      "the restart control is easy to miss on completed readings",
    ]);
  });

  it("drops non-tractable outer-loop asks", () => {
    const verdict = VisualVerdictSchema.parse({
      dimensions: [{ name: "Hierarchy", score: 8, whatMakesIt10: "" }],
      findings: [],
      storyChecks: [{ story: "shows readings", satisfied: true, note: "" }],
    });
    const plan = planOuterDelta(
      { stories: [] },
      [{ lens: "eng", severity: "high", note: "add observability dashboards and a runbook" }],
      verdict,
    );
    expect(plan.stories).toEqual([]);
  });

  it("rejects blank-shell visual feedback as a likely render artifact", () => {
    expect(reviewOuterDeltaCandidate("The screenshots still show an apparently unrendered blank shell.").accepted).toBe(false);
    expect(reviewOuterDeltaCandidate("The phone viewport is blank and has no visible controls.").accepted).toBe(false);
    expect(reviewOuterDeltaCandidate("Add acceptance coverage proving the first viewport contains Gypsy.").accepted).toBe(false);
    expect(isTestOnlyDelta("Add acceptance coverage proving the first viewport contains Gypsy.")).toBe(true);
    expect(isTestOnlyDelta("Add automated coverage proving tarot returns a non-empty fortune.")).toBe(true);
    expect(isTestOnlyDelta("Add runnable browser coverage proving the first viewport contains Gypsy.")).toBe(true);
    expect(isTestOnlyDelta("Add input-specific fortune evidence tests: tarot names every drawn card and tea names the selected pattern.")).toBe(true);
  });

  it("batch review accepts only sane marginal mission deltas", () => {
    const decisions = reviewOuterDeltaBatch([
      "The screenshots still show an apparently unrendered blank shell.",
      "show an actual reading result tied to the selected mode in the visible workflow",
      "Add acceptance coverage proving the first viewport contains Gypsy.",
    ]);
    expect(decisions.map((d) => d.accepted)).toEqual([false, true, false]);
  });

  it("keeps real Gypsy product deltas and orders result work first", () => {
    const verdict = VisualVerdictSchema.parse({
      dimensions: [
        {
          name: "AI slop is the enemy",
          score: 5,
          whatMakesIt10: "remove duplicate mode-summary grids and make the active reading interaction primary",
        },
        {
          name: "Every screen has a hierarchy",
          score: 6,
          whatMakesIt10: "show an actual reading result tied to the selected mode in the visible workflow",
        },
        {
          name: "Responsive",
          score: 7,
          whatMakesIt10: "bring the active reading content higher on mobile",
        },
      ],
      findings: [
        {
          principle: "AI slop",
          severity: "high",
          note: "duplicate mode grids read as generic",
          fix: "replace duplicate mode-summary grids with one purposeful mode selector",
        },
        {
          principle: "Hierarchy",
          severity: "med",
          note: "the flow should be mode to interaction to reading result",
          fix: "clarify the flow from mode selection to interaction to reading result",
        },
      ],
      storyChecks: [
        { story: "the user can clearly choose tarot, tea leaves, or constellations", satisfied: true, note: "" },
        { story: "the first viewport feels mystical rather than generic", satisfied: true, note: "" },
      ],
    });
    const plan = planOuterDelta({ stories: [] }, [], verdict);
    expect(plan.stories).toEqual([
      "show an actual reading result tied to the selected mode in the visible workflow",
      "clarify the flow from mode selection to interaction to reading result",
      "remove duplicate mode-summary grids and make the active reading interaction primary",
    ]);
  });
});
