import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SquireError } from "../errors.js";
import { ToolExecutor } from "./tools.js";
import type { AttemptRequest, Engine, EngineEvent, ToolName } from "./types.js";

/**
 * Scripted engine steps. A mock script is a deterministic replay of what an
 * LLM agent "would" do. Tool steps are EXECUTED FOR REAL through the harness
 * ToolExecutor (so reconcile/gates/checkpoint are exercised), but no model is
 * called (SPEC §6.4).
 */
const ToolNameSchema = z.enum(["read", "write", "edit", "bash"]);

const MockStepSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ sleepMs: z.number().int().nonnegative() }).strict(),
  z.object({ tool: ToolNameSchema, args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ usage: z.object({ in: z.number(), out: z.number() }).strict() }).strict(),
  z.object({ done: z.string() }).strict(),
  z.object({ error: z.string() }).strict(),
]);

export const MockScriptSchema = z.object({ steps: z.array(MockStepSchema) }).strict();
export type MockScript = z.infer<typeof MockScriptSchema>;

export type ScriptResolver = (nodeId: string, rung: number) => string | MockScript;

/**
 * Resolve a script from a directory by convention:
 *   <dir>/<nodeId>.rung<N>.json   (rung-specific, optional)
 *   <dir>/<nodeId>.json           (default)
 */
export function fileScriptResolver(dir: string): ScriptResolver {
  return (nodeId, rung) => {
    const rungPath = join(dir, `${nodeId}.rung${rung}.json`);
    if (existsSync(rungPath)) return rungPath;
    const base = join(dir, `${nodeId}.json`);
    if (existsSync(base)) return base;
    throw new SquireError(
      "MOCK_SCRIPT_MISSING",
      `no mock script for node "${nodeId}" (looked for ${rungPath} and ${base})`,
    );
  };
}

export class MockEngine implements Engine {
  private readonly resolveScript: ScriptResolver;

  constructor(opts: { resolveScript: ScriptResolver }) {
    this.resolveScript = opts.resolveScript;
  }

  async *runAttempt(req: AttemptRequest): AsyncIterable<EngineEvent> {
    const script = loadScript(this.resolveScript(req.nodeId, req.rung));
    const exec = new ToolExecutor(req.cwd, req.tools);
    let sawDone = false;
    let lastText = "";
    let toolSeq = 0;

    for (const step of script.steps) {
      if ("text" in step) {
        lastText = step.text;
        yield { kind: "text", text: step.text };
      } else if ("sleepMs" in step) {
        await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      } else if ("usage" in step) {
        yield { kind: "usage", inTokens: step.usage.in, outTokens: step.usage.out };
      } else if ("tool" in step) {
        const id = `${step.tool}-${toolSeq++}`;
        const name = step.tool as ToolName;
        yield { kind: "tool_call", id, name, args: step.args };
        const result = await exec.execute(name, step.args);
        if (result.denied) {
          yield {
            kind: "blast_denied",
            id,
            name,
            path: result.path ?? "",
            reason: result.deniedReason ?? "denied",
          };
        }
        yield { kind: "tool_result", id, ok: result.ok, output: result.output };
      } else if ("done" in step) {
        sawDone = true;
        yield { kind: "done", finalMessage: step.done };
      } else {
        yield { kind: "error", message: step.error };
        return;
      }
    }

    if (!sawDone) {
      yield { kind: "done", finalMessage: lastText };
    }
  }
}

function loadScript(source: string | MockScript): MockScript {
  if (typeof source !== "string") return MockScriptSchema.parse(source);
  if (!existsSync(source)) {
    throw new SquireError("MOCK_SCRIPT_MISSING", `mock script not found: ${source}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    throw new SquireError("MOCK_SCRIPT_PARSE", `invalid mock script ${source}: ${(err as Error).message}`);
  }
  const result = MockScriptSchema.safeParse(parsed);
  if (!result.success) {
    throw new SquireError("MOCK_SCRIPT_INVALID", `invalid mock script ${source}: ${result.error.message}`);
  }
  return result.data;
}
