import { Agent, type AgentTool, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  Type,
  EventStream,
  streamSimple,
  type Model,
  type AssistantMessage,
  type TextContent,
  type ImageContent,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { ToolExecutor } from "./tools.js";
import { renderPackedFiles, estimateTokens } from "../harness/context.js";
import type { AttemptRequest, Engine, EngineEvent, ModelRef, ToolName } from "./types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// A blast-radius denial ALREADY prevents the write (the radius is enforced before the
// filesystem is touched). This ceiling is only a runaway backstop, so it can be generous:
// a worker iterating naturally writes a few scratch/alt-name files (test_crypto.js,
// crypto_new.js, package_fixed.json) — each harmlessly denied — and a 3-strike instakill
// guillotined the very rung that was doing real work. The denial protects the radius; the
// abort just punishes a working worker. Keep a ceiling against a true loop, but high.
const MAX_BLAST_VIOLATIONS = 25;
// These are runaway-loop BACKSTOPS, not work budgets — the cost meter is the real stop.
// They were originally tuned for single-file edits; once the builder was allowed to run
// and iterate (install deps, run the gate, read the error, fix, re-run) a real node needs
// many tool calls and minutes of wall-clock. Calibrated too tight, they abort legitimate
// work — the cheap executor was being guillotined at 45s while the codex path gives a node
// 600s ("generous for a real node"). Give the ordinary worker the same room; let the budget
// meter and honest-halt do the real bounding.
const DEFAULT_MAX_TOOL_CALLS_PER_ATTEMPT = 60;
// A substantial file (an Express server with several routes) legitimately takes many
// write→run→fix passes; 12 guillotined a node mid-build. Identical rewrites are already a free
// no-op (the dup-write nudge), so this only counts DISTINCT versions — a real iterate-to-green
// loop needs the headroom. The tool-call ceiling + cost meter are the real runaway guards.
const DEFAULT_MAX_MUTATIONS_PER_PATH_PER_ATTEMPT = 30;
// Must comfortably exceed BASH_TIMEOUT_MS (120s) — a single `npm install` of native deps
// (sqlite3/bcrypt → node-gyp) can eat that alone — AND leave room to iterate after. Parity
// with CodexEngine's 600s so the cheap path isn't strangled relative to the premium one.
// This is an ABSOLUTE backstop; the idle timeout below is what actually catches stalls.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
// The real stall detector: abort when NOTHING has happened (no tool call, no token) for this
// long. A flat wall-clock cap is the wrong tool — it either guillotines a working attempt
// (the 45s bug) or, raised, makes a genuine stall (a stalled provider stream, a rate-limited
// token) hang for the full 10 min. Capping IDLE time instead lets a PROGRESSING attempt run
// as long as it keeps advancing while catching a stuck line fast. Must exceed BASH_TIMEOUT_MS
// (120s) so a maxed-out single command — which emits no events while it runs — isn't mistaken
// for a stall; the tool_execution_end then bumps it.
const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * Bound the agent loop's conversation history. Every turn re-sends the full
 * transcript; without a cap a confused model that runs many tool calls (or one
 * huge tool output) balloons context, cost, and latency turn over turn. When the
 * transcript exceeds this estimate, drop the OLDEST whole turns (keeping the
 * initial prompt + the most recent turns) so the request stays bounded. This is
 * the in-harness analog of provider-side compaction.
 */
const MAX_HISTORY_TOKENS = 48_000;

/**
 * Keep the first message (the task prompt) plus the most recent whole turns that
 * fit under maxTokens. A "turn" is a user/assistant message plus the toolResult
 * messages that follow it, kept together so no toolCall is orphaned from its
 * result (which providers reject).
 */
export function boundHistory(messages: Message[], maxTokens = MAX_HISTORY_TOKENS): Message[] {
  const est = (m: Message): number => estimateTokens(JSON.stringify(m));
  const total = messages.reduce((s, m) => s + est(m), 0);
  if (total <= maxTokens || messages.length <= 2) return messages;

  // Group into turns: a non-toolResult message starts a turn; toolResults attach.
  const turns: Message[][] = [];
  for (const m of messages) {
    if (m.role === "toolResult" && turns.length > 0) turns[turns.length - 1]!.push(m);
    else turns.push([m]);
  }
  if (turns.length <= 2) return messages;

  const first = turns[0]!;
  let used = first.reduce((s, m) => s + est(m), 0);
  const keptTail: Message[][] = [];
  for (let i = turns.length - 1; i >= 1; i--) {
    const t = turns[i]!;
    const cost = t.reduce((s, m) => s + est(m), 0);
    if (used + cost > maxTokens && keptTail.length > 0) break;
    keptTail.unshift(t);
    used += cost;
  }
  return [...first, ...keptTail.flat()];
}
/**
 * Hard cap on output tokens per LLM call. Without this, providers pre-authorize
 * the model's full max output (e.g. 32k for Opus → ~$2.40), which both wastes
 * the budget pre-check and triggers 402s on low-balance accounts. Coding edits
 * never need this much output.
 */
const OUTPUT_MAX_TOKENS = 8_192;

export interface PiEngineOptions {
  /** Inject a fake stream function for tests (no network). Default: pi-ai streamSimple. */
  streamFn?: StreamFn;
  /** Hard stop for confused agents that keep using tools and never finish. */
  maxToolCallsPerAttempt?: number;
  /** Hard stop for agents repeatedly write/editing one file without finishing. */
  maxMutationsPerPathPerAttempt?: number;
  /** Absolute wall-clock backstop for one agent attempt. */
  attemptTimeoutMs?: number;
  /** Stall detector: abort after this long with no tool call or token (no progress). */
  idleTimeoutMs?: number;
  /** Runaway backstop for an agent that keeps writing outside its radius (each is denied anyway). */
  maxBlastViolations?: number;
}

/**
 * PiEngine — real agent execution via @earendil-works/pi-agent-core.
 *
 * The harness owns the four tool bodies (read/write/edit/bash) and the single
 * ToolExecutor, which enforces blast-radius BEFORE any write. Out-of-radius
 * write/edit calls are denied there and surfaced as blast_denied events; the
 * run continues (SPEC §5.4). Only a runaway loop of denials (the generous
 * MAX_BLAST_VIOLATIONS backstop) aborts the attempt.
 */
export class PiEngine implements Engine {
  private readonly streamFn?: StreamFn;
  private readonly maxToolCallsPerAttempt: number;
  private readonly maxMutationsPerPathPerAttempt: number;
  private readonly attemptTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxBlastViolations: number;

  constructor(opts: PiEngineOptions = {}) {
    this.streamFn = opts.streamFn;
    this.maxToolCallsPerAttempt = opts.maxToolCallsPerAttempt ?? DEFAULT_MAX_TOOL_CALLS_PER_ATTEMPT;
    this.maxMutationsPerPathPerAttempt =
      opts.maxMutationsPerPathPerAttempt ?? DEFAULT_MAX_MUTATIONS_PER_PATH_PER_ATTEMPT;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxBlastViolations = opts.maxBlastViolations ?? MAX_BLAST_VIOLATIONS;
  }

  async *runAttempt(req: AttemptRequest): AsyncIterable<EngineEvent> {
    const model = buildModel(req.model);
    const exec = new ToolExecutor(req.cwd, req.tools);
    const out = new EventStream<EngineEvent, null>(
      () => false,
      () => null,
    );
    const state: {
      denied: number;
      toolCalls: number;
      mutationsByPath: Map<string, number>;
      lastMutationContentByPath: Map<string, string>;
      agent?: Agent;
      aborted: boolean;
      abortReason?: string;
    } = {
      denied: 0,
      toolCalls: 0,
      mutationsByPath: new Map(),
      lastMutationContentByPath: new Map(),
      aborted: false,
    };
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const abortAttempt = (reason: string): void => {
      if (state.aborted) return;
      state.aborted = true;
      state.abortReason = reason;
      resolveAbort?.();
      try {
        state.agent?.abort();
      } catch {
        // The abort promise above is the harness's source of truth; provider
        // abort support is best-effort.
      }
    };
    let finalText = "";
    let providerError: string | undefined;

    // Bound output tokens so providers don't pre-authorize their full max
    // (e.g. Opus's 32k → ~$2.40, which 402s low-balance accounts). Applied
    // even around an injected streamFn so the cap is always enforced.
    const outputCap = outputCapFor(req.maxTokens);
    const base = this.streamFn ?? (streamSimple as StreamFn);
    const streamFn: StreamFn = ((model, context, options) =>
      base(model, context, { ...(options ?? {}), maxTokens: options?.maxTokens ?? outputCap })) as StreamFn;
    const requiredExportsByPath = requiredCommonJsExportsByPath(req.doneCheck ?? "");

    const enforceToolLimit = (): void => {
      state.toolCalls += 1;
      if (state.toolCalls > this.maxToolCallsPerAttempt) {
        const reason = `attempt aborted after ${this.maxToolCallsPerAttempt} tool calls without finishing`;
        abortAttempt(reason);
        throw new Error(reason);
      }
    };

    const recordMutation = (path: string, content?: string): MutationStatus => {
      if (!path) return "ok";
      // Re-writing identical content is a harmless no-op (models do it constantly to "make
      // sure"). It must NOT abort the attempt — the file already holds that content. Signal
      // "duplicate" so the tool nudges the model to move on, and don't count it as progress.
      if (content !== undefined && state.lastMutationContentByPath.get(path) === content) {
        return "duplicate";
      }
      if (content !== undefined) state.lastMutationContentByPath.set(path, content);
      const count = (state.mutationsByPath.get(path) ?? 0) + 1;
      state.mutationsByPath.set(path, count);
      if (count > this.maxMutationsPerPathPerAttempt) {
        const reason = `attempt aborted after ${this.maxMutationsPerPathPerAttempt} write/edit attempts to ${path} without finishing`;
        abortAttempt(reason);
        throw new Error(reason);
      }
      return "ok";
    };

    const tools = makeTools(
      exec,
      enforceToolLimit,
      recordMutation,
      async (path) => {
        const validation = await validateRequiredCommonJsExports(exec, path, requiredExportsByPath.get(path) ?? []);
        if (validation.importError) {
          const reason = `attempt aborted because ${path} cannot be required for gate export validation`;
          abortAttempt(reason);
          throw new Error(reason);
        }
        if (validation.missing.length > 0) {
          const reason = `attempt aborted because ${path} does not export required symbol(s): ${validation.missing.join(", ")}`;
          abortAttempt(reason);
          throw new Error(reason);
        }
      },
      (id, name, path, reason) => {
        state.denied += 1;
        out.push({ kind: "blast_denied", id, name, path, reason });
        if (state.denied >= this.maxBlastViolations) {
          abortAttempt(`attempt aborted after ${this.maxBlastViolations} blast-radius violations`);
        }
      },
    );

    const agent = new Agent({
      initialState: { systemPrompt: req.systemPrompt, model, tools },
      getApiKey: () => req.model.apiKey,
      streamFn,
      // Bound the transcript before each provider request (context/cost guard).
      transformContext: async (messages) => boundHistory(messages as Message[]) as typeof messages,
    });
    state.agent = agent;

    // Reset by run()'s idle timer; every agent event is "progress" and bumps the deadline.
    let bumpIdle: () => void = () => {};

    agent.subscribe((event: AgentEvent) => {
      bumpIdle();
      switch (event.type) {
        case "tool_execution_start":
          out.push({
            kind: "tool_call",
            id: event.toolCallId,
            name: event.toolName as ToolName,
            args: event.args,
          });
          break;
        case "tool_execution_end":
          out.push({
            kind: "tool_result",
            id: event.toolCallId,
            ok: !event.isError,
            output: contentText(event.result?.content),
          });
          break;
        case "turn_end": {
          const m = event.message;
          if (isAssistant(m)) {
            out.push({ kind: "usage", inTokens: m.usage.input, outTokens: m.usage.output });
            if (m.stopReason === "error" || m.stopReason === "aborted") {
              providerError = m.errorMessage || assistantText(m) || `provider ${m.stopReason}`;
            } else {
              const text = assistantText(m);
              if (text) finalText = text;
            }
          }
          break;
        }
        default:
          break;
      }
    });

    const userPrompt =
      req.files.length > 0
        ? `${req.brief}\n\n=== CONTEXT FILES (read-only unless writable) ===\n${renderPackedFiles(req.files)}`
        : req.brief;

    const run = (async () => {
      const timer = setTimeout(() => {
        abortAttempt(`attempt timed out after ${this.attemptTimeoutMs}ms`);
      }, this.attemptTimeoutMs);
      timer.unref?.();
      // Stall detector: a productive attempt bumps this on every event and never trips it;
      // a stalled stream / wedged subprocess trips it fast instead of waiting out the absolute
      // backstop (the "this hangs for 10 minutes" symptom of a flat cap).
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortAttempt(`attempt aborted after ${Math.round(this.idleTimeoutMs / 1000)}s with no progress (stalled — no tool call or token)`);
        }, this.idleTimeoutMs);
        idleTimer.unref?.();
      };
      bumpIdle();
      try {
        const prompt = agent.prompt(userPrompt);
        await Promise.race([prompt, aborted]);
        if (state.aborted) {
          void prompt.catch(() => undefined);
          out.push({ kind: "error", message: state.abortReason ?? "attempt aborted" });
        } else if (providerError) {
          out.push({ kind: "error", message: providerError });
        } else {
          out.push({ kind: "done", finalMessage: finalText || agent.state.errorMessage || "" });
        }
      } catch (err) {
        out.push({ kind: "error", message: (err as Error).message });
      } finally {
        clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        out.end(null);
      }
    })();

    for await (const ev of out) yield ev;
    await run;
  }
}

