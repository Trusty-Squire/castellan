import { describe, expect, it } from "vitest";
import { evaluatePlannerFrontDoor, renderPlannerEvalReport } from "../../src/eval/planner.js";

describe("SER planner eval", () => {
  it("passes the deterministic front-door hardening cases", async () => {
    const report = await evaluatePlannerFrontDoor();
    expect(report.targetPassed).toBe(true);
    expect(report.score.validIdeaRate).toBe(1);
    expect(report.score.scopeCreepRate).toBe(0);
    expect(renderPlannerEvalReport(report)).toContain("SER planner eval");
  });
});
