import { describe, it, expect } from "vitest";
import { derivePlan, HERALD_SYSTEM_PROMPT, detectCheckCommands } from "../../src/contract/derive.js";
import { MockLlm } from "../../src/llm/mock.js";
import { SquireError } from "../../src/errors.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const goodPlan = JSON.stringify({
  nodes: [
    {
      id: "impl",
      brief: "Implement the function in src/sum.ts so the suite passes.",
      deps: [],
      context_globs: ["src/**", "test/**"],
      blast_radius: ["src/**"],
      done_check: "npm test",
      budget_usd: 0.5,
    },
  ],
});

function base(llm: MockLlm) {
  return {
    goal: "make the sum test pass",
    budgetUsd: 2.5,
    chainName: "cheap",
    workdir: ".",
    repoSurvey: "FILES (1):\nsrc/sum.ts",
    llm,
    knightModel: "z-ai/glm-5.2",
  };
}

describe("derivePlan", () => {
  it("uses the verbatim Herald system prompt and json mode", async () => {
    const llm = new MockLlm([{ text: goodPlan }]);
    await derivePlan(base(llm));
    expect(llm.calls[0]!.system).toBe(HERALD_SYSTEM_PROMPT);
    expect(llm.calls[0]!.json).toBe(true);
    expect(llm.calls[0]!.model).toBe("z-ai/glm-5.2");
  });

  it("produces a valid mission from a good plan", async () => {
    const llm = new MockLlm([{ text: goodPlan }]);
    const { mission } = await derivePlan(base(llm));
    expect(mission.goal).toBe("make the sum test pass");
    expect(mission.nodes).toHaveLength(1);
    expect(mission.nodes[0]!.done_check).toBe("npm test");
    expect(mission.chain).toBe("cheap");
  });

  it("retries ONCE with the validation errors appended, then succeeds", async () => {
    const badPlan = JSON.stringify({ nodes: [{ id: "x", brief: "no done_check here" }] });
    const llm = new MockLlm([{ text: badPlan }, { text: goodPlan }]);
    const { mission } = await derivePlan(base(llm));
    expect(mission.nodes).toHaveLength(1);
    expect(llm.calls).toHaveLength(2);
    // the retry prompt must carry the rejection feedback
    expect(llm.calls[1]!.user).toMatch(/previous attempt was rejected/i);
  });

  it("throws after a second invalid response (no silent fallback)", async () => {
    const bad = JSON.stringify({ nodes: [{ id: "x" }] });
    const llm = new MockLlm([{ text: bad }, { text: bad }]);
    await expect(derivePlan(base(llm))).rejects.toThrow(SquireError);
    await expect(derivePlan(base(new MockLlm([{ text: bad }, { text: bad }])))).rejects.toThrow(
      /invalid mission after one retry/,
    );
  });

  it('treats a {"error": ...} response as a terminal refusal (no retry)', async () => {
    const llm = new MockLlm([{ text: JSON.stringify({ error: "goal is not objectively checkable" }) }]);
    await expect(derivePlan(base(llm))).rejects.toThrow(/planner refused/);
    expect(llm.calls).toHaveLength(1);
  });

  it("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + goodPlan + "\n```";
    const llm = new MockLlm([{ text: fenced }]);
    const { mission } = await derivePlan(base(llm));
    expect(mission.nodes).toHaveLength(1);
  });
});

describe("detectCheckCommands", () => {
  it("reads scripts from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "squire-derive-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc", deploy: "x" } }),
    );
    const cmds = detectCheckCommands(dir);
    expect(cmds).toContain("npm run test");
    expect(cmds).toContain("npm run build");
    expect(cmds).not.toContain("npm run deploy");
  });
});
