import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiEngine } from "../../src/engine/pi.js";
import { runMission } from "../../src/harness/runner.js";
import { initRepo } from "../../src/harness/checkpoint.js";
import { parseMission, parseChains } from "../../src/contract/schema.js";

const chains = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
  "deepseek/deepseek-chat": { in: 0.14, out: 0.28 }
  "z-ai/glm-5.2": { in: 0.95, out: 3.00 }
`);

function u(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function scripted(turns: AssistantMessage["content"][]): StreamFn {
  let i = 0;
  return ((..._a: unknown[]) => {
    const content = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    const hasTool = content.some((c) => c.type === "toolCall");
    const msg: AssistantMessage = {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openrouter",
      model: "test/model",
      usage: u(800, 150),
      stopReason: hasTool ? "toolUse" : "stop",
      timestamp: 0,
    };
    const s = createAssistantMessageEventStream();
    s.push({ type: "start", partial: msg });
    s.push({ type: "done", reason: hasTool ? "toolUse" : "stop", message: msg });
    return s;
  }) as unknown as StreamFn;
}

let repo: string;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "squire-pirun-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "target.ts"), "export const v = 0;\n");
  await initRepo(repo);
});

describe("PiEngine through runMission (real engine + real git, no network)", () => {
  it("completes a node when the agent edits in-radius and the gate passes", async () => {
    const mission = parseMission(`
goal: "set v to 1 via the real engine"
budget_usd: 5
chain: cheap
nodes:
  - id: fix
    brief: "edit src/target.ts so v = 1"
    context_globs: ["src/**"]
    blast_radius: ["src/**"]
    done_check: "grep -q 'v = 1' src/target.ts"
    budget_usd: 2
`);
    const engine = new PiEngine({
      streamFn: scripted([
        [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "src/target.ts", content: "export const v = 1;\n" },
          },
        ],
        [
          { type: "toolCall", id: "b1", name: "bash", arguments: { command: "grep -q 'v = 1' src/target.ts" } },
        ],
        [{ type: "text", text: "Edited src/target.ts; ran grep, exit 0." }],
      ]),
    });

    const result = await runMission({
      mission,
      chains,
      engine,
      workdir: repo,
      missionId: "pi-int",
      tracePath: join(repo, ".squire", "trace.jsonl"),
      apiKey: "test-key",
    });

    expect(result.completed).toBe(true);
    expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).toContain("v = 1");
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.nodes[0]!.confabulations).toBe(0);
  });
});
