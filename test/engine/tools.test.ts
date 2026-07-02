import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, clampOutput, broadProcessKill } from "../../src/engine/tools.js";

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

  it("REFUSES a malformed package.json (the silent gate-poisoner) with a corrective nudge", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    const r = await exec.execute("write", {
      path: "package.json",
      content: '{\n  "name": "app",\n  "deps": { "sqlite3": "^5" },  // trailing comma + comment\n}',
    });
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(false);
    expect(r.output).toMatch(/not valid JSON/);
    expect(r.output).toMatch(/STRICT JSON/);
    expect(existsSync(join(cwd, "package.json"))).toBe(false); // broken manifest not persisted
  });

  it("accepts a valid package.json", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    const r = await exec.execute("write", {
      path: "package.json",
      content: '{\n  "name": "app",\n  "dependencies": { "sqlite3": "^5.1.0" }\n}',
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(cwd, "package.json"))).toBe(true);
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

  it("refuses top-level data literals for executable JavaScript files", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["src/**"] });
    const r = await exec.execute("write", {
      path: "src/notes.js",
      content: "[{'utf8':'return JSON.parse(data);'}]",
    });

    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/top-level data literal|raw JS text/);
    expect(existsSync(join(cwd, "src", "notes.js"))).toBe(false);
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

  it("marks non-zero bash as failed and keeps the exit code with command output", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    const r = await exec.execute("bash", { command: "echo nope; exit 7" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("nope");
    expect(r.output).toContain("(exit 7)");
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

  it("blocks broad process-kills (pkill/killall) but allows scoped kill", () => {
    for (const c of ["pkill -f node", "killall node", "killall -9 node", "x; pkill -f 'node server.js'", "echo y && pkill node"]) {
      expect(broadProcessKill(c), c).not.toBeNull();
    }
    for (const c of ["npm start", "node server.js & SRV=$!; sleep 1; kill $SRV", "kill 12345", "echo pkillnot"]) {
      expect(broadProcessKill(c), c).toBeNull();
    }
  });

  it("denies a broad process-kill at the bash membrane without executing it", async () => {
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"] });
    const r = await exec.execute("bash", { command: "pkill -f node" });
    expect(r.denied).toBe(true);
    expect(r.output).toMatch(/kill the build harness|\$PORT/);
  });

  it("protectedPaths hard-denies writing a held-out test even when blast_radius would allow it", async () => {
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "test", "r4.cjs"), "// held-out grader\n");
    const exec = new ToolExecutor(cwd, { blastRadius: ["**"], protectedPaths: ["test/r4.cjs"] });
    const denied = await exec.execute("write", { path: "test/r4.cjs", content: "process.exit(0)" });
    expect(denied.denied).toBe(true);
    expect(denied.output).toMatch(/held-out test|cannot edit your own grader/i);
    expect(readFileSync(join(cwd, "test", "r4.cjs"), "utf8")).toBe("// held-out grader\n"); // untouched
    // a build output (not protected) still writes fine
    const ok = await exec.execute("write", { path: "src/engine.js", content: "module.exports={}" });
    expect(ok.ok).toBe(true);
  });
});