/** Output-token cap for one call: never more than OUTPUT_MAX_TOKENS, never above the request budget. */
export function outputCapFor(reqMaxTokens: number): number {
  return Math.min(OUTPUT_MAX_TOKENS, Math.max(1, reqMaxTokens));
}

/** Construct a pi-ai Model for an arbitrary slug (placeholder-friendly, via OpenRouter). */
function buildModel(ref: ModelRef): Model<"openai-completions"> {
  return {
    id: ref.slug,
    name: ref.slug,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: ref.baseUrl ?? DEFAULT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    // NOTE: do NOT set openRouterRouting.require_parameters — it demands
    // endpoints support EVERY request param (incl. optional ones pi-ai sends)
    // and 404s models like deepseek-v3.2 entirely. OpenRouter already filters
    // by hard capabilities (tools) in default routing.
  };
}

type DenyHook = (id: string, name: ToolName, path: string, reason: string) => void;
type ToolLimitHook = () => void;
type MutationStatus = "ok" | "duplicate";
type MutationHook = (path: string, content?: string) => MutationStatus;
type ExportValidationHook = (path: string) => Promise<void>;

function makeTools(
  exec: ToolExecutor,
  onToolStart: ToolLimitHook,
  onMutation: MutationHook,
  validateExports: ExportValidationHook,
  onDeny: DenyHook,
): AgentTool<any>[] {
  const text = (s: string): { content: TextContent[]; details: unknown } => ({
    content: [{ type: "text", text: s || "(no output)" }],
    details: null,
  });
  // A write/edit that did NOT persist (failed or refused, e.g. the package.json poka-yoke) must
  // surface as a tool ERROR so it isn't tallied as an executed write — pi-agent-core only flags a
  // result isError when the tool THROWS (a returned isError field is ignored), so we throw. This
  // is a per-tool error (the model sees the message and continues), NOT an attempt abort.
  const failTool = (msg: string): never => {
    throw new Error(msg || "tool failed");
  };

  const read: AgentTool<any> = {
    name: "read",
    label: "Read",
    description: "Read a UTF-8 file's contents, relative to the working directory.",
    parameters: Type.Object({ path: Type.String({ description: "File path relative to workdir" }) }),
    execute: async (_id, params) => {
      onToolStart();
      return text((await exec.execute("read", params)).output);
    },
  };

  const write: AgentTool<any> = {
    name: "write",
    label: "Write",
    description: "Create or overwrite a file. Only paths inside the writable set are allowed.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    execute: async (id, params) => {
      onToolStart();
      const r = await exec.execute("write", params);
      if (r.denied) {
        onDeny(id, "write", r.path ?? readPath(params), r.deniedReason ?? "denied");
        return text(r.output);
      }
      const path = r.path ?? readPath(params);
      const status = onMutation(path, readContent(params)); // count the attempt (runaway guard)
      // A refused/failed write (the package.json poka-yoke) did NOT persist — surface it as an
      // error so reconcile doesn't see a write that "isn't in the diff" and falsely fail the node.
      if (!r.ok) failTool(r.output);
      if (status === "duplicate") {
        return text(`${path} already contains exactly this content — no change needed. Move on to the next step (run the check, or edit a different file).`);
      }
      await validateExports(path);
      return text(r.output);
    },
  };

  const edit: AgentTool<any> = {
    name: "edit",
    label: "Edit",
    description: "Replace a substring in an existing file. Only writable paths are allowed.",
    parameters: Type.Object({
      path: Type.String(),
      oldString: Type.String(),
      newString: Type.String(),
      replaceAll: Type.Optional(Type.Boolean()),
    }),
    execute: async (id, params) => {
      onToolStart();
      const r = await exec.execute("edit", params);
      if (r.denied) {
        onDeny(id, "edit", r.path ?? readPath(params), r.deniedReason ?? "denied");
        return text(r.output);
      }
      const status = onMutation(r.path ?? readPath(params), readEditContent(params)); // count the attempt
      if (!r.ok) failTool(r.output); // failed edit didn't persist — error, not an executed write
      if (status === "duplicate") {
        return text(`${r.path ?? readPath(params)} already reflects this edit — no change needed. Move on to the next step.`);
      }
      return text(r.output);
    },
  };

  const bash: AgentTool<any> = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the working directory (e.g. the check command).",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, params) => {
      onToolStart();
      return text((await exec.execute("bash", params)).output);
    },
  };

  return [read, write, edit, bash];
}

