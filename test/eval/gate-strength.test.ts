import { describe, it, expect } from "vitest";
import { checkGateStrength, gateGateStrength, type GateStrengthResult } from "../../src/eval/gate-strength.js";
import { UX_GATE_CASES } from "../../specs/review-set/gate-strength/gate-labels.js";

describe("gate-strength (a UX gate must pass complete AND fail incomplete)", () => {
  it("every shipped UX gate is strong — passes complete, fails incomplete", async () => {
    const results: GateStrengthResult[] = [];
    for (const c of UX_GATE_CASES) results.push(await checkGateStrength(c));
    for (const r of results) {
      expect(r.passesComplete, `${r.tag} should pass complete`).toBe(true);
      expect(r.failsIncomplete, `${r.tag} should fail incomplete`).toBe(true);
    }
    const g = gateGateStrength(results);
    expect(g.passed).toBe(true);
    expect(g.weak).toEqual([]);
    expect(g.total).toBe(UX_GATE_CASES.length);
  }, 30_000);

  it("a structure-presence gate that ignores the defect is NOT strong (the clairvoyance failure)", async () => {
    // The exact weak gate clairvoyance shipped: "an <li> exists" — passes BOTH impls.
    const weak = UX_GATE_CASES[0]!;
    const r = await checkGateStrength({ ...weak, gate: "grep -q '<li' index.html" });
    expect(r.passesComplete).toBe(true);
    expect(r.failsIncomplete).toBe(false); // it also passes the size-less impl — too weak
    expect(r.strong).toBe(false);
    expect(gateGateStrength([r]).passed).toBe(false);
  }, 30_000);
});
