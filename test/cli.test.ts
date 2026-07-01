import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoalPipeline, buildResumePipeline, main } from "../src/cli.js";
import { writeSession } from "../src/session.js";
import { Trace } from "../src/harness/trace.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("compressed CLI surface", () => {
  it("bare ser gives a product-loop prompt hint instead of the legacy TUI error in noninteractive shells", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    await expect(main([])).resolves.toBe(1);
    expect(output).toContain('Usage: ser "build the thing..." --yes');
    expect(output).toContain("interactive terminal");
    expect(output).not.toContain("ser needs an interactive terminal");
  });

  it("resume pipeline preserves the original product goal", () => {
    const resume = buildResumePipeline({
      goal: "Build a secure API key vault",
      phase: "build",
      state: "working",
      summary: "Running the locked spec through objective gates.",
      specPath: "/tmp/root/.ser/spec.yaml",
      workdir: "/tmp/root/vault",
      runConfig: {
        chain: "kimi",
        chains: "/tmp/root/chains.yaml",
        budget: "8",
        harness: "on",
        maxRebuilds: "5",
        outerLoops: "2",
        mock: true,
      },
      updatedAt: "2026-06-30T00:00:00.000Z",
    });

    expect(resume).toEqual({
      args: [
        "--spec",
        "/tmp/root/.ser/spec.yaml",
        "--workdir",
        "/tmp/root/vault",
        "--to",
        "ship",
        "--yes",
        "--chain",
        "kimi",
        "--chains",
        "/tmp/root/chains.yaml",
        "--budget",
        "8",
        "--harness",
        "on",
        "--max-rebuilds",
        "5",
        "--outer-loops",
        "2",
        "--mock",
      ],
      sessionGoal: "Build a secure API key vault",
    });
  });

  it("goal pipeline retries early spec failures from the original goal", () => {
    const resume = buildGoalPipeline({
      goal: "Build a small local notes tool",
      phase: "spec",
      state: "blocked",
      summary: "The idea phase failed before producing a buildable spec.",
      workdir: "/tmp/root/app",
      runConfig: {
        chain: "cheap",
        budget: "4",
      },
      updatedAt: "2026-06-30T00:00:00.000Z",
    });

    expect(resume).toEqual({
      args: [
        "Build a small local notes tool",
        "--workdir",
        "/tmp/root/app",
        "--to",
        "ship",
        "--yes",
        "--chain",
        "cheap",
        "--budget",
        "4",
      ],
      sessionGoal: "Build a small local notes tool",
    });
  });

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

  it("ser continue finds the product session from inside the workdir", async () => {
    const root = mkdtempSync(join(tmpdir(), "ser-cli-nested-continue-"));
    const workdir = join(root, "app");
    mkdirSync(join(workdir, "src"), { recursive: true });
    process.chdir(join(workdir, "src"));
    writeSession({
      goal: "Build a nested todo app",
      phase: "build",
      state: "working",
      summary: "Running the locked spec through objective gates.",
      next: "Keep building until gates pass or a blocker is proven.",
      specStatus: "locked",
      currentLoop: "build",
      lastVerifier: "node gates",
      lastResult: "running",
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
    expect(output).toContain("Goal: Build a nested todo app");
    expect(output).toContain("Continuing the verified build loop.");
    expect(output).toContain("Plan: resume from the locked spec");
    expect(output).not.toContain("--workdir");
  });

  it("ser --continue uses the same product-session controller", async () => {
    const root = mkdtempSync(join(tmpdir(), "ser-cli-dash-continue-"));
    const workdir = join(root, "app");
    mkdirSync(workdir);
    process.chdir(root);
    writeSession({
      goal: "Build a local notes app",
      phase: "ship",
      state: "complete",
      summary: "The build passed its gates and review.",
      next: "Use the delivered build.",
      specStatus: "locked",
      currentLoop: "shipped",
      lastVerifier: "gates and review",
      lastResult: "passed",
      humanNeeded: false,
      workdir,
      specPath: join(root, ".ser", "spec.yaml"),
    }, root);

    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    await expect(main(["--continue"])).resolves.toBe(0);
    expect(output).toContain("Goal: Build a local notes app");
    expect(output).toContain("Nothing to continue");
  });
});
