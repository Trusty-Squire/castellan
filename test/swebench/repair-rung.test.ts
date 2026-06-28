import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function loadMjs<T = Record<string, unknown>>(rel: string): Promise<T> {
  return import(pathToFileURL(join(root, rel)).href) as Promise<T>;
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ser-swebench-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

describe("SWE-bench repair rung utilities", () => {
  it("extracts explicit contracts for the pytest MRO and exception-chain cases", async () => {
    const { oracleContractHints } = await loadMjs<{ oracleContractHints: (patch: string) => string }>("projects/swebench/contracts.mjs");

    expect(oracleContractHints("def test_mark_mro()")).toContain("class-first MRO order");
    expect(oracleContractHints("def test_mark_mro()")).toContain("concrete list");
    expect(oracleContractHints("def test_chained_exceptions()")).toContain("ExceptionChainRepr");
    expect(oracleContractHints("def test_chained_exceptions()")).toContain("top-level reprtraceback");
  });

  it("flags bad patch shapes without rejecting the valid MRO fallback pattern", async () => {
    const { patchLint } = await loadMjs<{ patchLint: (problem: string, diff: string) => string[] }>("projects/swebench/patch-lints.mjs");

    expect(patchLint("Consider MRO when obtaining marks for classes", '+ for cls in reversed(obj.__mro__):\n+     cls.__dict__.get("pytestmark", [])')).toContain(
      "MRO marks patch reverses obj.__mro__; expected class-before-base MRO order.",
    );
    expect(patchLint("Consider MRO when obtaining marks for classes", "+ mark_list = getattr(obj, \"pytestmark\", [])")).toHaveLength(1);
    expect(
      patchLint(
        "Consider MRO when obtaining marks for classes",
        '+ mark_list = cls.__dict__.get("pytestmark", [])\n+ mark_list = getattr(obj, "pytestmark", [])',
      ),
    ).toHaveLength(0);
  });

  it("injects contract-required serializer symbols for exception-chain repair", async () => {
    const { contractContext } = await loadMjs<{ contractContext: (wd: string, problem: string) => string }>("projects/swebench/context-expand.mjs");
    const wd = mkdtempSync(join(tmpdir(), "ser-swebench-context-"));
    mkdirSync(join(wd, "src/_pytest/_code"), { recursive: true });
    writeFileSync(
      join(wd, "src/_pytest/reports.py"),
      [
        "from _pytest._code.code import ReprTraceback",
        "class BaseReport:",
        "    def _to_json(self):",
        "        pass",
        "    @classmethod",
        "    def _from_json(cls, reportdict):",
        "        pass",
        "def _report_unserialization_failure(type_name, report_class, reportdict):",
        "    pass",
      ].join("\n"),
    );
    writeFileSync(
      join(wd, "src/_pytest/_code/code.py"),
      [
        "class ExceptionChainRepr:",
        "    pass",
        "class ReprExceptionInfo:",
        "    pass",
        "class ReprTraceback:",
        "    pass",
      ].join("\n"),
    );

    const ctx = contractContext(wd, "exception chain serialization");
    expect(ctx).toContain("def _to_json");
    expect(ctx).toContain("def _from_json");
    expect(ctx).toContain("class ExceptionChainRepr");
  });

  it("applies Aider, loose SEARCH/REPLACE, and unified diff patches", async () => {
    const { applyEdits } = await loadMjs<{ applyEdits: (wd: string, text: string) => number }>("projects/swebench/select.mjs");
    const wd = tempRepo();
    mkdirSync(join(wd, "src"), { recursive: true });
    writeFileSync(join(wd, "src/demo.py"), "value = 1\n");
    execFileSync("git", ["add", "src/demo.py"], { cwd: wd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: wd });

    expect(applyEdits(wd, "### src/demo.py\n<<<<<<< SEARCH\nvalue = 1\n=======\nvalue = 2\n>>>>>>> REPLACE")).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 2\n");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    expect(applyEdits(wd, "SEARCH src/demo.py\n```python\nvalue = 1\n```\nREPLACE\n```python\nvalue = 3\n```")).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 3\n");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    expect(
      applyEdits(
        wd,
        "diff --git a/src/demo.py b/src/demo.py\nindex 3be9c81..7d840d6 100644\n--- a/src/demo.py\n+++ b/src/demo.py\n@@ -1 +1 @@\n-value = 1\n+value = 4\n",
      ),
    ).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 4\n");
  });

  it("requires all oracle nodes before treating a candidate as solved", async () => {
    const { answerPass } = await loadMjs<{ answerPass: (candidate: { reproPass?: number; oraclePass?: number }, oracleTotal?: number) => number }>(
      "projects/swebench/select.mjs",
    );

    expect(answerPass({ oraclePass: 1 }, 1)).toBe(1);
    expect(answerPass({ oraclePass: 1 }, 6)).toBe(0);
    expect(answerPass({ reproPass: 1, oraclePass: 0 }, 0)).toBe(1);
  });
});