function readPath(params: unknown): string {
  if (typeof params === "object" && params !== null && "path" in params) {
    const p = (params as { path: unknown }).path;
    if (typeof p === "string") return p;
  }
  return "";
}

function readContent(params: unknown): string | undefined {
  if (typeof params === "object" && params !== null && "content" in params) {
    const p = (params as { content: unknown }).content;
    if (typeof p === "string") return p;
  }
  return undefined;
}

function readEditContent(params: unknown): string | undefined {
  if (typeof params === "object" && params !== null && "newString" in params) {
    const p = (params as { newString: unknown }).newString;
    if (typeof p === "string") return p;
  }
  return undefined;
}

function requiredCommonJsExportsByPath(doneCheck: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (path: string, names: string[]): void => {
    const clean = names.filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    if (clean.length) out.set(path, [...new Set([...(out.get(path) ?? []), ...clean])]);
  };

  // 1. destructured: const { create_user, store_api_key } = require('./storage')
  const destructureRe = /const\s*\{\s*([^}]+?)\s*\}\s*=\s*require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
  for (const match of doneCheck.matchAll(destructureRe)) {
    add(match[2]!, match[1]!.split(",").map((s) => s.trim().split(":")[0]!.trim()));
  }

  // 2. member-call: const storage = require('./storage'); … storage.create_user(…)
  //    The gate calls these as functions, so they MUST be exported — catch a wrong-interface
  //    module at write time (an instant nudge) instead of a cryptic "X is not a function" gate
  //    failure 30 tool calls later. (measured: qwen shipped a storage.js missing create_user.)
  const bindRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
  for (const bind of doneCheck.matchAll(bindRe)) {
    const varName = bind[1]!;
    const path = bind[2]!;
    const callRe = new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
    add(path, [...doneCheck.matchAll(callRe)].map((m) => m[1]!));
  }
  return out;
}

