import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChains } from "../../src/contract/derive.js";
import { resolveChain, parseChains } from "../../src/contract/schema.js";
import { DEFAULT_CHAINS_YAML, BUILTIN_CHAINS_SOURCE } from "../../src/contract/default-chains.js";
import { SquireError } from "../../src/errors.js";

describe("built-in default chains (ser runs anywhere)", () => {
  it("DEFAULT_CHAINS_YAML parses and exposes cheap/knight-only/cheap-raw with prices", () => {
    const chains = parseChains(DEFAULT_CHAINS_YAML, "default");
    const cheap = resolveChain(chains, "cheap");
    expect(cheap.executor).toBe("qwen/qwen3-coder");
    expect(resolveChain(chains, "knight-only").executor).toBe("moonshotai/kimi-k2.6");
    expect(resolveChain(chains, "cheap-raw").harness).toBe("off");
  });
});

describe("resolveChains", () => {
  const prevCwd = process.cwd();
  const prevHome = process.env.CASTELLAN_HOME;
  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.CASTELLAN_HOME;
    else process.env.CASTELLAN_HOME = prevHome;
  });

  it("falls back to built-in defaults when no chains.yaml exists anywhere", () => {
    const cwd = mkdtempSync(join(tmpdir(), "no-chains-"));
    const emptyHome = mkdtempSync(join(tmpdir(), "empty-home-"));
    process.chdir(cwd);
    process.env.CASTELLAN_HOME = emptyHome; // global config dir with no chains.yaml
    const { chains, path } = resolveChains(cwd);
    expect(path).toBe(BUILTIN_CHAINS_SOURCE);
    expect(resolveChain(chains, "cheap").executor).toBe("qwen/qwen3-coder");
  });

  it("a project chains.yaml in the workdir overrides the defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-chains-"));
    const emptyHome = mkdtempSync(join(tmpdir(), "empty-home2-"));
    process.chdir(cwd);
    process.env.CASTELLAN_HOME = emptyHome;
    writeFileSync(
      join(cwd, "chains.yaml"),
      'chains:\n  cheap:\n    executor: "x/custom"\n    fallback: "x/custom"\n    knight: "x/custom"\nprices:\n  "x/custom": { in: 1, out: 1 }\n',
    );
    const { chains, path } = resolveChains(cwd);
    expect(path).toContain("chains.yaml");
    expect(resolveChain(chains, "cheap").executor).toBe("x/custom");
  });

  it("the global ~/.config/castellan/chains.yaml is used when no project file exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-noc-"));
    const home = mkdtempSync(join(tmpdir(), "home-chains-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "chains.yaml"),
      'chains:\n  cheap:\n    executor: "g/global"\n    fallback: "g/global"\n    knight: "g/global"\nprices:\n  "g/global": { in: 1, out: 1 }\n',
    );
    process.chdir(cwd);
    process.env.CASTELLAN_HOME = home;
    expect(resolveChain(resolveChains(cwd).chains, "cheap").executor).toBe("g/global");
  });

  it("an explicit --chains path that does not exist is an error", () => {
    expect(() => resolveChains(process.cwd(), "/no/such/chains.yaml")).toThrow(SquireError);
  });
});
