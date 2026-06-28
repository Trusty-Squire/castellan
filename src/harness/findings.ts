import { readTrace, type TraceEvent } from "./trace.js";

export type FindingKind =
  | "gate_failed"
  | "reconcile_violation"
  | "blast_denied"
  | "confabulation"
  | "judge_flag"
  | "engine_error"
  | "budget_stop"
  | "dispute"
  | "retrospect"
  | "audit"
  | "visual"
  | "mission_halted";

export type FindingSeverity = "high" | "med" | "low";
export type FindingState = "open" | "resolved";

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  state: FindingState;
  title: string;
  detail: string;
  nodeId?: string;
  rung?: number;
  next: string;
}

interface DraftFinding extends Omit<Finding, "id" | "state"> {
  eventIndex: number;
}

export function traceFindings(path: string): Finding[] {
  const events = readTrace(path);
  const passIndex = latestPassIndexByNode(events);
  const drafts: DraftFinding[] = [];

  events.forEach((ev, i) => {
    switch (ev.kind) {
      case "gate": {
        if (readBool(ev.payload, "passed") !== false) break;
        const command = readString(ev.payload, "command") ?? "(unknown command)";
        const exitCode = readNumber(ev.payload, "exitCode");
        const timedOut = readBool(ev.payload, "timedOut") === true;
        const stderr = readString(ev.payload, "stderrTail");
        const stdout = readString(ev.payload, "stdoutTail");
        drafts.push({
          eventIndex: i,
          kind: "gate_failed",
          severity: "high",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `gate failed${ev.nodeId ? ` for ${ev.nodeId}` : ""}`,
          detail: compact([
            `command: ${command}`,
            exitCode === undefined ? undefined : `exit: ${exitCode}`,
            timedOut ? "timed out" : undefined,
            stderr ? `stderr: ${stderr}` : stdout ? `stdout: ${stdout}` : undefined,
          ]),
          next: ev.nodeId
            ? `inspect the gate output, then rerun or repair node "${ev.nodeId}"`
            : "inspect the gate output and repair the failing check",
        });
        break;
      }
      case "reconcile": {
        const violations = [
          ...readStringArray(ev.payload, "violations"),
          ...readStringArray(ev.payload, "missingFromDiff").map((v) => `missing from diff: ${v}`),
          ...readStringArray(ev.payload, "outOfRadius").map((v) => `out of radius: ${v}`),
        ];
        if (violations.length === 0) break;
        drafts.push({
          eventIndex: i,
          kind: "reconcile_violation",
          severity: "high",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `reconcile violation${ev.nodeId ? ` in ${ev.nodeId}` : ""}`,
          detail: violations.slice(0, 4).join("; "),
          next: "make the attempted changes match the node blast radius and final claims",
        });
        break;
      }
      case "blast_denied": {
        const path = readString(ev.payload, "path") ?? "";
        const reason = readString(ev.payload, "reason") ?? "blast-radius denied";
        drafts.push({
          eventIndex: i,
          kind: "blast_denied",
          severity: "med",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `out-of-radius edit denied${ev.nodeId ? ` in ${ev.nodeId}` : ""}`,
          detail: compact([path ? `path: ${path}` : undefined, reason]),
          next: "either narrow the implementation to the allowed files or fix the mission blast radius",
        });
        break;
      }
      case "confabulation_flag": {
        drafts.push({
          eventIndex: i,
          kind: "confabulation",
          severity: "high",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `claim did not match diff${ev.nodeId ? ` in ${ev.nodeId}` : ""}`,
          detail: readString(ev.payload, "finalMessage") ?? "agent claimed work the trace could not verify",
          next: "treat the attempt as untrusted; verify actual changed files before resuming",
        });
        break;
      }
      case "judge_flag": {
        drafts.push({
          eventIndex: i,
          kind: "judge_flag",
          severity: "low",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `soft judge flagged ${ev.nodeId ?? "a node"}`,
          detail: readString(ev.payload, "flag") ?? "soft judge returned a warning",
          next: "review the warning; it did not block the node gate",
        });
        break;
      }
      case "engine_error": {
        drafts.push({
          eventIndex: i,
          kind: "engine_error",
          severity: "med",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `engine error${ev.nodeId ? ` in ${ev.nodeId}` : ""}`,
          detail: readString(ev.payload, "message") ?? "engine reported an error",
          next: "check whether a later rung passed; otherwise retry or switch backend",
        });
        break;
      }
      case "budget_stop": {
        const scope = readString(ev.payload, "scope") ?? "budget";
        drafts.push({
          eventIndex: i,
          kind: "budget_stop",
          severity: "high",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `${scope} budget stopped the run`,
          detail: JSON.stringify(ev.payload),
          next: "reduce scope or raise the budget before resuming",
        });
        break;
      }
      case "node_fail": {
        const dispute = readObject(ev.payload, "dispute");
        if (!dispute) break;
        const target = readString(dispute, "target") ?? "task";
        drafts.push({
          eventIndex: i,
          kind: "dispute",
          severity: "high",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `node disputed its ${target}`,
          detail: readString(dispute, "evidence") ?? "the executor reported a task contradiction",
          next: "review whether the brief or gate is genuinely mis-specified",
        });
        break;
      }
      case "retrospect": {
        const fault = readString(ev.payload, "fault");
        const gateProblem = readString(ev.payload, "gateProblem");
        if (fault !== "harness" && !gateProblem) break;
        drafts.push({
          eventIndex: i,
          kind: "retrospect",
          severity: gateProblem ? "high" : "med",
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: gateProblem ? "retrospective found a gate problem" : "retrospective found a harness fault",
          detail: gateProblem ?? readString(ev.payload, "evidence") ?? "planner adjusted the task",
          next: gateProblem ? "route through audited gate repair; do not weaken the gate directly" : "review the adjusted brief/context",
        });
        break;
      }
      case "audit_finding": {
        const severity = normalizeSeverity(readString(ev.payload, "severity")) ?? "low";
        const note = readString(ev.payload, "note") ?? "audit reviewer reported an issue";
        const lens = readString(ev.payload, "lens") ?? "audit";
        const file = readString(ev.payload, "file");
        drafts.push({
          eventIndex: i,
          kind: "audit",
          severity,
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: `${lens} audit finding`,
          detail: compact([note, file ? `file: ${file}` : undefined]),
          next: severity === "high" ? "fix before shipping or explicitly accept the risk" : "consider as polish after gates are green",
        });
        break;
      }
      case "visual_finding": {
        const severity = normalizeSeverity(readString(ev.payload, "severity")) ?? "high";
        const fix = readString(ev.payload, "fix");
        const note = readString(ev.payload, "note") ?? "visual review reported an issue";
        const status = readString(ev.payload, "status");
        drafts.push({
          eventIndex: i,
          kind: "visual",
          severity,
          nodeId: ev.nodeId,
          rung: ev.rung,
          title: status === "closed" ? "visual defect closed" : "visual review blocks ship",
          detail: compact([note, fix ? `fix: ${fix}` : undefined]),
          next: status === "closed" ? "no action needed; frozen visual defect was verified closed" : "fold the fix into the spec and rebuild",
        });
        break;
      }
      case "mission_end": {
        if (readBool(ev.payload, "completed") === true) break;
        const haltReason = readString(ev.payload, "haltReason") ?? readString(ev.payload, "reason");
        drafts.push({
          eventIndex: i,
          kind: "mission_halted",
          severity: "high",
          title: "mission halted",
          detail: haltReason ?? "mission ended without completing every node",
          next: "fix the open findings, then rerun or resume from the trace/workdir",
        });
        break;
      }
      default:
        break;
    }
  });

  return drafts.map((f, i) => {
    const resolved =
      f.nodeId !== undefined &&
      passIndex.has(f.nodeId) &&
      passIndex.get(f.nodeId)! > f.eventIndex &&
      f.kind !== "judge_flag" &&
      !(f.kind === "visual" && /visual defect closed/i.test(f.title));
    const closedVisual = f.kind === "visual" && /visual defect closed/i.test(f.title);
    return {
      id: `f${String(i + 1).padStart(3, "0")}`,
      state: resolved || closedVisual ? "resolved" : "open",
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      nodeId: f.nodeId,
      rung: f.rung,
      next: f.next,
    };
  });
}

