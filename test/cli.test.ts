import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { writeSession } from "../src/session.js";
import { Trace } from "../src/harness/trace.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("compressed CLI surface", () => {
  it("ser status prefers the product session unless --verbose is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "ser-cli-session-"));
    const workdir = join(root, "app");
    mkdirSync(workdir);
    process.chdir(root);
    writeSession({
      goal: "Build a key vault",
      phase: "build",
      state: "working",
      summary: "Building scoped agent access.",
      next: "Continue the build.",
      workdir,
    }, root);
    const trace = new Trace(join(root, ".squire", "trace-demo.jsonl"), "demo");
    trace.append("mission_start", { payload: { goal: "internal trace" } });
    trace.append("mission_end", { payload: { completed: true } });

    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    await expect(main(["status"])).resolves.toBe(0);
    expect(output).toContain("Goal: Build a key vault");
    expect(output).toContain("Now: Building scoped agent access.");
    expect(output).not.toContain("trace:");

    output = "";
    await expect(main(["status", "--verbose"])).resolves.toBe(0);
    expect(output).toContain("trace:");
    expect(output).toContain("mission: demo");
  });
});
