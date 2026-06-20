import { describe, it, expect } from "vitest";
import {
  parseMission,
  effectiveGate,
  parseChains,
  resolveChain,
  topoSort,
  type MissionNode,
} from "../../src/contract/schema.js";
import { SquireError } from "../../src/errors.js";

const validMission = `
goal: "make it green"
budget_usd: 2.5
chain: cheap
workdir: "."
nodes:
  - id: a
    brief: "do a"
    blast_radius: ["src/a/**"]
    done_check: "pnpm test"
    budget_usd: 0.5
  - id: b
    brief: "do b"
    deps: [a]
    context_globs: ["src/a/**"]
    blast_radius: ["src/b/**"]
    done_check: "pnpm test b"
    budget_usd: 0.5
`;

describe("parseMission", () => {
  it("parses a valid mission and applies defaults", () => {
    const m = parseMission(validMission);
    expect(m.nodes).toHaveLength(2);
    const a = m.nodes[0]!;
    expect(a.deps).toEqual([]);
    expect(a.context_globs).toEqual([]);
    expect(a.max_context_tokens).toBe(40_000);
  });

  it("rejects an unknown dependency", () => {
    const bad = validMission.replace("deps: [a]", "deps: [ghost]");
    expect(() => parseMission(bad)).toThrow(SquireError);
    expect(() => parseMission(bad)).toThrow(/unknown node "ghost"/);
  });

  it("rejects duplicate node ids", () => {
    const bad = validMission.replace("id: b", "id: a");
    expect(() => parseMission(bad)).toThrow(/duplicate node id: a/);
  });

  it("rejects a dependency cycle", () => {
    const cyclic = `
goal: "loop"
budget_usd: 1
chain: cheap
nodes:
  - id: a
    brief: "a"
    deps: [b]
    blast_radius: ["**"]
    done_check: "true"
    budget_usd: 0.5
  - id: b
    brief: "b"
    deps: [a]
    blast_radius: ["**"]
    done_check: "true"
    budget_usd: 0.5
`;
    expect(() => parseMission(cyclic)).toThrow(/cycle/);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const bad = validMission + "\nsurprise: true\n";
    expect(() => parseMission(bad)).toThrow(SquireError);
  });
});

describe("parseChains / resolveChain", () => {
  const chainsYaml = `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "anthropic/claude-opus-4"
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
`;

  it("parses chains + prices", () => {
    const c = parseChains(chainsYaml);
    expect(resolveChain(c, "cheap").executor).toBe("qwen/qwen3-coder");
    expect(c.prices["qwen/qwen3-coder"]).toEqual({ in: 0.2, out: 0.8 });
  });

  it("throws on an unknown chain name", () => {
    const c = parseChains(chainsYaml);
    expect(() => resolveChain(c, "nope")).toThrow(/not found/);
  });

  it("back-compat: a chain WITHOUT node_context_budget still parses (defaults 40000)", () => {
    const c = parseChains(chainsYaml); // chainsYaml omits the field
    expect(resolveChain(c, "cheap").node_context_budget).toBe(40000);
  });

  it("honours an explicit node_context_budget (the calibrated executor envelope)", () => {
    const c = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "anthropic/claude-opus-4"
    node_context_budget: 18000
`);
    expect(resolveChain(c, "cheap").node_context_budget).toBe(18000);
  });
});

describe("topoSort", () => {
  it("orders dependencies before dependents, stable otherwise", () => {
    const m = parseMission(validMission);
    const order = topoSort(m.nodes).map((n: MissionNode) => n.id);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });
});

describe("gate schema v2 (SPEC-v0.2 §4)", () => {
  const base = `
goal: "gate forms"
budget_usd: 1
chain: cheap
nodes:
  - id: a
    brief: "a"
    blast_radius: ["src/**"]
    budget_usd: 0.5
`;

  it("accepts the v0.1 done_check form unchanged (back-compat)", () => {
    const m = parseMission(base.replace('budget_usd: 0.5', 'budget_usd: 0.5\n    done_check: "pnpm test"'));
    const g = effectiveGate(m.nodes[0]!);
    expect(g).toEqual({ type: "command", run: "pnpm test", soft: false });
  });

  it("accepts a v2 command gate and resolves it identically", () => {
    const m = parseMission(
      base.replace(
        "budget_usd: 0.5",
        'budget_usd: 0.5\n    gate: { type: command, run: "pnpm test" }',
      ),
    );
    expect(effectiveGate(m.nodes[0]!).run).toBe("pnpm test");
  });

  it("rejects a node with BOTH done_check and gate, and with NEITHER", () => {
    expect(() =>
      parseMission(
        base.replace(
          "budget_usd: 0.5",
          'budget_usd: 0.5\n    done_check: "x"\n    gate: { type: command, run: "y" }',
        ),
      ),
    ).toThrow(/exactly one/);
    expect(() => parseMission(base)).toThrow(/exactly one/);
  });

  it("human gates require an artifact", () => {
    expect(() =>
      parseMission(base.replace("budget_usd: 0.5", "budget_usd: 0.5\n    gate: { type: human }")),
    ).toThrow(/artifact/);
    const m = parseMission(
      base.replace(
        "budget_usd: 0.5",
        'budget_usd: 0.5\n    gate: { type: human, artifact: "renders/grid.png" }',
      ),
    );
    expect(effectiveGate(m.nodes[0]!).type).toBe("human");
  });

  it("judge gates must be soft and carry a pinned judge config (v0.2)", () => {
    expect(() =>
      parseMission(
        base.replace(
          "budget_usd: 0.5",
          'budget_usd: 0.5\n    gate: { type: judge, soft: false, judge: { model: "m", rubric: "r" } }',
        ),
      ),
    ).toThrow(/soft/);
    const m = parseMission(
      base.replace(
        "budget_usd: 0.5",
        'budget_usd: 0.5\n    gate: { type: judge, soft: true, judge: { model: "m", rubric: "r" } }',
      ),
    );
    expect(m.nodes[0]!.gate!.judge!.votes).toBe(3); // default
  });

  it("enforces max_human_checks across the mission", () => {
    const two = `
goal: "too many humans"
budget_usd: 1
chain: cheap
max_human_checks: 1
nodes:
  - id: a
    brief: "a"
    blast_radius: ["src/**"]
    gate: { type: human, artifact: "a.png" }
    budget_usd: 0.5
  - id: b
    brief: "b"
    blast_radius: ["src/**"]
    gate: { type: human, artifact: "b.png" }
    budget_usd: 0.5
`;
    expect(() => parseMission(two)).toThrow(/max_human_checks/);
    expect(parseMission(two.replace("max_human_checks: 1", "max_human_checks: 2")).nodes).toHaveLength(2);
  });
});
