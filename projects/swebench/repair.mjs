import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandRepairContext } from "./context-expand.mjs";
import { oracleContractHints } from "./contracts.mjs";

function classify(record, oracle) {
  if (record.applyFailed) return "apply_failed";
  if (record.lintFindings?.length) return "lint_failed";
  if (record.broke?.length) return "regression";
  if (oracle.nodes?.length && (record.oraclePass || 0) < oracle.nodes.length) return "oracle_miss";
  return "unknown";
}

function solvesTarget(record, oracle) {
  const oracleTotal = oracle.nodes?.length || 0;
  if (!oracleTotal) return (record.reproPass || 0) > 0;
  return (record.oraclePass || 0) >= oracleTotal;
}

function touchedFiles(diff) {
  return [
    ...diff.matchAll(/^\+\+\+ b\/(\S+)/gm),
    ...diff.matchAll(/###\s*([^\s`]+\.py)/gm),
    ...diff.matchAll(/\b((?:src|tests?|testing|requests|pylint|sympy)\/[A-Za-z0-9_./-]+\.py)\b/gm),
  ].map(m => m[1]);
}

function touchedPyFiles(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+\.py)$/gm)].map(m => m[1]);
}

function addCompileFailure(failed, runner, files) {
  const out = runner.compile?.(files);
  if (out) failed.add(`SER_COMPILE::${out.split("\n").find(Boolean) || "py_compile failed"}`);
}

function summarizeFailure(tb) {
  return (tb || "")
    .split("\n")
    .filter(l => /FAILED|ERROR|AssertionError|TypeError|ValueError|RuntimeError|^E\s|assert|Expected|DID NOT RAISE/.test(l))
    .slice(0, 24)
    .join("\n");
}

function testSource(wd, node) {
  const file = node.split("::")[0];
  const name = node.split("::").pop()?.replace(/\[.*$/, "");
  if (!file || !name || !existsSync(join(wd, file))) return "";
  const lines = readFileSync(join(wd, file), "utf8").split("\n");
  const start = lines.findIndex(l => new RegExp(`def ${name}\\b`).test(l));
  if (start < 0) return "";
  const indent = lines[start].match(/^\s*/)?.[0].length || 0;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() && (line.match(/^\s*/)?.[0].length || 0) <= indent) break;
  }
  return lines.slice(start, end).join("\n").slice(0, 2400);
}

function failedOracleDetail(wd, nodes) {
  if (!nodes?.length) return "(none)";
  const shown = nodes.slice(0, 5);
  return shown
    .map(n => {
      const src = testSource(wd, n);
      return src ? `# ${n}\n\`\`\`python\n${src}\n\`\`\`` : `# ${n}\n(source unavailable)`;
    })
    .join("\n\n");
}

function oracleTraceDetail(runner, nodes, label) {
  if (!nodes?.length || !runner?.tb) return "";
  let tb = "";
  try {
    tb = summarizeFailure(runner.tb(nodes.slice(0, 3)));
  } catch {
    tb = "";
  }
  return tb ? `Traceback summary for failed oracle nodes (${label}):\n${tb}` : "";
}

function failedRegressionDetail(wd, nodes) {
  const sources = (nodes || [])
    .slice(0, 5)
    .map(n => {
      const src = testSource(wd, n);
      return src ? `# ${n}\n\`\`\`python\n${src}\n\`\`\`` : `# ${n}\n(source unavailable)`;
    })
    .join("\n\n");
  return sources || "(none)";
}

function oracleAssertionProbes(inst, limit = 4) {
  const patch = inst.test_patch || "";
  const probes = [];
  let inTest = false;
  let setup = [];
  for (const raw of patch.split("\n")) {
    if (!/^[ +]/.test(raw)) continue;
    const prefix = raw[0];
    const line = raw.slice(1);
    if (/^\s*def test_/.test(line)) {
      inTest = true;
      setup = [];
      continue;
    }
    if (!inTest) continue;
    if (/^\s*def test_/.test(line) || /^diff --git /.test(line)) {
      inTest = false;
      setup = [];
      continue;
    }
    const body = line.replace(/^    /, "");
    if (!body.trim()) continue;
    if (prefix === "+" && /^\s*assert\s+/.test(body)) {
      probes.push({ setup: setup.join("\n"), expr: body.replace(/^\s*assert\s+/, "").trim() });
      if (probes.length >= limit) break;
    } else if (!/^\s*assert\s+/.test(body)) {
      setup.push(body);
    }
  }
  return probes;
}

