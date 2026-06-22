import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickServerFile,
  serverSkeleton,
  serverPackageJson,
  serverSkeletonNote,
  scaffoldServerNode,
} from "../../src/contract/server-scaffold.js";

describe("pickServerFile", () => {
  it("prefers a conventional entrypoint, skips globs and data dirs", () => {
    expect(pickServerFile(["server.js", "data/**"])).toBe("server.js");
    expect(pickServerFile(["data/**", "src/app.js"])).toBe("src/app.js");
    expect(pickServerFile(["lib/helpers.js", "index.js"])).toBe("index.js"); // known name wins
  });
  it("falls back to the first concrete JS, then server.js", () => {
    expect(pickServerFile(["lib/thing.js", "data/**"])).toBe("lib/thing.js");
    expect(pickServerFile(["public/**", "data/**"])).toBe("server.js");
  });
});

describe("serverSkeleton — the plumbing the cheap model must NOT improvise", () => {
  const s = serverSkeleton();
  it("boots on the harness port, never a hardcoded one", () => {
    expect(s).toContain("process.env.PORT");
    expect(s).toContain("app.listen(PORT");
  });
  it("wires JSON bodies, static, and a persistence helper", () => {
    expect(s).toContain("express.json()");
    expect(s).toContain("express.static('public')");
    expect(s).toContain("const load =");
    expect(s).toContain("const save =");
  });
  it("leaves an explicit place for the model to add ONLY handlers", () => {
    expect(s).toContain("ADD YOUR ROUTE HANDLERS HERE");
  });
});

describe("serverPackageJson", () => {
  it("carries express + a start script that boots the seeded file", () => {
    const pkg = JSON.parse(serverPackageJson("server.js"));
    expect(pkg.scripts.start).toBe("node server.js");
    expect(pkg.dependencies.express).toBeTruthy();
  });
  it("merges onto an existing manifest without clobbering its scripts/deps", () => {
    const existing = JSON.stringify({ name: "mine", scripts: { test: "vitest run" }, dependencies: { zod: "^3" } });
    const pkg = JSON.parse(serverPackageJson("src/app.js", existing));
    expect(pkg.name).toBe("mine");
    expect(pkg.scripts.test).toBe("vitest run"); // kept
    expect(pkg.scripts.start).toBe("node src/app.js"); // added
    expect(pkg.dependencies.zod).toBe("^3"); // kept
    expect(pkg.dependencies.express).toBeTruthy(); // added
  });
  it("does not override a start script the manifest already declares", () => {
    const pkg = JSON.parse(serverPackageJson("server.js", JSON.stringify({ scripts: { start: "node custom.js" } })));
    expect(pkg.scripts.start).toBe("node custom.js");
  });
});

describe("serverSkeletonNote", () => {
  it("tells the node the plumbing is done and to fill only handlers", () => {
    const note = serverSkeletonNote("server.js");
    expect(note).toContain("ALREADY EXISTS");
    expect(note).toContain("process.env.PORT");
    expect(note).toContain("ADD ONLY YOUR ROUTE HANDLERS");
  });
});

describe("scaffoldServerNode — greenfield only, idempotent", () => {
  it("seeds the skeleton + a runnable package.json into an empty workdir", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    const res = scaffoldServerNode({ workdir: dir, blastRadius: ["server.js", "data/**"] });
    expect(res).toEqual({ seeded: true, serverFile: "server.js" });
    expect(readFileSync(join(dir, "server.js"), "utf8")).toContain("app.listen(PORT");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.start).toBe("node server.js");
  });
  it("seeds into a nested path from the blast_radius", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    const res = scaffoldServerNode({ workdir: dir, blastRadius: ["src/app.js"] });
    expect(res.serverFile).toBe("src/app.js");
    expect(existsSync(join(dir, "src", "app.js"))).toBe(true);
  });
  it("is a NO-OP when a server file already exists (never clobbers real work)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    writeFileSync(join(dir, "server.js"), "// the model already wrote this\n");
    const res = scaffoldServerNode({ workdir: dir, blastRadius: ["server.js"] });
    expect(res.seeded).toBe(false);
    expect(readFileSync(join(dir, "server.js"), "utf8")).toContain("the model already wrote this");
  });
});
