import { describe, it, expect } from "vitest";
import { synthesizeSpec } from "../../src/contract/synthesize.js";
import { parseSpec } from "../../src/contract/spec.js";
import { MockLlm } from "../../src/llm/mock.js";

const elicited = parseSpec(`
thesis: "a habit tracker"
requirements:
  - id: R1
    statement: "log habits"
    acceptance: { tier: 4, artifact: "review.md" }
decisions:
  - id: D1
    statement: "iPhone only"
    rationale: "the user said so"
`);

describe("synthesizeSpec", () => {
  it("replaces draft requirements with objective-gated ones and preserves user decisions", async () => {
    const llm = new MockLlm([
      {
        text: JSON.stringify({
          thesis: "a lean iOS habit tracker",
          requirements: [
            { statement: "toggle a habit done for today", gate: "swift test --filter ToggleTests" },
            { statement: "data survives relaunch", gate: "xcrun simctl ... && diff before after" },
          ],
          decisions: [{ statement: "two fixed habits, no custom (MVP scope)" }],
        }),
      },
    ]);
    const out = await synthesizeSpec(elicited, llm, "m");
    // objective gates now (tier 1), not the tier-4 draft
    expect(out.requirements).toHaveLength(2);
    expect(out.requirements.every((r) => r.acceptance.tier === 1)).toBe(true);
    // the user's elicited decision is preserved, plus the synthesized scope cut
    const decisions = out.decisions.map((d) => d.statement);
    expect(decisions).toContain("iPhone only");
    expect(decisions.some((s) => /two fixed habits/.test(s))).toBe(true);
  });

  it("returns the input unchanged when the model yields no requirements", async () => {
    const llm = new MockLlm([{ text: JSON.stringify({ requirements: [] }) }]);
    const out = await synthesizeSpec(elicited, llm, "m");
    expect(out).toEqual(elicited);
  });
});
