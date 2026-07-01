import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSessionStatus, readNearestSession, readSession, writeSession } from "../src/session.js";

describe("SER session status", () => {
  it("writes and reads the product-level session envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "ser-session-"));
    const workdir = join(root, "app");
    mkdirSync(workdir);

    writeSession({
      goal: "Build a key vault",
      phase: "build",
      state: "working",
      summary: "Building scoped agent access.",
      next: "Continue the build.",
      workdir,
      specPath: join(root, "vault.spec.yaml"),
      latestTrace: join(workdir, ".squire", "trace-run.jsonl"),
      runConfig: {
        chain: "kimi",
        budget: "8",
        mock: true,
      },
    }, root);

    const session = readSession(root);
    expect(session).toMatchObject({
      goal: "Build a key vault",
      phase: "build",
      state: "working",
      summary: "Building scoped agent access.",
      runConfig: {
        chain: "kimi",
        budget: "8",
        mock: true,
      },
    });
    expect(session?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("formats status without harness terminology", () => {
    const root = mkdtempSync(join(tmpdir(), "ser-session-format-"));
    const out = formatSessionStatus({
      goal: "Build a key vault",
      phase: "build",
      state: "working",
      summary: "Building scoped agent access.",
      next: "Continue the build.",
      workdir: join(root, "app"),
      specPath: join(root, "vault.spec.yaml"),
      updatedAt: "2026-06-30T00:00:00.000Z",
    }, root);

    expect(out).toContain("Goal: Build a key vault");
    expect(out).toContain("State: working");
    expect(out).toContain("Now: Building scoped agent access.");
    expect(out).toContain("Next: Continue the build.");
    expect(out).toContain("Workdir: app");
    expect(out).toContain("Spec: vault.spec.yaml");
    expect(out).not.toMatch(/\b(trace|node|gate|rung)\b/i);
  });

  it("ignores older non-product session files", () => {
    const root = mkdtempSync(join(tmpdir(), "ser-session-legacy-"));
    mkdirSync(join(root, ".ser"));
    writeFileSync(join(root, ".ser", "session.json"), JSON.stringify({
      layer: "idea",
      prompt: "a simple offline todo list app",
    }));

    expect(readSession(root)).toBeNull();
  });

  it("finds the nearest product session from nested workdirs", () => {
    const root = mkdtempSync(join(tmpdir(), "ser-session-nearest-"));
    const nested = join(root, "app", "src");
    mkdirSync(nested, { recursive: true });
    writeSession({
      goal: "Build a nested app",
      phase: "build",
      state: "working",
      summary: "Building from the locked spec.",
      workdir: join(root, "app"),
      specPath: join(root, ".ser", "spec.yaml"),
    }, root);

    const located = readNearestSession(nested);
    expect(located?.root).toBe(root);
    expect(located?.session.goal).toBe("Build a nested app");
  });
});
