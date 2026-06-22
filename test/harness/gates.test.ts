import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/harness/gates.js";

const cwd = mkdtempSync(join(tmpdir(), "squire-gate-"));

describe("runGate", () => {
  it("passes when the command exits 0", async () => {
    const r = await runGate("exit 0", cwd);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("chmod +x's a model-authored .sh so ./script.sh runs (no execute bit from the write tool)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "squire-gate-sh-"));
    writeFileSync(join(dir, "run-bot.sh"), "#!/bin/sh\necho ok\n"); // written WITHOUT +x (mode 0644)
    const r = await runGate("./run-bot.sh | grep -q ok", dir);
    expect(r.passed).toBe(true); // would be exit 126 (Permission denied) before the chmod
    expect(r.exitCode).toBe(0);
  });

  it("fails when the command exits nonzero and captures stderr", async () => {
    const r = await runGate("echo boom 1>&2; exit 3", cwd);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toMatch(/boom/);
  });

  it("runs in the given cwd", async () => {
    writeFileSync(join(cwd, "marker.txt"), "hi");
    const r = await runGate("test -f marker.txt", cwd);
    expect(r.passed).toBe(true);
  });

  it("reports a timeout as failed", async () => {
    const r = await runGate("sleep 2", cwd, 100);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("truncates very long output to a tail", async () => {
    const r = await runGate("for i in $(seq 1 5000); do echo 'xxxxxxxxxxxxxxxx'; done", cwd);
    expect(r.passed).toBe(true);
    expect(r.stdoutTail).toMatch(/truncated/);
    expect(Buffer.byteLength(r.stdoutTail, "utf8")).toBeLessThan(4200);
  });
});
