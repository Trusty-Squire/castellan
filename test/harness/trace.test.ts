import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace, formatTraceStatus, latestTracePath, readTrace, summarize, summarizeTrace, traceStatus } from "../../src/harness/trace.js";

function tmpTrace(): string {
  const dir = mkdtempSync(join(tmpdir(), "squire-trace-"));
  return join(dir, ".squire", "trace-m1.jsonl");
}

describe("Trace", () => {
  let path: string;
  let clock: number;
  beforeEach(() => {
    path = tmpTrace();
    clock = 1000;
  });

  it("appends JSONL events that round-trip through readTrace", () => {
    const t = new Trace(path, "m1", { now: () => ++clock });
    t.append("mission_start", { payload: { goal: "x" } });
    t.append("node_start", { nodeId: "a", attempt: 1, rung: 1 });
    t.append("node_pass", { nodeId: "a", rung: 1, costUsdSoFar: 0.01 });
    const raw = readFileSync(path, "utf8").trim().split("\n");
    expect(raw).toHaveLength(3);
    const events = readTrace(path);
    expect(events.map((e) => e.kind)).toEqual(["mission_start", "node_start", "node_pass"]);
    expect(events[2]!.costUsdSoFar).toBe(0.01);
  });

  it("summarizes per-node stats and mission completion", () => {
    const t = new Trace(path, "m1", { now: () => ++clock });
    t.append("mission_start");
    t.append("node_start", { nodeId: "a", attempt: 1, rung: 1 });
    t.append("blast_denied", { nodeId: "a", rung: 1 });
    t.append("confabulation_flag", { nodeId: "a", rung: 1 });
    t.append("gate", { nodeId: "a", rung: 1, payload: { exitCode: 0 } });
    t.append("node_pass", { nodeId: "a", rung: 1, costUsdSoFar: 0.02 });
    t.append("node_start", { nodeId: "b", attempt: 2, rung: 3 });
    t.append("node_fail", { nodeId: "b", rung: 3, costUsdSoFar: 0.05 });
    t.append("mission_end", { payload: { completed: false }, costUsdSoFar: 0.05 });

    const s = summarize(readTrace(path));
    expect(s.completed).toBe(false);
    expect(s.totalCostUsd).toBe(0.05);
    const a = s.nodes.find((n) => n.nodeId === "a")!;
    expect(a.passed).toBe(true);
    expect(a.blastDenied).toBe(1);
    expect(a.confabulations).toBe(1);
    expect(a.gateExit).toBe(0);
    const b = s.nodes.find((n) => n.nodeId === "b")!;
    expect(b.failed).toBe(true);
    expect(b.maxRung).toBe(3);
  });

  it("renders a boring plain-text table", () => {
    const t = new Trace(path, "m1", { now: () => ++clock });
    t.append("mission_start");
    t.append("node_start", { nodeId: "a", attempt: 1, rung: 1 });
    t.append("node_pass", { nodeId: "a", rung: 1, costUsdSoFar: 0.02 });
    t.append("mission_end", { payload: { completed: true }, costUsdSoFar: 0.02 });
    const out = summarizeTrace(path);
    expect(out).toMatch(/COMPLETED/);
    expect(out).toMatch(/1\/1 nodes passed/);
  });

  it("formats compact agent-facing status for a trace", () => {
    const t = new Trace(path, "m-status", { now: () => ++clock });
    t.append("mission_start", { payload: { goal: "x" } });
    t.append("node_start", { nodeId: "a", rung: 1 });
    t.append("node_pass", { nodeId: "a", rung: 1, costUsdSoFar: 0.01 });
    t.append("node_start", { nodeId: "b", rung: 1 });
    t.append("node_fail", { nodeId: "b", rung: 1, payload: { gateExitCode: 1 }, costUsdSoFar: 0.02 });
    t.append("mission_end", { payload: { completed: false, haltReason: "node b exhausted ladder" }, costUsdSoFar: 0.02 });

    expect(traceStatus(path)).toMatchObject({
      missionId: "m-status",
      completed: false,
      passedNodes: 1,
      totalNodes: 2,
      openFailures: ["b"],
      haltedReason: "node b exhausted ladder",
    });
    const out = formatTraceStatus(path);
    expect(out).toContain("nodes: 1/2 passed");
    expect(out).toContain("open_failures[1]: b");
  });

  it("finds the newest trace under .squire", () => {
    const dir = mkdtempSync(join(tmpdir(), "squire-status-"));
    const sq = join(dir, ".squire");
    mkdirSync(sq, { recursive: true });
    const oldPath = join(sq, "trace-old.jsonl");
    const newPath = join(sq, "trace-new.jsonl");
    new Trace(oldPath, "old").append("mission_start");
    new Trace(newPath, "new").append("mission_start");
    expect(latestTracePath(dir)).toBe(newPath);
  });
});