export function formatFindings(path: string, opts: { all?: boolean } = {}): string {
  const findings = traceFindings(path);
  const shown = opts.all ? findings : findings.filter((f) => f.state === "open");
  const open = findings.filter((f) => f.state === "open").length;
  const lines = [
    `trace: ${path}`,
    `findings: ${open} open, ${findings.length} total${opts.all ? "" : " (showing open)"}`,
  ];

  if (shown.length === 0) {
    lines.push("open_findings: 0");
  } else {
    lines.push(`items[${shown.length}]{id,state,severity,kind,node,rung,title}:`);
    for (const f of shown) {
      lines.push(
        `  ${f.id},${f.state},${f.severity},${f.kind},${f.nodeId ?? "-"},${f.rung ?? "-"},${csv(f.title)}`,
      );
    }
  }
  lines.push("help[2]:");
  lines.push(`  ser findings ${path} --all`);
  lines.push(`  ser trace ${path}`);
  return lines.join("\n");
}

export function formatFindingDetail(path: string, id: string): string {
  const finding = traceFindings(path).find((f) => f.id === id);
  if (!finding) {
    return [`error: finding not found: ${id}`, `help[1]: ser findings ${path} --all`].join("\n");
  }
  return [
    `id: ${finding.id}`,
    `state: ${finding.state}`,
    `severity: ${finding.severity}`,
    `kind: ${finding.kind}`,
    finding.nodeId ? `node: ${finding.nodeId}` : undefined,
    finding.rung ? `rung: ${finding.rung}` : undefined,
    `title: ${finding.title}`,
    `detail: ${finding.detail}`,
    `next: ${finding.next}`,
    "help[2]:",
    `  ser trace ${path}`,
    `  ser status ${path}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function latestPassIndexByNode(events: TraceEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  events.forEach((ev, i) => {
    if (ev.kind === "node_pass" && ev.nodeId) out.set(ev.nodeId, i);
  });
  return out;
}

function compact(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join("; ");
}

function csv(value: string): string {
  return /[,\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function readObject(payload: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "object" && v !== null) return v as Record<string, unknown>;
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

function readStringArray(payload: unknown, key: string): string[] {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return [];
  const v = (payload as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function readBool(payload: unknown, key: string): boolean | undefined {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

function normalizeSeverity(value: string | undefined): FindingSeverity | undefined {
  if (value === "high" || value === "med" || value === "low") return value;
  if (value === "medium") return "med";
  if (value === "critical" || value === "blocker") return "high";
  if (value === "minor" || value === "info" || value === "nit") return "low";
  return undefined;
}
