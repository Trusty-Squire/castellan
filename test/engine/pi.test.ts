import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiEngine, outputCapFor, boundHistory } from "../../src/engine/pi.js";
import type { AttemptRequest, EngineEvent } from "../../src/engine/types.js";
import type { Message } from "@earendil-works/pi-ai";

/** Build a full Usage object from input/output token counts. */
function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type TurnSpec =
  | { tools: { id: string; name: string; arguments: Record<string, unknown> }[]; in: number; out: number }
  | { text: string; in: number; out: number };

/** A deterministic, network-free streamFn that replays scripted assistant turns. */
function scriptedStreamFn(turns: TurnSpec[]): StreamFn {
  let i = 0;
  return ((..._args: unknown[]) => {
    const spec = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    const isTools = "tools" in spec;
    const content: AssistantMessage["content"] = isTools
      ? spec.tools.map((t) => ({ type: "toolCall", id: t.id, name: t.name, arguments: t.arguments }))
      : [{ type: "text", text: spec.text }];
    const msg: AssistantMessage = {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openrouter",
      model: "test/model",
      usage: usage(spec.in, spec.out),
      stopReason: isTools ? "toolUse" : "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "done", reason: isTools ? "toolUse" : "stop", message: msg });
    return stream;
  }) as unknown as StreamFn;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "squire-pi-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
});

function req(overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  return {
    systemPrompt: "You are a squire.",
    brief: "do the thing",
    files: [],
    cwd,
    model: { slug: "qwen/qwen3-coder", apiKey: "test-key" },
    tools: { blastRadius: ["src/**"] },
    maxTokens: 4000,
    nodeId: "n1",
    rung: 1,
    ...overrides,
  };
}

async function collect(engine: PiEngine, request: AttemptRequest): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const ev of engine.runAttempt(request)) events.push(ev);
  return events;
}

