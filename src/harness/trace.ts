import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { SquireError } from "../errors.js";

/** Every event kind the harness emits (SPEC §10). */
export const TRACE_KINDS = [
  "mission_start",
  "node_start",
  "pack",
  "tool_call",
  "tool_result",
  "blast_denied",
  "usage",
  "reconcile",
  "confabulation_flag",
  "gate",
  "judge_flag",
  "checkpoint",
  "reset",
  "repair",
  "escalate",
  "dispute_review",
  "retrospect",
  "budget_stop",
  "engine_error",
  "provider_retry",
  "audit_finding",
  "visual_finding",
  "node_pass",
  "node_fail",
  "mission_end",
] as const;

export type TraceKind = (typeof TRACE_KINDS)[number];

export const TraceEventSchema = z.object({
  ts: z.number(),
  missionId: z.string(),
  nodeId: z.string().optional(),
  attempt: z.number().optional(),
  rung: z.number().optional(),
  kind: z.enum(TRACE_KINDS),
  payload: z.unknown(),
  costUsdSoFar: z.number(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export interface TraceAppendFields {
  nodeId?: string;
  attempt?: number;
  rung?: number;
  payload?: unknown;
  costUsdSoFar?: number;
}

/**
 * Append-only JSONL trace at .squire/trace-<missionId>.jsonl.
 * Writes are synchronous so a crash mid-mission still leaves a readable log.
 */
export class Trace {
  readonly path: string;
  readonly missionId: string;
  private readonly now: () => number;

  constructor(path: string, missionId: string, opts: { now?: () => number } = {}) {
    this.path = path;
    this.missionId = missionId;
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(kind: TraceKind, fields: TraceAppendFields = {}): TraceEvent {
    const event: TraceEvent = {
      ts: this.now(),
      missionId: this.missionId,
      nodeId: fields.nodeId,
      attempt: fields.attempt,
      rung: fields.rung,
      kind,
      payload: fields.payload ?? null,
      costUsdSoFar: fields.costUsdSoFar ?? 0,
    };
    appendFileSync(this.path, JSON.stringify(event) + "\n");
    return event;
  }
}

/** Read + validate a trace file into events. */
export function readTrace(path: string): TraceEvent[] {
  if (!existsSync(path)) {
    throw new SquireError("TRACE_NOT_FOUND", `trace file not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const events: TraceEvent[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SquireError("TRACE_PARSE", `trace line ${i + 1} is not valid JSON`);
    }
    events.push(TraceEventSchema.parse(parsed));
  }
  return events;
}

/** Append an out-of-runner event, preserving mission id and current cost from an existing trace. */
export function appendTraceEvent(path: string, kind: TraceKind, payload: unknown, fields: Omit<TraceAppendFields, "payload" | "costUsdSoFar"> = {}): TraceEvent {
  const events = readTrace(path);
  if (events.length === 0) throw new SquireError("TRACE_EMPTY", `trace file is empty: ${path}`);
  const last = events[events.length - 1]!;
  return new Trace(path, last.missionId).append(kind, {
    ...fields,
    payload,
    costUsdSoFar: last.costUsdSoFar,
  });
}

interface NodeSummary {
  nodeId: string;
  attempts: number;
  maxRung: number;
  passed: boolean;
  failed: boolean;
  blastDenied: number;
  confabulations: number;
  gateExit?: number;
  costUsd: number;
  /** Rung at which the node passed (set on node_pass). >1 means the ladder recovered it. */
  passRung?: number;
}

/** Aggregate per-node stats from a trace event list. */
export function summarize(events: TraceEvent[]): {
  nodes: NodeSummary[];
  totalCostUsd: number;
  completed: boolean;
  missionId: string;
} {
  const order: string[] = [];
  const byNode = new Map<string, NodeSummary>();
  const ensure = (nodeId: string): NodeSummary => {
    let s = byNode.get(nodeId);
    if (!s) {
      s = {
        nodeId,
        attempts: 0,
        maxRung: 0,
        passed: false,
        failed: false,
        blastDenied: 0,
        confabulations: 0,
        costUsd: 0,
      };
      byNode.set(nodeId, s);
      order.push(nodeId);
    }
    return s;
  };

  let totalCostUsd = 0;
  let completed = false;
  let missionId = "";

  for (const ev of events) {
    missionId = ev.missionId;
    totalCostUsd = Math.max(totalCostUsd, ev.costUsdSoFar);
    if (!ev.nodeId) {
      if (ev.kind === "mission_end") {
        completed = isMissionCompleted(ev.payload);
      }
      continue;
    }
    // Synthetic run-phase nodes (e.g. raw mode's "(raw)") are wrapped in
    // parens — real node ids never are — and are not scored rows.
    if (/^\(.*\)$/.test(ev.nodeId)) continue;
    const s = ensure(ev.nodeId);
    s.costUsd = Math.max(s.costUsd, ev.costUsdSoFar);
    if (typeof ev.rung === "number") s.maxRung = Math.max(s.maxRung, ev.rung);
    switch (ev.kind) {
      case "node_start":
        s.attempts = Math.max(s.attempts, ev.attempt ?? 1);
        break;
      case "blast_denied":
        s.blastDenied += 1;
        break;
      case "confabulation_flag":
        s.confabulations += 1;
        break;
      case "gate": {
        const exit = readNumber(ev.payload, "exitCode");
        if (exit !== undefined) s.gateExit = exit;
        break;
      }
      case "node_pass":
        s.passed = true;
        s.passRung = ev.rung ?? 1;
        break;
      case "node_fail":
        s.failed = true;
        break;
      default:
        break;
    }
  }

  return { nodes: order.map((id) => byNode.get(id)!), totalCostUsd, completed, missionId };
}

/** Plain-text per-node table + totals for `ser trace`. Keep it boring (SPEC §10). */
export function summarizeTrace(path: string): string {
  const events = readTrace(path);
  const { nodes, totalCostUsd, completed, missionId } = summarize(events);
  const lines: string[] = [];
  lines.push(`mission ${missionId}  —  ${completed ? "COMPLETED" : "HALTED"}`);
  lines.push("");
  const header = padRow(["node", "result", "att", "rung", "gate", "deny", "confab", "cost$"]);
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const n of nodes) {
    lines.push(
      padRow([
        n.nodeId,
        n.passed ? "pass" : n.failed ? "fail" : "-",
        String(n.attempts || 1),
        String(n.maxRung || 1),
        n.gateExit === undefined ? "-" : String(n.gateExit),
        String(n.blastDenied),
        String(n.confabulations),
        n.costUsd.toFixed(4),
      ]),
    );
  }
  lines.push("-".repeat(header.length));
  const passed = nodes.filter((n) => n.passed).length;
  lines.push(`totals: ${passed}/${nodes.length} nodes passed, $${totalCostUsd.toFixed(4)}`);
  return lines.join("\n");
}

export interface TraceStatus {
  tracePath: string;
  missionId: string;
  completed: boolean;
  passedNodes: number;
  totalNodes: number;
  totalCostUsd: number;
  lastKind: TraceKind;
  lastNodeId?: string;
  lastRung?: number;
  haltedReason?: string;
  ended: boolean;
  openFailures: string[];
}

export function latestTracePath(dir = process.cwd()): string | undefined {
  const squireDir = resolve(dir, ".squire");
  if (!existsSync(squireDir)) return undefined;
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of readdirSync(squireDir)) {
    if (!/^trace-.*\.jsonl$/.test(name)) continue;
    const path = join(squireDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path;
}

export function traceStatus(path: string): TraceStatus {
  const events = readTrace(path);
  if (events.length === 0) throw new SquireError("TRACE_EMPTY", `trace file is empty: ${path}`);
  const summary = summarize(events);
  const last = events[events.length - 1]!;
  const failed = new Set<string>();
  const passed = new Set<string>();
  let haltedReason: string | undefined;
  let ended = false;

  for (const ev of events) {
    if (ev.nodeId && !/^\(.*\)$/.test(ev.nodeId)) {
      if (ev.kind === "node_fail") failed.add(ev.nodeId);
      if (ev.kind === "node_pass") {
        passed.add(ev.nodeId);
        failed.delete(ev.nodeId);
      }
    }
    if (ev.kind === "mission_end") {
      ended = true;
      if (!isMissionCompleted(ev.payload)) {
        haltedReason = readString(ev.payload, "haltReason") ?? readString(ev.payload, "reason");
      }
    }
  }

  return {
    tracePath: path,
    missionId: summary.missionId,
    completed: summary.completed,
    passedNodes: summary.nodes.filter((n) => n.passed).length,
    totalNodes: summary.nodes.length,
    totalCostUsd: summary.totalCostUsd,
    lastKind: last.kind,
    lastNodeId: last.nodeId,
    lastRung: last.rung,
    haltedReason,
    ended,
    openFailures: [...failed].filter((id) => !passed.has(id)),
  };
}

/** Compact agent-facing status. Keep detail in `ser trace <path>`. */
export function formatTraceStatus(path: string): string {
  const s = traceStatus(path);
  const lines = [
    `trace: ${s.tracePath}`,
    `mission: ${s.missionId}`,
    `state: ${s.completed ? "completed" : s.ended ? "halted" : "running"}`,
    `nodes: ${s.passedNodes}/${s.totalNodes} passed`,
    `cost_usd: ${s.totalCostUsd.toFixed(4)}`,
    `last: ${s.lastKind}${s.lastNodeId ? ` node=${s.lastNodeId}` : ""}${s.lastRung ? ` rung=${s.lastRung}` : ""}`,
  ];
  if (s.openFailures.length > 0) lines.push(`open_failures[${s.openFailures.length}]: ${s.openFailures.join(", ")}`);
  if (s.haltedReason) lines.push(`halt_reason: ${s.haltedReason}`);
  lines.push(`help[2]:`);
  lines.push(`  ser trace ${s.tracePath}`);
  lines.push(`  ser status ${s.tracePath}`);
  return lines.join("\n");
}

function isMissionCompleted(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "completed" in payload &&
    (payload as { completed: unknown }).completed === true
  );
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

const COLS = [16, 8, 5, 5, 6, 6, 7, 10];
function padRow(cells: string[]): string {
  return cells.map((c, i) => c.padEnd(COLS[i] ?? 8)).join(" ");
}
