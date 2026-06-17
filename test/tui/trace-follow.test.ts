import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followTrace } from "../../src/tui/trace-follow.js";
import type { TraceEvent } from "../../src/harness/trace.js";

// One valid trace line (node_start) for mission `m`, node `id`.
const line = (m: string, id: string): string =>
  JSON.stringify({ ts: 1, missionId: m, nodeId: id, attempt: 1, rung: 1, kind: "node_start", payload: { model: "x" }, costUsdSoFar: 0 }) + "\n";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("followTrace stale-run fence", () => {
  it("does NOT replay a trace left over from an earlier run (mtime before `since`)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "follow-"));
    const sq = join(dir, ".squire");
    mkdirSync(sq, { recursive: true });

    // A leftover trace from a PRIOR run, written (and dated) well before this build starts.
    const old = join(sq, "trace-prev-run.jsonl");
    writeFileSync(old, line("prev", "analyze_spec"));
    const past = new Date(Date.now() - 3_600_000) as unknown as number; // 1h ago
    utimesSync(old, past, past);

    const seen: TraceEvent[] = [];
    const since = Date.now();
    const f = followTrace(sq, (ev) => seen.push(ev), since);
    await sleep(700); // several poll ticks
    f.stop();

    expect(seen).toHaveLength(0); // the leftover ladder must NOT be replayed as live
  });

  it("DOES follow a trace this run writes after `since`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "follow-"));
    const sq = join(dir, ".squire");
    mkdirSync(sq, { recursive: true });

    const seen: TraceEvent[] = [];
    const f = followTrace(sq, (ev) => seen.push(ev), Date.now());
    await sleep(50);
    writeFileSync(join(sq, "trace-this-run.jsonl"), line("this", "report")); // appears after `since`
    await sleep(700);
    f.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.nodeId).toBe("report");
  });
});