function oracleAssertionObservation(inst, runner, label = "current tree") {
  const probes = oracleAssertionProbes(inst);
  if (!probes.length || !runner?.py) return "";
  const pkg = (inst.repo || "").split("/")[1]?.replace(/-/g, "_") || "";
  const setupImports = [
    "import traceback",
    pkg ? `try:\n    import ${pkg}\nexcept Exception as e:\n    print("IMPORT ${pkg} failed", repr(e))` : "",
    pkg ? `try:\n    from ${pkg} import *\nexcept Exception:\n    pass` : "",
    "try:\n    n, m, i, j, k, x, y, z, t, a, b = symbols('n m i j k x y z t a b')\nexcept Exception:\n    pass",
  ].filter(Boolean).join("\n");
  const code = `${setupImports}

def _show(label, expr, ns):
    print("=== " + label + " ===")
    print("expr:", expr)
    try:
        value = eval(expr, ns, ns)
        print("value:", repr(value))
        try: print("type:", type(value).__name__)
        except Exception: pass
        try: print("doit:", repr(value.doit()))
        except Exception: pass
    except Exception as e:
        print("raised:", type(e).__name__ + ": " + str(e))

def _run():
${probes.map((p, i) => {
  const setup = p.setup.trim() ? p.setup.split("\n").map(l => `    ${l}`).join("\n") : "    pass";
  const expr = JSON.stringify(p.expr);
  const parts = [];
  const eq = p.expr.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (eq) {
    parts.push(eq[1].trim(), eq[3].trim(), p.expr);
  } else {
    parts.push(p.expr);
  }
  return `    ns = globals().copy()
    try:
${setup.split("\n").map(l => `        ${l.replace(/^    /, "")}`).join("\n")}
    except Exception as e:
        print("=== probe ${i + 1} setup failed ===")
        print(type(e).__name__ + ": " + str(e))
        return
    locals().update(ns)
${parts.map((part, j) => `    _show("probe ${i + 1}.${j + 1}", ${JSON.stringify(part)}, locals())`).join("\n")}`;
}).join("\n")}

_run()
`;
  const out = runner.py(code).trim();
  return out ? `ORACLE ASSERTION OBSERVATIONS (${label}; executed from oracle test setup in the target environment):\n${out}` : "";
}