describe("PiEngine (network-free via injected streamFn)", () => {
  it("executes a write within blast radius and reports usage + done", async () => {
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [{ id: "t1", name: "write", arguments: { path: "src/a.ts", content: "export const a = 1;" } }],
          in: 500,
          out: 100,
        },
        { text: "Wrote src/a.ts.", in: 50, out: 20 },
      ]),
    });
    const events = await collect(engine, req());
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("export const a = 1;");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("usage");
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    const totalIn = events
      .filter((e): e is Extract<EngineEvent, { kind: "usage" }> => e.kind === "usage")
      .reduce((s, e) => s + e.inTokens, 0);
    expect(totalIn).toBe(550);
  });

  it("DENIES an out-of-radius write via the harness, emitting blast_denied", async () => {
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [{ id: "t1", name: "write", arguments: { path: "secrets/key.ts", content: "leak" } }],
          in: 100,
          out: 20,
        },
        { text: "tried", in: 10, out: 5 },
      ]),
    });
    const events = await collect(engine, req());
    expect(existsSync(join(cwd, "secrets", "key.ts"))).toBe(false);
    const denied = events.find((e) => e.kind === "blast_denied");
    expect(denied).toBeDefined();
    expect(denied && "path" in denied && denied.path).toMatch(/secrets\/key\.ts/);
  });

  it("TOLERATES a few out-of-radius writes — denied (not written) but not an abort", async () => {
    // A worker iterating naturally writes scratch/alt-name files; each is denied (write
    // prevented), but that must not guillotine the rung — the radius is already protected.
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [
            { id: "t1", name: "write", arguments: { path: "a/1.ts", content: "x" } },
            { id: "t2", name: "write", arguments: { path: "b/2.ts", content: "x" } },
            { id: "t3", name: "write", arguments: { path: "c/3.ts", content: "x" } },
          ],
          in: 100,
          out: 20,
        },
        { text: "done", in: 10, out: 5 },
      ]),
    });
    const events = await collect(engine, req());
    expect(events.filter((e) => e.kind === "blast_denied").length).toBe(3);
    expect(events.some((e) => e.kind === "error" && /blast-radius/.test(e.message ?? ""))).toBe(false);
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  it("still backstops a true out-of-radius loop at the ceiling", async () => {
    const engine = new PiEngine({
      maxBlastViolations: 3,
      streamFn: scriptedStreamFn([
        {
          tools: [
            { id: "t1", name: "write", arguments: { path: "a/1.ts", content: "x" } },
            { id: "t2", name: "write", arguments: { path: "b/2.ts", content: "x" } },
            { id: "t3", name: "write", arguments: { path: "c/3.ts", content: "x" } },
          ],
          in: 100,
          out: 20,
        },
        { text: "should not reach happily", in: 10, out: 5 },
      ]),
    });
    const events = await collect(engine, req());
    expect(events.some((e) => e.kind === "error" && /3 blast-radius violations/.test(e.message ?? ""))).toBe(true);
  });

  it("aborts an attempt when the provider/agent loop never returns", async () => {
    const hangingStream: StreamFn = (() => createAssistantMessageEventStream()) as unknown as StreamFn;
    const engine = new PiEngine({ streamFn: hangingStream, attemptTimeoutMs: 50 });

    const events = await collect(engine, req());

    expect(events).toContainEqual({ kind: "error", message: "attempt timed out after 50ms" });
  });

  it("aborts a STALLED attempt on the idle timeout, well before the absolute backstop", async () => {
    // A stream that never emits an event = no progress. The idle timer (much shorter than the
    // absolute attempt timeout) must catch it — so a stalled provider doesn't hang for minutes.
    const hangingStream: StreamFn = (() => createAssistantMessageEventStream()) as unknown as StreamFn;
    const engine = new PiEngine({ streamFn: hangingStream, idleTimeoutMs: 40, attemptTimeoutMs: 60_000 });

    const events = await collect(engine, req());

    expect(events.some((e) => e.kind === "error" && /no progress \(stalled/.test(e.message ?? ""))).toBe(true);
  });

  it("aborts an attempt that keeps rewriting the same path", async () => {
    const engine = new PiEngine({
      maxMutationsPerPathPerAttempt: 5,
      streamFn: scriptedStreamFn([
        {
          tools: Array.from({ length: 6 }, (_, i) => ({
            id: `w${i}`,
            name: "write",
            arguments: { path: "src/repeat.ts", content: `export const n = ${i};` },
          })),
          in: 100,
          out: 20,
        },
        { text: "should not finish", in: 10, out: 5 },
      ]),
    });

    const events = await collect(engine, req());

    expect(events).toContainEqual({
      kind: "error",
      message: "attempt aborted after 5 write/edit attempts to src/repeat.ts without finishing",
    });
  });

  it("aborts a noisy attempt after the tool-call ceiling", async () => {
    const engine = new PiEngine({
      maxToolCallsPerAttempt: 12,
      streamFn: scriptedStreamFn([
        {
          tools: Array.from({ length: 13 }, (_, i) => ({
            id: `r${i}`,
            name: "read",
            arguments: { path: "src/missing.ts" },
          })),
          in: 100,
          out: 20,
        },
        { text: "should not finish", in: 10, out: 5 },
      ]),
    });

    const events = await collect(engine, req());

    expect(events).toContainEqual({
      kind: "error",
      message: "attempt aborted after 12 tool calls without finishing",
    });
  });

  it("treats a repeated identical write as a harmless no-op, not an abort", async () => {
    // Models re-emit an identical file constantly to "make sure". The file already holds that
    // content — aborting the whole rung for it guillotines good work (the secure-storage trap).
    // It must be a no-op nudge: the attempt continues and finishes normally.
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [
            { id: "w1", name: "write", arguments: { path: "src/repeat.ts", content: "export const n = 1;" } },
            { id: "w2", name: "write", arguments: { path: "src/repeat.ts", content: "export const n = 1;" } },
            { id: "w3", name: "write", arguments: { path: "src/repeat.ts", content: "export const n = 1;" } },
          ],
          in: 100,
          out: 20,
        },
        { text: "done — file written", in: 10, out: 5 },
      ]),
    });

    const events = await collect(engine, req());

    // No abort for the duplicate.
    expect(events.some((e) => e.kind === "error" && /duplicate/.test(e.message ?? ""))).toBe(false);
    // The redundant writes are nudged, not punished.
    expect(
      events.some((e) => e.kind === "tool_result" && /already contains exactly this content/.test(e.output ?? "")),
    ).toBe(true);
    // And the attempt completes normally.
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  it("NUDGES (not aborts) a JavaScript write that misses gate-required exports — destructured form", async () => {
    // Modules are written incrementally; aborting because it isn't complete YET kills a working
    // build. The write succeeds with an immediate nudge naming the missing export.
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [
            { id: "w1", name: "write", arguments: { path: "src/opportunities.js", content: "module.exports = [];" } },
          ],
          in: 100,
          out: 20,
        },
        { text: "stop", in: 10, out: 5 },
      ]),
    });

    const events = await collect(
      engine,
      req({
        tools: { blastRadius: ["src/**"] },
        doneCheck:
          "node -e \"const{findArbitrage}=require('./src/opportunities.js');process.exit(typeof findArbitrage==='function'?0:1)\"",
      }),
    );

    expect(events.some((e) => e.kind === "error" && /attempt aborted because/.test(e.message ?? ""))).toBe(false);
    expect(events.some((e) => e.kind === "tool_result" && /does not yet export findArbitrage/.test(e.output ?? ""))).toBe(true);
  });

  it("nudges via the MEMBER-CALL gate pattern too (const o = require('./mod'); o.findArbitrage())", async () => {
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [{ id: "w1", name: "write", arguments: { path: "src/opportunities.js", content: "module.exports = {};" } }],
          in: 100,
          out: 20,
        },
        { text: "stop", in: 10, out: 5 },
      ]),
    });
    const events = await collect(
      engine,
      req({
        tools: { blastRadius: ["src/**"] },
        doneCheck: "node -e \"const o=require('./src/opportunities.js'); o.findArbitrage(); process.exit(0)\"",
      }),
    );
    expect(events.some((e) => e.kind === "tool_result" && /does not yet export findArbitrage/.test(e.output ?? ""))).toBe(true);
  });

  it("NUDGES the model to finish a missing required module instead of ending the rung incomplete", async () => {
    // Turn 1 writes only crypto.js and says done — storage.create_user (gate-required) is missing.
    // The completeness nudge must re-prompt; turn 2 writes storage.js; the attempt then completes.
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        { tools: [{ id: "w1", name: "write", arguments: { path: "crypto.js", content: "module.exports={encrypt:()=>'x'}" } }], in: 100, out: 20 },
        { text: "done (crypto only)", in: 10, out: 5 },
        { tools: [{ id: "w2", name: "write", arguments: { path: "storage.js", content: "module.exports={create_user:()=>({})}" } }], in: 100, out: 20 },
        { text: "storage added", in: 10, out: 5 },
      ]),
    });
    const events = await collect(
      engine,
      req({
        tools: { blastRadius: ["**"] },
        doneCheck: "node -e \"const s=require('./storage');const c=require('./crypto');s.create_user();c.encrypt()\"",
      }),
    );
    expect(existsSync(join(cwd, "storage.js"))).toBe(true); // written on the nudge
    expect(events.some((e) => e.kind === "done")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("does NOT count a refused write (invalid package.json) as executed — tool_result is an error", async () => {
    // The poka-yoke refuses invalid JSON; the failed write must surface as an error result so the
    // runner doesn't tally it as an executed write (which would falsely fail reconcile).
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [{ id: "w1", name: "write", arguments: { path: "package.json", content: "{ bad json, }" } }],
          in: 100,
          out: 20,
        },
        { text: "tried", in: 10, out: 5 },
      ]),
    });
    const events = await collect(engine, req({ tools: { blastRadius: ["**"] } }));
    const result = events.find((e) => e.kind === "tool_result");
    expect(result && "ok" in result && result.ok).toBe(false);
    expect(result && "output" in result && /not valid JSON/.test(result.output ?? "")).toBe(true);
  });

  it("nudges (not aborts) a malformed JavaScript write when the gate requires CommonJS exports", async () => {
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        {
          tools: [
            {
              id: "w1",
              name: "write",
              arguments: { path: "src/opportunities.js", content: "{'broken': \"module.exports = { findArbitrage };\"}" },
            },
          ],
          in: 100,
          out: 20,
        },
        { text: "stop", in: 10, out: 5 },
      ]),
    });

    const events = await collect(
      engine,
      req({
        tools: { blastRadius: ["src/**"] },
        doneCheck:
          "node -e \"const{findArbitrage}=require('./src/opportunities.js');process.exit(typeof findArbitrage==='function'?0:1)\"",
      }),
    );

    expect(events.some((e) => e.kind === "error" && /attempt aborted/.test(e.message ?? ""))).toBe(false);
    expect(events.some((e) => e.kind === "tool_result" && /cannot be loaded yet/.test(e.output ?? ""))).toBe(true);
  });

  it("aborts an attempt that keeps failing edits on the same path", async () => {
    writeFileSync(join(cwd, "src", "repeat.ts"), "export const n = 0;");
    const engine = new PiEngine({
      maxMutationsPerPathPerAttempt: 5,
      streamFn: scriptedStreamFn([
        {
          tools: Array.from({ length: 6 }, (_, i) => ({
            id: `e${i}`,
            name: "edit",
            arguments: {
              path: "src/repeat.ts",
              oldString: `missing ${i}`,
              newString: `export const n = ${i};`,
            },
          })),
          in: 100,
          out: 20,
        },
        { text: "should not finish", in: 10, out: 5 },
      ]),
    });

    const events = await collect(engine, req());

    expect(events).toContainEqual({
      kind: "error",
      message: "attempt aborted after 5 write/edit attempts to src/repeat.ts without finishing",
    });
  });

  it("bounds output max_tokens on every call (avoids provider over-pre-authorization)", async () => {
    const seen: (number | undefined)[] = [];
    const recordingStream: StreamFn = ((model: unknown, context: unknown, options: { maxTokens?: number }) => {
      seen.push(options?.maxTokens);
      const msg = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        api: "openai-completions",
        provider: "openrouter",
        model: "test/model",
        usage: usage(10, 5),
        stopReason: "stop" as const,
        timestamp: 0,
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg });
      return stream;
    }) as unknown as StreamFn;

    const engine = new PiEngine({ streamFn: recordingStream });
    await collect(engine, req({ maxTokens: 40_000 }));
    expect(seen.length).toBeGreaterThan(0);
    // 40k requested context budget must be capped to the 8192 output ceiling.
    expect(seen.every((m) => m === 8192)).toBe(true);
    expect(outputCapFor(40_000)).toBe(8192);
    expect(outputCapFor(100)).toBe(100);
  });

  it("keeps the agent message history bounded across many turns", async () => {
    // 24 tool-call turns then a final text turn. Each tool result is a big bash
    // dump (clamped to ~12KB by the executor). Without history bounding, the
    // transcript would grow well past the cap turn over turn.
    const turns: TurnSpec[] = [];
    for (let i = 0; i < 24; i++) {
      turns.push({
        tools: [{ id: `b${i}`, name: "bash", arguments: { command: "for n in $(seq 1 2000); do echo xxxxxxxxxxxxxxxxxxxx; done" } }],
        in: 100,
        out: 30,
      });
    }
    turns.push({ text: "done exploring", in: 10, out: 5 });

    // Capture the transcript size handed to the provider on each turn.
    const contextTokens: number[] = [];
    const inner = scriptedStreamFn(turns);
    const capturing: StreamFn = ((model: unknown, context: { messages: unknown[] }, options: unknown) => {
      contextTokens.push(Math.ceil(JSON.stringify(context.messages).length / 4));
      return (inner as unknown as (...a: unknown[]) => unknown)(model, context, options);
    }) as unknown as StreamFn;

    const engine = new PiEngine({ streamFn: capturing, maxToolCallsPerAttempt: 64 });
    await collect(engine, req({ maxTokens: 4000 }));

    expect(contextTokens.length).toBeGreaterThanOrEqual(20);
    const maxTokens = Math.max(...contextTokens);
    // Bounded well under what 24 unclamped/unpruned ~3K-token turns would reach (~72K+).
    expect(maxTokens).toBeLessThan(60_000);
    // And it plateaus: the last turn is not dramatically larger than the mid-run size.
    expect(contextTokens.at(-1)!).toBeLessThan(60_000);
  });

  it("runs bash and reads files", async () => {
    writeFileSync(join(cwd, "src", "x.ts"), "hello world");
    const engine = new PiEngine({
      streamFn: scriptedStreamFn([
        { tools: [{ id: "r1", name: "read", arguments: { path: "src/x.ts" } }], in: 30, out: 10 },
        { tools: [{ id: "b1", name: "bash", arguments: { command: "echo ran" } }], in: 30, out: 10 },
        { text: "done", in: 10, out: 5 },
      ]),
    });
    const events = await collect(engine, req());
    const results = events.filter(
      (e): e is Extract<EngineEvent, { kind: "tool_result" }> => e.kind === "tool_result",
    );
    expect(results.some((r) => r.output.includes("hello world"))).toBe(true);
    expect(results.some((r) => r.output.includes("ran"))).toBe(true);
  });
});

