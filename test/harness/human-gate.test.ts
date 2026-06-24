import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMission } from "../../src/harness/runner.js";
import { MockEngine } from "../../src/engine/mock.js";
import { initRepo } from "../../src/harness/checkpoint.js";
import { parseMission, parseChains } from "../../src/contract/schema.js";
import { readTrace } from "../../src/harness/trace.js";
import type { Engine, EngineEvent, AttemptRequest } from "../../src/engine/types.js";
import { SquireError } from "../../src/errors.js";

const chains = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
`);

// SPEC-v0.2 success gate #5: a mission with a tier-4 node — pauses, records a
// verdict + reason in the trace, rejection drives a rung-2 retry whose FAILURE
// CONTEXT contains the reason. Exit 0 end-to-end.
const humanMission = `
goal: "produce a render a human signs off on"
budget_usd: 5
chain: cheap
nodes:
  - id: render
    brief: "write renders/chicken.txt and ask for sign-off"
    blast_radius: ["renders/**"]
    gate: { type: human, artifact: "renders/chicken.txt" }
    budget_usd: 1
`;

let repo: string;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "squire-human-"));
  mkdirSync(join(repo, "renders"), { recursive: true });
  writeFileSync(join(repo, "renders", ".gitkeep"), "");
  await initRepo(repo);
});

const writeArtifact = new MockEngine({
  resolveScript: () => ({
    steps: [
      { tool: "write", args: { path: "renders/chicken.txt", content: "a chicken\n" } },
      { done: "rendered the chicken to renders/chicken.txt" },
    ],
  }),
});

function run(engine: Engine, adjudicate: Parameters<typeof runMission>[0]["adjudicate"]) {
  return runMission({
    mission: parseMission(humanMission),
    chains,
    engine,
    workdir: repo,
    missionId: "human-gate",
    tracePath: join(repo, ".squire", "trace.jsonl"),
    adjudicate,
  });
}

describe("tier-4 human gates (SPEC-v0.2 §4, success gate #5)", () => {
  it("approval commits the node and records the verdict in the trace", async () => {
    const result = await run(writeArtifact, async ({ nodeId, artifact }) => {
      expect(nodeId).toBe("render");
      expect(artifact).toBe("renders/chicken.txt");
      return { approved: true, reason: "looks alive", by: "tester" };
    });
    expect(result.completed).toBe(true);
    const gateEv = readTrace(result.tracePath).find((e) => e.kind === "gate")!;
    const p = gateEv.payload as { gateType: string; verdict: { approved: boolean; reason: string; by: string } };
    expect(p.gateType).toBe("human");
    expect(p.verdict).toEqual({ approved: true, reason: "looks alive", by: "tester" });
  });

  it("rejection drives a rung-2 retry whose FAILURE CONTEXT carries the reason", async () => {
    const briefs: string[] = [];
    const capturing: Engine = {
      async *runAttempt(req: AttemptRequest): AsyncIterable<EngineEvent> {
        briefs.push(req.brief);
        yield* writeArtifact.runAttempt(req);
      },
    };
    let calls = 0;
    const result = await run(capturing, async () => {
      calls += 1;
      return calls === 1
        ? { approved: false, reason: "feathers read as plastic", by: "tester" }
        : { approved: true, reason: "fixed", by: "tester" };
    });
    expect(result.completed).toBe(true);
    expect(result.nodes[0]!.maxRung).toBe(2);
    // rung-2 brief contains the structured failure context with the human reason
    expect(briefs[1]).toContain("FAILURE CONTEXT");
    expect(briefs[1]).toContain("feathers read as plastic");
  });

  it("unattended context (no adjudicator) fails LOUDLY, never silently", async () => {
    await expect(run(writeArtifact, undefined)).rejects.toThrow(SquireError);
    await expect(run(writeArtifact, undefined)).rejects.toThrow(/HUMAN_GATE_UNATTENDED|no adjudicator/);
  });

  it("judge gates are soft: never fail the node, always leave a judge_flag", async () => {
    const judgeMission = humanMission.replace(
      'gate: { type: human, artifact: "renders/chicken.txt" }',
      'gate: { type: judge, soft: true, judge: { model: "pinned/model", rubric: "is it alive?" } }',
    );
    const result = await runMission({
      mission: parseMission(judgeMission),
      chains,
      engine: writeArtifact,
      workdir: repo,
      missionId: "judge-gate",
      tracePath: join(repo, ".squire", "trace.jsonl"),
    });
    expect(result.completed).toBe(true);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("judge_flag");
  });
});
