import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateMissionFile } from "../../src/contract/validate.js";

describe("validateMissionFile", () => {
  it("should pass a valid mission file with existing chain and matching globs", () => {
    const missionDir = mkdtempSync(join(tmpdir(), "mission-valid-"));
    const missionPath = join(missionDir, "mission.yaml");
    const chainsPath = join(missionDir, "chains.yaml");
    const workDir = join(missionDir, "work");

    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      missionPath,
      `
goal: "make it green"
budget_usd: 2.5
chain: cheap
workdir: "work"
nodes:
  - id: a
    brief: "do a"
    blast_radius: ["src/**"]
    done_check: "pnpm test"
    budget_usd: 0.5
`
    );

    writeFileSync(
      chainsPath,
      `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
`
    );

    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(join(workDir, "src", "dummy.txt"), "content");

    const report = validateMissionFile(missionPath, chainsPath);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("should fail if chain name is not present in chains file", () => {
    const missionDir = mkdtempSync(join(tmpdir(), "mission-bad-chain-"));
    const missionPath = join(missionDir, "mission.yaml");
    const chainsPath = join(missionDir, "chains.yaml");

    writeFileSync(
      missionPath,
      `
goal: "make it green"
budget_usd: 2.5
chain: nonexistent
nodes:
  - id: a
    brief: "do a"
    blast_radius: ["**"]
    done_check: "pnpm test"
    budget_usd: 0.5
`
    );

    writeFileSync(
      chainsPath,
      `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
`
    );

    const report = validateMissionFile(missionPath, chainsPath);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.level === "error" && i.message.includes("nonexistent"))).toBe(
      true
    );
  });

  it("should warn (but not fail) if context_globs matches zero files", () => {
    const missionDir = mkdtempSync(join(tmpdir(), "mission-no-context-"));
    const missionPath = join(missionDir, "mission.yaml");
    const chainsPath = join(missionDir, "chains.yaml");
    const workDir = join(missionDir, "work");

    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      missionPath,
      `
goal: "make it green"
budget_usd: 2.5
chain: cheap
workdir: "work"
nodes:
  - id: a
    brief: "do a"
    context_globs: ["missing/**"]
    blast_radius: ["src/**"]
    done_check: "pnpm test"
    budget_usd: 0.5
`
    );

    writeFileSync(
      chainsPath,
      `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
`
    );

    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(join(workDir, "src", "dummy.txt"), "content");

    const report = validateMissionFile(missionPath, chainsPath);
    expect(report.ok).toBe(true); // warnings don't affect ok status
    expect(
      report.issues.some(
        (i) => i.level === "warn" && i.nodeId === "a" && i.message.includes("context_globs")
      )
    ).toBe(true);
  });

  it("should fail if blast_radius is empty", () => {
    const missionDir = mkdtempSync(join(tmpdir(), "mission-empty-radius-"));
    const missionPath = join(missionDir, "mission.yaml");
    const chainsPath = join(missionDir, "chains.yaml");

    writeFileSync(
      missionPath,
      `
goal: "make it green"
budget_usd: 2.5
chain: cheap
nodes:
  - id: a
    brief: "do a"
    blast_radius: []
    done_check: "pnpm test"
    budget_usd: 0.5
`
    );

    writeFileSync(
      chainsPath,
      `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
`
    );

    const report = validateMissionFile(missionPath, chainsPath);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.level === "error" && i.nodeId === "a" && i.message.includes("blast_radius"))
    ).toBe(true);
  });

  it("should fail gracefully on unparseable mission file", () => {
    const missionDir = mkdtempSync(join(tmpdir(), "mission-unparseable-"));
    const missionPath = join(missionDir, "mission.yaml");
    const chainsPath = join(missionDir, "chains.yaml");

    writeFileSync(missionPath, `
goal: "unclosed quote --> 
budget_usd: 2.5
chain: cheap
nodes:
  - id: a
    brief: "do a"
    blast_radius: ["**"]
    done_check: "pnpm test"
    budget_usd: 0.5
`);

    writeFileSync(
      chainsPath,
      `
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
`
    );

    const report = validateMissionFile(missionPath, chainsPath);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.level === "error")).toBe(true);
  });
});