import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFindingDetail, formatFindings, traceFindings } from "../../src/harness/findings.js";
import { Trace } from "../../src/harness/trace.js";

function tracePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ser-findings-")), ".squire", "trace.jsonl");
}

describe("trace findings", () => {
  it("extracts actionable open and resolved findings from trace events", () => {
    const path = tracePath();
    const t = new Trace(path, "m-findings", { now: () => 1 });
    t.append("mission_start");
    t.append("node_start", { nodeId: "a", rung: 1 });
    t.append("blast_denied", { nodeId: "a", rung: 1, payload: { path: "outside.txt", reason: "outside blast radius" } });
    t.append("gate", {
      nodeId: "a",
      rung: 1,
      payload: { command: "npm test", exitCode: 1, passed: false, timedOut: false, stdoutTail: "red", stderrTail: "" },
    });
    t.append("node_fail", { nodeId: "a", rung: 1, payload: { reason: "gate_or_reconcile" } });
    t.append("node_start", { nodeId: "a", rung: 2 });
    t.append("node_pass", { nodeId: "a", rung: 2 });
    t.append("node_start", { nodeId: "b", rung: 1 });
    t.append("engine_error", { nodeId: "b", rung: 1, payload: { message: "provider timed out" } });
    t.append("audit_finding", { payload: { lens: "eng", severity: "med", note: "missing retry path", file: "app.ts" } });
    t.append("visual_finding", { payload: { severity: "high", status: "open", note: "primary action is hidden", fix: "make the primary action visible" } });
    t.append("visual_finding", { payload: { severity: "low", status: "closed", note: "spacing defect", fix: "tighten spacing" } });
    t.append("node_fail", {
      nodeId: "b",
      rung: 1,
      payload: { reason: "disputed", dispute: { target: "gate", evidence: "gate contradicts brief" } },
    });
    t.append("mission_end", { payload: { completed: false, halted: true, haltReason: "node b exhausted the escalation ladder" } });

    const findings = traceFindings(path);
    expect(findings.map((f) => [f.kind, f.state])).toEqual([
      ["blast_denied", "resolved"],
      ["gate_failed", "resolved"],
      ["engine_error", "open"],
      ["audit", "open"],
      ["visual", "open"],
      ["visual", "resolved"],
      ["dispute", "open"],
      ["mission_halted", "open"],
    ]);
    expect(findings.find((f) => f.kind === "gate_failed")!.detail).toContain("command: npm test");
    expect(findings.find((f) => f.kind === "dispute")!.detail).toBe("gate contradicts brief");
    expect(findings.find((f) => f.kind === "audit")!.detail).toContain("missing retry path");
    expect(findings.find((f) => f.kind === "visual" && f.state === "open")!.detail).toContain("make the primary action visible");
  });

  it("formats open findings by default and all findings on request", () => {
    const path = tracePath();
    const t = new Trace(path, "m-format", { now: () => 1 });
    t.append("mission_start");
    t.append("node_start", { nodeId: "a", rung: 1 });
    t.append("gate", { nodeId: "a", rung: 1, payload: { command: "false", exitCode: 1, passed: false } });
    t.append("node_pass", { nodeId: "a", rung: 2 });
    t.append("mission_end", { payload: { completed: true } });

    expect(formatFindings(path)).toContain("open_findings: 0");
    const all = formatFindings(path, { all: true });
    expect(all).toContain("f001,resolved,high,gate_failed,a,1");
    expect(formatFindingDetail(path, "f001")).toContain("next: inspect the gate output");
  });
});
