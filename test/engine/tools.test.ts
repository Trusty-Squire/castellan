import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, clampOutput } from "../../src/engine/tools.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "squire-tools-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
});

describe("ToolExecutor", () => {
  it("writes within blast radius and records the write", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("write", { path: "src/a.ts", content: "x" });
    expect(r.ok).toBe(true);
    expect(r.denied).toBe(false);
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("x");
    expect(exec.executedWrites).toEqual(["src/a.ts"]);
  });

  it("wraps top-level JavaScript data literals as CommonJS modules", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("write", {
      path: "src/data.js",
      content: "[{'id': 1, 'outcomes': ['A', 'B'], 'books': []}]",
    });

    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "src", "data.js"), "utf8")).toBe(
      "module.exports = [{'id': 1, 'outcomes': ['A', 'B'], 'books': []}];\n",
    );
  });

  it("leaves normal JavaScript source unchanged", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const source = "function findArbitrage() { return []; }\nmodule.exports = { findArbitrage };\n";
    const r = await exec.execute("write", { path: "src/opportunities.js", content: source });

    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "src", "opportunities.js"), "utf8")).toBe(source);
  });

  it("DENIES a write outside blast radius before touching disk", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("write", { path: "secrets/key.ts", content: "leak" });
    expect(r.denied).toBe(true);
    expect(r.ok).toBe(false);
    expect(existsSync(join(cwd, "secrets", "key.ts"))).toBe(false);
    expect(exec.executedWrites).toEqual([]);
  });

  it("denies a path that escapes the workdir", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    const r = await exec.execute("write", { path: "../escape.ts", content: "x" });
    expect(r.denied).toBe(true);
    expect(r.output).toMatch(/escapes the workdir/);
  });

  it("edits an existing file by string replacement", async () => {
    writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;");
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("edit", { path: "src/a.ts", oldString: "1", newString: "2" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("const x = 2;");
  });

  it("fails an edit when oldString is absent", async () => {
    writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;");
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("edit", { path: "src/a.ts", oldString: "zzz", newString: "2" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/);
  });

  it("reads files and runs bash in cwd", async () => {
    writeFileSync(join(cwd, "src", "a.ts"), "hello");
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const read = await exec.execute("read", { path: "src/a.ts" });
    expect(read.output).toBe("hello");
    const bash = await exec.execute("bash", { command: "echo hi" });
    expect(bash.ok).toBe(true);
    expect(bash.output).toMatch(/hi/);
  });

  it("clamps a huge bash output so it can't balloon the agent context", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    // ~400KB of output
    const r = await exec.execute("bash", { command: "for i in $(seq 1 40000); do echo xxxxxxxxxx; done" });
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThan(13_000);
    expect(r.output).toMatch(/omitted to bound context/);
  });

  it("clampOutput keeps head + tail and marks the omission", () => {
    const big = "A".repeat(50_000) + "ZZZ";
    const clamped = clampOutput(big);
    expect(clamped.length).toBeLessThan(13_000);
    expect(clamped.startsWith("AAAA")).toBe(true);
    expect(clamped.endsWith("ZZZ")).toBe(true);
    expect(clamped).toMatch(/bytes of output omitted/);
    expect(clampOutput("small")).toBe("small");
  });

  it("honors the denylist", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"], denylist: ["bash"] });
    const r = await exec.execute("bash", { command: "echo x" });
    expect(r.denied).toBe(true);
  });
});