describe("boundHistory", () => {
  const userMsg = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
  const asstMsg = (text: string): Message => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "m",
    usage: usage(0, 0),
    stopReason: "stop",
    timestamp: 0,
  });
  const toolRes = (text: string): Message => ({
    role: "toolResult",
    toolCallId: "t",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  });

  it("returns the transcript unchanged when under the cap", () => {
    const msgs = [userMsg("task"), asstMsg("ok"), toolRes("result")];
    expect(boundHistory(msgs, 50_000)).toEqual(msgs);
  });

  it("keeps the first prompt + most recent turns, dropping the oldest, under the cap", () => {
    const big = "x".repeat(8_000); // ~2k tokens each
    const msgs: Message[] = [userMsg("THE-TASK")];
    for (let i = 0; i < 20; i++) {
      msgs.push(asstMsg(`turn ${i} ${big}`));
      msgs.push(toolRes(`out ${i} ${big}`));
    }
    const cap = 20_000;
    const out = boundHistory(msgs, cap);

    // first prompt preserved
    expect(out[0]).toEqual(userMsg("THE-TASK"));
    // pruned (fewer messages than the original 41)
    expect(out.length).toBeLessThan(msgs.length);
    // total estimate stays near the cap (allow one trailing turn of overshoot)
    const est = Math.ceil(JSON.stringify(out).length / 4);
    expect(est).toBeLessThan(cap * 1.6);
    // the MOST RECENT turn survived (turn 19), the oldest (turn 0) was dropped
    expect(JSON.stringify(out)).toContain("turn 19");
    expect(JSON.stringify(out)).not.toContain("turn 0 ");
    // no orphaned toolResult: every toolResult is preceded by a non-toolResult
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.role === "toolResult") expect(i > 0 && out[i - 1]!.role !== "user").toBe(true);
    }
  });
});