async function validateRequiredCommonJsExports(
  exec: ToolExecutor,
  path: string,
  symbols: string[],
): Promise<{ importError: boolean; missing: string[] }> {
  if (symbols.length === 0 || !/\.(?:c?js|mjs)$/.test(path)) return { importError: false, missing: [] };
  const script = [
    "try {",
    `  const m = require(${JSON.stringify("./" + path)});`,
    `  const missing = ${JSON.stringify(symbols)}.filter((s) => m == null || typeof m[s] === "undefined");`,
    "  if (missing.length > 0) { console.log(missing.join(',')); process.exit(2); }",
    "  process.exit(0);",
    "} catch (err) {",
    "  console.log('__IMPORT_ERROR__');",
    "  process.exit(3);",
    "}",
  ].join("\n");
  const r = await exec.execute("bash", { command: `node -e ${shellQuote(script)}` });
  const output = r.output.trim();
  if (r.ok || !output) return { importError: false, missing: [] };
  if (output.includes("__IMPORT_ERROR__")) return { importError: true, missing: [] };
  return { importError: false, missing: output.split(",").map((s) => s.trim()).filter(Boolean) };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isAssistant(m: unknown): m is AssistantMessage {
  return typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant";
}

function assistantText(m: AssistantMessage): string {
  return m.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

function contentText(content: (TextContent | ImageContent)[] | undefined): string {
  if (!content) return "";
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}
