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

  it("ser continue reads the product session before falling back to the TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "ser-cli-continue-"));
    const workdir = join(root, "app");
    mkdirSync(workdir);
    process.chdir(root);
    writeSession({
      goal: "Build an offline todo app",
      phase: "spec",
      state: "complete",
      summary: "The spec is buildable.",
      next: "Continue when ready to run the verified build loop.",
      specStatus: "locked",
      currentLoop: "ready to build from the locked spec",
      lastVerifier: "spec compiler",
      lastResult: "passed",
      nextMutation: "run the build loop",
      humanNeeded: false,
      workdir,
      specPath: join(root, ".ser", "spec.yaml"),
    }, root);

    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    await expect(main(["continue", "--plan"])).resolves.toBe(0);
    expect(output).toContain("Goal: Build an offline todo app");
    expect(output).toContain("Loop: ready to build from the locked spec");
    expect(output).toContain("Plan: resume from the locked spec");
    expect(output).not.toContain("--spec");
    expect(output).not.toContain(".squire");
  });
});
