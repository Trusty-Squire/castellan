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
    const { oracleContractHints, oracleInfo } = await loadMjs<{
      oracleContractHints: (patch: string) => string;
      oracleInfo: (inst: { FAIL_TO_PASS: string; test_patch: string }) => { nodes: string[]; text: string };
    }>("projects/swebench/contracts.mjs");

    expect(oracleContractHints("def test_mark_mro()")).toContain("class-first MRO order");
    expect(oracleContractHints("def test_mark_mro()")).toContain("concrete list");
    expect(oracleContractHints("def test_chained_exceptions()")).toContain("ExceptionChainRepr");
    expect(oracleContractHints("def test_chained_exceptions()")).toContain("top-level reprtraceback");
    expect(oracleContractHints("def test_prepend_scheme_if_needed():\n    value = 'http://user:pass@example.com/path?query'")).toContain("auth separately from parsed.netloc");

    const info = oracleInfo({
      FAIL_TO_PASS: JSON.stringify(["test_requests.py::RequestsTestCase::test_headers_on_session_with_None_are_not_sent"]),
      test_patch: [
        "diff --git a/test_requests.py b/test_requests.py",
        "--- a/test_requests.py",
        "+++ b/test_requests.py",
        "@@ -1,2 +1,8 @@",
        "+    def test_headers_on_session_with_None_are_not_sent(self):",
        "+        ses = requests.Session()",
        "+        ses.headers['Accept-Encoding'] = None",
        "+        prep = ses.prepare_request(requests.Request('GET', 'http://example.com'))",
        "+        assert 'Accept-Encoding' not in prep.headers",
      ].join("\n"),
    });
    expect(info.text).toContain("Every node below must pass");
    expect(info.text).toContain("def test_headers_on_session_with_None_are_not_sent");
    expect(info.text).toContain("None must be removed");
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
    expect(
      patchLint(
        "Allow FilePathField path to accept a callable.",
        [
          "diff --git a/django/db/models/fields/__init__.py b/django/db/models/fields/__init__.py",
          "-            'form_class': forms.FilePathField,",
          "+            'path': path,",
        ].join("\n"),
      ),
    ).toContain("FilePathField.formfield() must preserve form_class=forms.FilePathField while evaluating callable path.");
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

  it("injects Django media ordering helpers for media conflict repair", async () => {
    const { contractContext } = await loadMjs<{ contractContext: (wd: string, problem: string) => string }>("projects/swebench/context-expand.mjs");
    const wd = mkdtempSync(join(tmpdir(), "ser-swebench-media-"));
    mkdirSync(join(wd, "django/utils"), { recursive: true });
    writeFileSync(
      join(wd, "django/utils/topological_sort.py"),
      [
        "class CyclicDependencyError(ValueError):",
        "    pass",
        "def stable_topological_sort(l, dependency_graph):",
        "    return list(l)",
      ].join("\n"),
    );
    writeFileSync(join(wd, "django/utils/datastructures.py"), "class OrderedSet:\n    pass\n");

    const ctx = contractContext(wd, "Merging 3 or more media objects can throw MediaOrderConflictWarning.");
    expect(ctx).toContain("stable_topological_sort");
    expect(ctx).toContain("class OrderedSet");
  });

  it("keeps exact quoted literals in function context", async () => {
    const { funcContext } = await loadMjs<{ funcContext: (wd: string, cands: string[], problem: string) => string }>("projects/swebench/select.mjs");
    const wd = mkdtempSync(join(tmpdir(), "ser-swebench-literal-"));
    mkdirSync(join(wd, "pkg"), { recursive: true });
    writeFileSync(
      join(wd, "pkg/fields.py"),
      [
        "class DurationField:",
        "    default_error_messages = {",
        "        'invalid': \"'%(value)s' value has an invalid format. It must be in [DD] [HH:[MM:]]ss[.uuuuuu] format.\"",
        "    }",
        "    def target(self):",
        "        return self.default_error_messages",
        "",
        "def unrelated():",
        "    return 'duration field help text'",
      ].join("\n"),
    );

    const ctx = funcContext(wd, ["pkg/fields.py"], "Correct duration format [DD] [HH:[MM:]]ss[.uuuuuu] in the invalid error message.");
    expect(ctx).toContain("[DD] [HH:[MM:]]ss[.uuuuuu]");
    expect(ctx.indexOf("def target")).toBeLessThan(ctx.indexOf("def unrelated"));
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

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    expect(applyEdits(wd, "```diff\n--- a/src/demo.py\n+++ b/src/demo.py\n@@ -1 +1 @@\n-value = 1\n+value = 5\n```")).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 5\n");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    expect(applyEdits(wd, "### src/demo.py\n```python\nSEARCH\nvalue = 1\nREPLACE\nvalue = 6\n```")).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 6\n");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    writeFileSync(join(wd, "src/demo.py"), "def keep():\n    return 0\n\n\ndef target():\n    value = 1\n    return value\n");
    expect(applyEdits(wd, [
      "### src/demo.py",
      "<<<<<<< SEARCH",
      "def target():",
      "    value = old_value",
      "    return value",
      "=======",
      "def target():",
      "    value = 7",
      "    return value",
      ">>>>>>> REPLACE",
    ].join("\n"))).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toContain("def target():\n    value = 7\n    return value");
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toContain("def keep():\n    return 0");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    writeFileSync(
      join(wd, "src/demo.py"),
      [
        "class A:",
        "    def formfield(self, **kwargs):",
        "        return super().formfield(**{",
        "            'path': self.path,",
        "            'match': self.match,",
        "            **kwargs,",
        "        })",
        "",
        "class B:",
        "    def formfield(self, **kwargs):",
        "        return super().formfield(**kwargs)",
        "",
      ].join("\n"),
    );
    expect(applyEdits(wd, [
      "### src/demo.py",
      "<<<<<<< SEARCH",
      "    def formfield(self, **kwargs):",
      "        return super().formfield(**{",
      "            'match': self.match,",
      "            'path': self.path,",
      "            **kwargs,",
      "        })",
      "=======",
      "    def formfield(self, **kwargs):",
      "        path = self.path() if callable(self.path) else self.path",
      "        return super().formfield(**{",
      "            'path': path,",
      "            'match': self.match,",
      "            **kwargs,",
      "        })",
      ">>>>>>> REPLACE",
    ].join("\n"))).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toContain("path = self.path() if callable(self.path) else self.path");
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toContain("class B:\n    def formfield(self, **kwargs):\n        return super().formfield(**kwargs)");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    writeFileSync(join(wd, "src/demo.py"), "value = 1\n");
    expect(applyEdits(wd, "```python\nsrc/demo.py\n<<<<<<< SEARCH\nvalue = 1\n=======\nvalue = 8\n>>>>>>> REPLACE\n```")).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 8\n");

    execFileSync("git", ["checkout", "-q", "--", "src/demo.py"], { cwd: wd });
    writeFileSync(join(wd, "src/demo.py"), "value = 1\n");
    expect(applyEdits(wd, [
      "```python",
      "tests/test_demo.py",
      "<<<<<<< SEARCH",
      "=======",
      "def test_new():",
      "    assert True",
      ">>>>>>> REPLACE",
      "```",
      "",
      "```python",
      "src/demo.py",
      "<<<<<<< SEARCH",
      "value = 1",
      "=======",
      "value = 9",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n"))).toBe(1);
    expect(readFileSync(join(wd, "src/demo.py"), "utf8")).toBe("value = 9\n");
  });

  it("requires all oracle nodes before treating a candidate as solved", async () => {
    const { answerPass, classifyOracleResult, isSlowOrInfraNode, djangoNode } = await loadMjs<{
      answerPass: (candidate: { reproPass?: number; oraclePass?: number }, oracleTotal?: number) => number;
      classifyOracleResult: (
        nodes: string[],
        runnerResult: { passed: Set<string> },
        tbForNode: (node: string) => string,
      ) => { pass: number; passed: string[]; failed: string[]; infraFailed: string[] };
      isSlowOrInfraNode: (node: string) => boolean;
      djangoNode: (node: string) => string;
    }>("projects/swebench/select.mjs");

    expect(answerPass({ oraclePass: 1 }, 1)).toBe(1);
    expect(answerPass({ oraclePass: 1 }, 6)).toBe(0);
    expect(answerPass({ reproPass: 1, oraclePass: 0 }, 0)).toBe(1);

    const result = classifyOracleResult(
      ["test_new", "test_httpbin", "test_real_fail"],
      { passed: new Set(["test_new"]) },
      node => node === "test_httpbin" ? "socket.gaierror Temporary failure in name resolution" : "AssertionError: wrong value",
    );
    expect(result.pass).toBe(2);
    expect(result.failed).toEqual(["test_real_fail"]);
    expect(result.infraFailed).toEqual(["test_httpbin"]);

    expect(isSlowOrInfraNode("test_requests.py::RequestsTestCase::test_connection_error")).toBe(true);
    expect(isSlowOrInfraNode("test_requests.py::RequestsTestCase::test_basic_building")).toBe(false);
    expect(djangoNode("test_callable_path (model_fields.test_filepathfield.FilePathFieldTests)")).toBe(
      "model_fields.test_filepathfield.FilePathFieldTests.test_callable_path",
    );
  });

  it("threads exact failed oracle nodes through repair attempts", async () => {
    const { runRepairRung } = await loadMjs<{
      runRepairRung: (opts: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    }>("projects/swebench/repair.mjs");
    const wd = tempRepo();
    mkdirSync(join(wd, "pkg"), { recursive: true });
    writeFileSync(join(wd, "pkg/demo.py"), "value = 1\n");
    writeFileSync(join(wd, "test_demo.py"), "def test_a():\n    assert True\n\n\ndef test_b():\n    assert fixed\n");
    execFileSync("git", ["add", "pkg/demo.py", "test_demo.py"], { cwd: wd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: wd });

    const prompts: string[] = [];
    let oracleCalls = 0;
    const survivors = await runRepairRung({
      id: "demo__case-1",
      inst: { problem_statement: "fix demo", test_patch: "def test_a(): pass\ndef test_b(): pass" },
      wd,
      cands: ["pkg/demo.py"],
      ctx: "### pkg/demo.py\n```python\nvalue = 1\n```",
      oracle: { nodes: ["test_demo.py::test_a", "test_demo.py::test_b"], text: "FULL ORACLE TEXT\n```python\ndef test_b():\n    assert fixed\n```" },
      candidates: [{ diff: "diff --git a/pkg/demo.py b/pkg/demo.py\n", sr: "", oraclePass: 0, oracleFailed: ["test_demo.py::test_a", "test_demo.py::test_b"], broke: [], lintFindings: [] }],
      reset: () => execFileSync("git", ["checkout", "-q", "--", "."], { cwd: wd }),
      applyEdits: () => {
        writeFileSync(join(wd, "pkg/demo.py"), "value = 2\n");
        return 1;
      },
      diffCmd: () => execFileSync("git", ["diff", "--", "pkg"], { cwd: wd, encoding: "utf8" }),
      callLLM: async (messages: Array<{ content: string }>) => {
        prompts.push(messages.at(-1)?.content || "");
        return "### pkg/demo.py\n<<<<<<< SEARCH\nvalue = 1\n=======\nvalue = 2\n>>>>>>> REPLACE";
      },
      repairModel: "test-model",
      runner: { nodes: () => ({ failed: new Set() }), tb: () => "" },
      basePass: [],
      scoreRepro: () => 0,
      scoreOracle: () => 1,
      scoreOracleResult: () => {
        oracleCalls++;
        return oracleCalls === 1
          ? { pass: 1, passed: ["test_demo.py::test_a"], failed: ["test_demo.py::test_b"] }
          : { pass: 2, passed: ["test_demo.py::test_a", "test_demo.py::test_b"], failed: [] };
      },
      patchLint: () => [],
      issuePitfalls: "",
      log: () => undefined,
      maxRecords: 1,
      attempts: 2,
    });

    expect(survivors).toHaveLength(1);
    expect(prompts[0]).toContain("FULL ORACLE TEXT");
    expect(prompts[0]).toContain("passed no oracle nodes");
    expect(prompts[1]).toContain("- test_demo.py::test_b");
    expect(prompts[1]).toContain("FAILED ORACLE DETAIL");
    expect(prompts[1]).toContain("def test_b");
    expect(prompts[1]).not.toContain("- test_demo.py::test_a\n");
  });

  it("infers the target file for headerless repair SEARCH blocks", async () => {
    const { runRepairRung } = await loadMjs<{
      runRepairRung: (opts: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    }>("projects/swebench/repair.mjs");
    const { applyEdits } = await loadMjs<{ applyEdits: (wd: string, text: string) => number }>("projects/swebench/select.mjs");
    const wd = tempRepo();
    mkdirSync(join(wd, "pkg"), { recursive: true });
    writeFileSync(join(wd, "pkg/a.py"), "def keep():\n    return 1\n");
    writeFileSync(join(wd, "pkg/b.py"), "def target():\n    return 'old'\n");
    execFileSync("git", ["add", "pkg/a.py", "pkg/b.py"], { cwd: wd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: wd });

    const survivors = await runRepairRung({
      id: "demo__case-2",
      inst: { problem_statement: "fix target", test_patch: "" },
      wd,
      cands: ["pkg/a.py", "pkg/b.py"],
      ctx: "",
      oracle: { nodes: ["test_target"] },
      candidates: [{ applyFailed: true, rawOutput: "", diff: "", candidateFiles: ["pkg/a.py", "pkg/b.py"], oraclePass: 0, oracleFailed: ["test_target"], broke: [], lintFindings: [] }],
      reset: () => execFileSync("git", ["checkout", "-q", "--", "."], { cwd: wd }),
      applyEdits,
      diffCmd: () => execFileSync("git", ["diff", "--", "pkg"], { cwd: wd, encoding: "utf8" }),
      callLLM: async () => "<<<<<<< SEARCH\ndef target():\n    return 'old'\n=======\ndef target():\n    return 'new'\n>>>>>>> REPLACE",
      repairModel: "test-model",
      runner: { nodes: () => ({ failed: new Set() }), tb: () => "" },
      basePass: [],
      scoreRepro: () => 0,
      scoreOracle: () => 1,
      scoreOracleResult: () => ({ pass: 1, passed: ["test_target"], failed: [] }),
      patchLint: () => [],
      issuePitfalls: "",
      log: () => undefined,
      maxRecords: 1,
      attempts: 1,
    });

    expect(survivors).toHaveLength(1);
    expect(readFileSync(join(wd, "pkg/b.py"), "utf8")).toContain("return 'new'");
    expect(readFileSync(join(wd, "pkg/a.py"), "utf8")).toContain("return 1");
  });
});
