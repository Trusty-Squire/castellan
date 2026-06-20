import { describe, it, expect } from "vitest";
import { VisualVerdictSchema } from "../src/review/types.js";
import { visualAuditSummary, visualBlockChange } from "../src/funnel.js";

describe("visualAuditSummary", () => {
  it("returns under-scored dims (sorted) and the blocking fixes", () => {
    const verdict = VisualVerdictSchema.parse({
      dimensions: [
        { name: "Trust", score: 8, whatMakesIt10: "" },
        { name: "Headline value", score: 1, whatMakesIt10: "show the size" },
        { name: "Hierarchy", score: 4, whatMakesIt10: "" },
      ],
      findings: [],
      storyChecks: [{ story: "ranked by size", satisfied: false, note: "no size shown" }],
    });
    const { lowDims, fixes } = visualAuditSummary(verdict);
    expect(lowDims.map((d) => d.name)).toEqual(["Headline value", "Hierarchy"]); // <=5, sorted asc, Trust(8) excluded
    expect(fixes.length).toBeGreaterThan(0); // unsatisfied story blocks
  });
});

describe("visualBlockChange", () => {
  it("composes one change string from the fixes", () => {
    const c = visualBlockChange([{ fix: "show the size" }, { fix: "add empty state" }]);
    expect(c).toContain("visual design review");
    expect(c).toContain("show the size; add empty state");
  });
});
