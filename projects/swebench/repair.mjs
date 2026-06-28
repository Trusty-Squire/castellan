import { appendFileSync, writeFileSync } from "node:fs";
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

function touchedFiles(diff) {
  return [
    ...diff.matchAll(/^\+\+\+ b\/(\S+)/gm),
    ...diff.matchAll(/###\s*([^\s`]+\.py)/gm),
    ...diff.matchAll(/\b((?:src|tests?|testing|requests|pylint|sympy)\/[A-Za-z0-9_./-]+\.py)\b/gm),
  ].map(m => m[1]);
}

function summarizeFailure(tb) {
  return (tb || "")
    .split("\n")
    .filter(l => /FAILED|ERROR|AssertionError|TypeError|ValueError|RuntimeError|^E\s|assert|Expected|DID NOT RAISE/.test(l))
    .slice(0, 24)
    .join("\n");
}

export async function runRepairRung(opts) {
  const {
    id, inst, wd, cands, ctx, oracle, candidates, reset, applyEdits, diffCmd,
    callLLM, repairModel, runner, basePass, scoreRepro, scoreOracle, patchLint,
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
  const contract = oracleContractHints(inst.test_patch || "");
  const sys = "You are repairing a Python library patch. The previous patch failed a gate. Output ONLY complete Aider SEARCH/REPLACE blocks against the ORIGINAL source files. Do not output prose. SEARCH must match the original file. Fix the root cause, satisfy the required contract, and preserve the failed/regressed behavior.";

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
      failedTests: failedTestNodes,
      lintFindings: record.lintFindings || [],
    };

    let current = { ...record };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const failedPatch = current.diff || current.rawOutput || "";
      const user = `ISSUE:\n${inst.problem_statement.slice(0, 2500)}${issuePitfalls}\n\nWHY THE PREVIOUS PATCH FAILED:\nclassification: ${current.classification}\noracle: ${(current.oraclePass || 0)}/${oracle.nodes?.length || 0}\nfailed tests: ${(current.broke || []).join(", ") || "(none captured)"}\nlints:\n${(current.lintFindings || []).map(x => `- ${x}`).join("\n") || "(none)"}\ntraceback summary:\n${summarizeFailure(tb) || "(none captured)"}\n\nREQUIRED CONTRACT:\n${contract || "(derive from issue and tests)"}\n\nFAILED PATCH OR MODEL OUTPUT:\n\`\`\`\n${failedPatch.slice(0, 14000)}\n\`\`\`\n\nRELEVANT CODE:\n${expandedCtx}\n\nReturn the corrected complete patch as Aider SEARCH/REPLACE blocks against ORIGINAL files.`;
      let text = await callLLM([{ role: "system", content: sys }, { role: "user", content: user }], attempt * 0.2, repairModel);
      const mentionedFiles = touchedFiles(record.diff || record.rawOutput || "");
      const files = [...new Set(mentionedFiles.length ? mentionedFiles : (record.candidateFiles || []))];
      if (!/###\s*\S+\.py/.test(text) && /<<<<<<< SEARCH/.test(text) && files.length === 1) {
        text = `### ${files[0]}\n${text}`;
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
      const lintFindings = patchLint(inst.problem_statement, diff);
      for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
      const reproPass = scoreRepro();
      const oraclePass = scoreOracle();
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
          reproPass,
        },
      };
      appendTrace(tracePath, trace);
      log(`  [${id.replace("psf__requests-", "#")}] REPAIR attempt ${attempt}: regressions=${failed.size}, oraclePass=${oraclePass}/${oracle.nodes?.length || 0}, lints=${lintFindings.length}`);
      if (failed.size === 0 && (oracle.nodes?.length ? oraclePass > 0 : reproPass > 0)) {
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