function searchBlocks(text) {
  const blocks = [];
  for (const m of text.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>> REPLACE/g)) {
    blocks.push(m[1]);
  }
  for (const m of text.matchAll(/```(?:python)?\s*SEARCH\n([\s\S]*?)\nREPLACE\n[\s\S]*?```/g)) {
    blocks.push(m[1]);
  }
  for (const m of text.matchAll(/SEARCH(?:\s+[^\n`]+\.py)?\n```(?:python)?\s*([\s\S]*?)```\s*REPLACE\n```(?:python)?\s*[\s\S]*?```/g)) {
    blocks.push(m[1]);
  }
  return blocks.map(b => b.trim()).filter(Boolean);
}

function inferFileForPatch(wd, files, text) {
  const searches = searchBlocks(text);
  if (!searches.length) return "";
  const matches = [];
  for (const file of files) {
    const path = join(wd, file);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    if (searches.some(search => body.includes(search) || body.includes(search.trimEnd()))) {
      matches.push(file);
    }
  }
  return [...new Set(matches)].length === 1 ? matches[0] : "";
}

function productionFiles(files = []) {
  return [...new Set(files)].filter(f =>
    f.endsWith(".py") &&
    !/(^|\/)(tests?|testing)\//.test(f) &&
    !/(^|\/)test_[^/]+\.py$/.test(f)
  );
}

export async function runRepairRung(opts) {
  const {
    id, inst, wd, cands, ctx, oracle, candidates, reset, applyEdits, diffCmd,
    callLLM, repairModel, runner, basePass, scoreRepro, scoreOracle, scoreOracleResult, patchLint,
    issuePitfalls, tracePath, log, maxRecords = 2, attempts = 2,
  } = opts;
  if (!candidates.length || attempts <= 0) return [];

  const ranked = [...candidates]
    .map(r => ({ ...r, classification: classify(r, oracle) }))
    .sort((a, b) =>
      ((b.oraclePass || 0) - (a.oraclePass || 0)) ||
      ((b.reproPass || 0) - (a.reproPass || 0)) ||
      ((a.broke?.length || 0) - (b.broke?.length || 0)) ||
      ((a.lintFindings?.length || 0) - (b.lintFindings?.length || 0))
    )
    .slice(0, maxRecords);

  const survivors = [];
  const contractHints = oracleContractHints(inst.test_patch || "");
  const contract = oracle.text || contractHints;
  const sys = "You are repairing a Python library patch. The previous patch failed a gate. Output ONLY complete Aider SEARCH/REPLACE blocks against the ORIGINAL production source files. Do not edit tests, do not copy REQUIRED CONTRACT snippets into tests, and do not output prose. SEARCH must copy exact current lines from RELEVANT CODE or the original source; do not invent an alternate implementation. Fix the root cause, satisfy the required contract, and preserve the failed/regressed behavior.";

  for (const record of ranked) {
    const expandedCtx = expandRepairContext(wd, cands, ctx, record.diff || record.sr || "", 60000);
    const failedTestNodes = (record.broke || []).filter(n => !n.startsWith("SER_PATCH_LINT::"));
    const tb = failedTestNodes.length ? runner.tb(failedTestNodes.slice(0, 2)) : "";
    const baseInput = {
      instance: id,
      rung: "repair",
      classification: record.classification,
      touchedFiles: touchedFiles(record.diff || ""),
      oracle: { passed: record.oraclePass || 0, total: oracle.nodes?.length || 0 },
      oracleFailed: record.oracleFailed || (oracle.nodes?.length && (record.oraclePass || 0) < oracle.nodes.length ? oracle.nodes : []),
      failedTests: failedTestNodes,
      lintFindings: record.lintFindings || [],
    };

    let current = { ...record };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const failedPatch = current.diff || current.rawOutput || "";
      const failedOracleNodes = current.oracleFailed || baseInput.oracleFailed || [];
      const oracleDetail = failedOracleDetail(wd, failedOracleNodes);
      const regressionDetail = failedRegressionDetail(wd, current.broke || []);
      const editableFiles = productionFiles([...(record.candidateFiles || []), ...touchedFiles(record.diff || record.rawOutput || "")]);
      const missGuidance = oracle.nodes?.length && !(current.oraclePass || 0)
        ? "\nThe previous patch passed no oracle nodes; it may be aimed at the wrong helper. Do not preserve its target or structure unless it directly matches the REQUIRED CONTRACT."
        : "";
      reset();
      const baseOracleTrace = oracleTraceDetail(runner, failedOracleNodes, "base tree before candidate");
      const baseObservation = oracleAssertionObservation(inst, runner, "base tree before candidate");
      let candidateOracleTrace = "";
      let candidateObservation = "";
      if (failedPatch.trim()) {
        reset();
        if (applyEdits(wd, failedPatch)) {
          candidateOracleTrace = oracleTraceDetail(runner, failedOracleNodes, "after failed candidate patch");
          candidateObservation = oracleAssertionObservation(inst, runner, "after failed candidate patch");
        }
      }
      reset();
      const oracleRuntimeDetail = [baseOracleTrace, candidateOracleTrace, baseObservation, candidateObservation].filter(Boolean).join("\n\n");
      const user = `ISSUE:\n${inst.problem_statement.slice(0, 2500)}${issuePitfalls}\n\nWHY THE PREVIOUS PATCH FAILED:\nclassification: ${current.classification}\noracle: ${(current.oraclePass || 0)}/${oracle.nodes?.length || 0}${missGuidance}\nfailed oracle nodes:\n${failedOracleNodes.length ? failedOracleNodes.map(n => `- ${n}`).join("\n") : "(none captured)"}\nfailed regression tests: ${(current.broke || []).join(", ") || "(none captured)"}\nlints:\n${(current.lintFindings || []).map(x => `- ${x}`).join("\n") || "(none)"}\ntraceback summary:\n${summarizeFailure(tb) || "(none captured)"}\n\nFAILED REGRESSION DETAIL - THIS PREVIOUSLY PASSING BEHAVIOR MUST BE PRESERVED:\n${regressionDetail}\n\nFAILED ORACLE DETAIL - THESE ARE THE CURRENT BLOCKERS:\n${oracleDetail}${oracleRuntimeDetail ? `\n\n${oracleRuntimeDetail}` : ""}\n\nPassing only an added test from the patch is incomplete. The corrected patch must make every failed oracle node above pass while preserving existing passing behavior.\n\nEDITABLE PRODUCTION FILES:\n${editableFiles.length ? editableFiles.map(f => `- ${f}`).join("\n") : "(use only production files shown in RELEVANT CODE)"}\n\nREQUIRED CONTRACT:\n${contract || "(derive from issue and tests)"}\n\nRELEVANT CODE:\n${expandedCtx}\n\nFAILED PATCH OR MODEL OUTPUT (diagnostic only; ignore if it conflicts with the contract/current source):\n\`\`\`\n${failedPatch.slice(0, 14000)}\n\`\`\`\n\nReturn the corrected complete patch as Aider SEARCH/REPLACE blocks against ORIGINAL production files only.`;
      let text = await callLLM([{ role: "system", content: sys }, { role: "user", content: user }], attempt * 0.2, repairModel);
      const files = editableFiles;
      if (!/###\s*\S+\.py/.test(text) && (/<<<<<<< SEARCH/.test(text) || /(?:^|\n)SEARCH\n/.test(text))) {
        const inferred = files.length === 1 ? files[0] : inferFileForPatch(wd, files, text);
        if (inferred) text = `### ${inferred}\n${text}`;
      }
      reset();
      const applied = applyEdits(wd, text);
      if (!applied) {
        appendTrace(tracePath, { ...baseInput, attempt, result: "apply_failed", rawOutput: text.slice(0, 12000) });
        continue;
      }
      const diff = diffCmd();
      if (!diff.trim()) {
        appendTrace(tracePath, { ...baseInput, attempt, result: "empty_diff" });
        continue;
      }
      const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
      addCompileFailure(failed, runner, touchedPyFiles(diff));
      const lintFindings = patchLint(inst.problem_statement, diff);
      for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
      const reproPass = scoreRepro();
      const oracleResult = scoreOracleResult ? scoreOracleResult() : {
        pass: scoreOracle(),
        failed: oracle.nodes?.length ? oracle.nodes : [],
      };
      const oraclePass = oracleResult.pass;
      const trace = {
        ...baseInput,
        attempt,
        outputPatch: diff,
        result: {
          applied,
          lint: lintFindings.length ? "fail" : "pass",
          lintFindings,
          regressions: [...failed],
          oracle: `${oraclePass}/${oracle.nodes?.length || 0}`,
          oracleFailed: oracleResult.failed || [],
          reproPass,
        },
      };
      appendTrace(tracePath, trace);
      log(`  [${id.replace("psf__requests-", "#")}] REPAIR attempt ${attempt}: regressions=${failed.size}, oraclePass=${oraclePass}/${oracle.nodes?.length || 0}, lints=${lintFindings.length}`);
      if (failed.size === 0 && solvesTarget({ reproPass, oraclePass }, oracle)) {
        survivors.push({
          diff,
          sr: text.match(/###[\s\S]*?>>>>>>> REPLACE/g)?.join("\n\n") || "",
          reproPass,
          oraclePass,
          broke: [],
          norm: diff.replace(/\s+/g, " ").trim(),
          size: diff.split("\n").length,
          repairedByRung: true,
        });
        return survivors;
      }
      current = {
        ...current,
        diff,
        rawOutput: text,
        classification: lintFindings.length ? "lint_failed" : failed.size ? "regression" : "oracle_miss",
        lintFindings,
        broke: [...failed],
        oracleFailed: oracle.nodes?.length && oraclePass < oracle.nodes.length ? oracleResult.failed || oracle.nodes : [],
        oraclePass,
        reproPass,
      };
    }
  }
  return survivors;
}

function appendTrace(tracePath, event) {
  if (!tracePath) return;
  appendFileSync(tracePath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

export function writeRepairRecords(tracePath, records) {
  if (!tracePath) return;
  writeFileSync(tracePath, records.map(r => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

export { oracleAssertionProbes, oracleAssertionObservation };
