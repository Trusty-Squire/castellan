import type { PackedFile } from "../harness/context.js";

/** The four tools every engine exposes (SPEC §6.1). */
export type ToolName = "read" | "write" | "edit" | "bash";

export interface ModelRef {
  /** Provider slug, e.g. "qwen/qwen3-coder". */
  slug: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ToolPolicy {
  /** Globs (relative to cwd) that write/edit may touch. Empty = nothing writable. */
  blastRadius: string[];
  /** Tool names that are denied entirely. */
  denylist?: ToolName[];
}

export interface AttemptRequest {
  systemPrompt: string;
  brief: string;
  files: PackedFile[];
  cwd: string;
  model: ModelRef;
  tools: ToolPolicy;
  maxTokens: number;
  /** Per-node identifier (for engines that route scripts/logs by node). */
  nodeId: string;
  /** Current escalation rung (1-based). */
  rung: number;
  /** Command gate for this node, used by engines for cheap local sanity checks. */
  doneCheck?: string;
}

export type EngineEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: ToolName; args: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; output: string }
  | { kind: "blast_denied"; id: string; name: ToolName; path: string; reason: string }
  | { kind: "usage"; inTokens: number; outTokens: number }
  | { kind: "done"; finalMessage: string }
  | { kind: "error"; message: string };

export interface Engine {
  runAttempt(req: AttemptRequest): AsyncIterable<EngineEvent>;
}

/** A single executed tool call, recorded by the runner from the event stream. */
export interface ToolCallRecord {
  id: string;
  name: ToolName;
  args: unknown;
  ok: boolean;
  output: string;
  /** For write/edit: the path that was (or would have been) written. */
  path?: string;
  /** For bash: the command string. */
  command?: string;
  denied: boolean;
}

/**
 * Everything the runner accumulates from one attempt's event stream.
 * Consumed by reconcile + budget + the gate decision.
 */
export interface AttemptRecord {
  toolCalls: ToolCallRecord[];
  /** Paths the engine successfully wrote/edited (blast-allowed). */
  executedWrites: string[];
  blastDeniedCount: number;
  inTokens: number;
  outTokens: number;
  finalMessage: string;
  errored: boolean;
  errorMessage?: string;
}
