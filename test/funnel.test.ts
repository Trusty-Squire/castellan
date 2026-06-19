import { describe, it, expect } from "vitest";
import { parseSpec } from "../src/contract/spec.js";
import { VisualVerdictSchema } from "../src/review/types.js";
import { applyReviewPatches, visualAuditSummary, visualBlockChange } from "../src/funnel.js";

const baseSpec = `
thesis: "an arb dashboard"
stories:
  - "user sees opportunities ranked by size"
requirements:
  - id: R1
    statement: "render the list"
    acceptance: { tier: 1, gate: "test -f index.html" }
`;

describe("applyReviewPatches (shared funnel core)", () => {
  it("appends objective patches as tier-1 gated requirements, continuing R<n>", () => {
    const spec = parseSpec(baseSpec);
    const { added } = applyReviewPatches(spec, [
      { statement: "each opportunity prominently shows its edge size", gate: "grep -q data-edge index.html" },
      { statement: "a designed empty state when there are no opportunities", gate: "grep -qi 'no opportunities' index.html" },
    ]);
    expect(added.map((r) => r.id)).toEqual(["R2", "R3"]);
    expect(spec.requirements).toHaveLength(3);
    expect(spec.requirements[1]).toMatchObject({ id: "R2", acceptance: { tier: 1, gate: "grep -q data-edge index.html" } });
    expect(added[0]!.statement).toBe("each opportunity prominently shows its edge size");
  });

  it("rejects process-doc and coverage-only patches (gold-plating, not the MVP)", () => {
    const spec = parseSpec(baseSpec);
    const { added, skipped } = applyReviewPatches(spec, [
      { statement: "render each opportunity's edge size prominently", gate: "grep -q data-edge index.html" },
      { statement: "Add an architecture/data-flow document with a Mermaid diagram covering ingestion", gate: "test -f docs/arch.md" },
      { statement: "Add a lightweight threat model documenting untrusted odds ingestion", gate: "test -f docs/threat.md" },
      { statement: "Add unit tests covering the arbitrage edge cases", gate: "npm test" },
    ]);
    expect(added.map((r) => r.statement)).toEqual(["render each opportunity's edge size prominently"]);
    expect(skipped).toHaveLength(3); // arch doc, threat model, coverage-only
    expect(spec.requirements).toHaveLength(2);
  });

  it("is a no-op for an empty patch list", () => {
    const spec = parseSpec(baseSpec);
    expect(applyReviewPatches(spec, []).added).toEqual([]);
    expect(spec.requirements).toHaveLength(1);
  });
});

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
