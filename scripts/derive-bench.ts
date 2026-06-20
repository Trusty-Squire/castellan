/**
 * derive-bench (SPEC-v0.2 §9.1) — the planner tax, measured.
 *
 * For each benchmark task: feed deriveV2 the task's GOAL text + a fresh
 * fixture copy (zero hand-edits), run the DERIVED mission on the cheap chain,
 * and compare node completion against the hand-written baseline (= 100%).
 *
 *   pnpm derive-bench [--tasks 1..20] [--chain cheap]
 *
 * LIVE: needs OPENROUTER_API_KEY; the human runs it. Success gate: derived
 * completion >= 90% of baseline. Kill condition: tax > 25 points after one
 * focused iteration.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { parseChains, parseMission, resolveChain } from "../src/contract/schema.js";
import { deriveV2 } from "../src/contract/derive2.js";
import { OpenRouterClient } from "../src/llm/openrouter.js";
import { discoverTasks, selectTasks } from "../src/experiment/tasks.js";
import { runTask } from "../src/experiment/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main(argv: string[]): Promise<number> {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) value.set(argv[i]!.slice(2), argv[++i] ?? "");
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY required — derive-bench is a LIVE measurement (the human runs it)\n");
    return 1;
  }
  const chains = parseChains(readFileSync(join(ROOT, "chains.yaml"), "utf8"));
  const chainName = value.get("chain") ?? "cheap";
  const chain = resolveChain(chains, chainName);
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });

  const tasks = selectTasks(discoverTasks(join(ROOT, "tasks")), parseNums(value.get("tasks")));
  const outDir = join(ROOT, "results", `derive-bench-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });

  const rows: { task: string; derived: boolean; refused: string; nodesPassed: number; nodesBaseline: number; nodesDerived: number; costUsd: number }[] = [];

  for (const task of tasks) {
    const baseline = parseMission(readFileSync(task.missionPath, "utf8"));
    process.stdout.write(`\n=== ${task.name} ===\n`);

    // 1. derive from GOAL TEXT only, against a fixture copy
    const fixtureCopy = mkdtempSync(join(tmpdir(), `derive-bench-${task.num}-`));
    cpSync(task.fixtureDir, fixtureCopy, { recursive: true });
    const derived = await deriveV2({
      goal: baseline.goal,
      workdir: fixtureCopy,
      llm,
      model: chain.executor,
      chainName,
      budgetUsd: baseline.budget_usd,
      // Size nodes to the calibrated executor envelope (no "1-12" count anchor).
      executorModel: chain.executor,
      nodeContextBudget: chain.node_context_budget,
    });

    if (!derived.ok) {
      process.stdout.write(`  REFUSED: ${derived.reasons.join("; ")}\n`);
      rows.push({ task: task.name, derived: false, refused: derived.reasons[0] ?? "?", nodesPassed: 0, nodesBaseline: baseline.nodes.length, nodesDerived: 0, costUsd: 0 });
      continue;
    }

    // 2. write the derived mission as a temp task and execute it (zero hand-edits)
    const derivedDir = join(outDir, task.name);
    mkdirSync(derivedDir, { recursive: true });
    const derivedMissionPath = join(derivedDir, "mission.yaml");
    writeFileSync(derivedMissionPath, stringify(derived.mission));
    writeFileSync(join(derivedDir, "readback.txt"), derived.readback);

    const m = await runTask({
      task: { ...task, missionPath: derivedMissionPath },
      chainName,
      chains,
      mock: false,
      apiKey,
      runId: `derive-bench`,
      resultsDir: outDir,
    });
    rows.push({ task: task.name, derived: true, refused: "", nodesPassed: m.nodesPassed, nodesBaseline: baseline.nodes.length, nodesDerived: derived.mission.nodes.length, costUsd: m.costUsd });
    process.stdout.write(`  derived nodes: ${derived.mission.nodes.length}; completed ${m.nodesPassed} (baseline mission has ${baseline.nodes.length})\n`);
  }

  // The planner tax: derived completion vs hand-written baseline (100% on this suite).
  const baselineNodes = rows.reduce((s, r) => s + r.nodesBaseline, 0);
  const derivedPassed = rows.reduce((s, r) => s + r.nodesPassed, 0);
  const pct = baselineNodes === 0 ? 0 : Math.round((derivedPassed / baselineNodes) * 100);
  process.stdout.write(`\n--- PLANNER TAX ---\n`);
  process.stdout.write(`derived-mission completion: ${derivedPassed}/${baselineNodes} baseline nodes (${pct}%)\n`);
  process.stdout.write(`planner tax: ${100 - pct} points (success gate: <=10; kill condition: >25 after one iteration)\n`);
  process.stdout.write(`spurious refusals: ${rows.filter((r) => !r.derived).length} (success gate #3 false-positive check: <=1)\n`);

  // SIZING EVAL (the node-chunking fix's real test): with the "1-12" count anchor
  // gone, the derived node COUNT should track task SIZE, not cluster at a fixed
  // number. Proxy for size = the hand-written baseline's node count. We report the
  // rank correlation (derived-count vs baseline-count) and the spread of derived
  // counts — a near-zero spread is the anchor's fingerprint (every task → ~same N).
  const sized = rows.filter((r) => r.derived);
  if (sized.length >= 3) {
    const baseCounts = sized.map((r) => r.nodesBaseline);
    const derCounts = sized.map((r) => r.nodesDerived);
    const rho = spearman(baseCounts, derCounts);
    const spread = stdev(derCounts);
    process.stdout.write(`\n--- NODE SIZING (anchor removed) ---\n`);
    for (const r of sized) process.stdout.write(`  ${r.task}: baseline ${r.nodesBaseline} → derived ${r.nodesDerived}\n`);
    process.stdout.write(`count-vs-size rank correlation (Spearman ρ): ${rho.toFixed(2)} (want > 0; the count should rise with task size)\n`);
    process.stdout.write(`derived-count spread (stdev): ${spread.toFixed(2)} (near-zero = the old anchor's fingerprint, every task → same N)\n`);
  }
  process.stdout.write(`artifacts: ${outDir}\n`);
  return 0;
}

/** Population stdev — a near-zero spread of derived node counts is the count-anchor's tell. */
function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

/** Spearman rank correlation — does the derived count rise with task size? Ties get average ranks. */
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const order = xs.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
    const ranks = new Array<number>(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]!.x === order[i]!.x) j++;
      const avg = (i + j) / 2 + 1; // 1-based average rank across the tie group
      for (let k = i; k <= j; k++) ranks[order[k]!.i] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n + 1) / 2;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i]! - mean) * (rb[i]! - mean);
    va += (ra[i]! - mean) ** 2;
    vb += (rb[i]! - mean) ** 2;
  }
  return va === 0 || vb === 0 ? 0 : cov / Math.sqrt(va * vb);
}

function parseNums(spec: string | undefined): number[] {
  if (!spec) return [];
  const nums = new Set<number>();
  for (const part of spec.split(",")) {
    const range = part.match(/^(\d+)\s*(?:\.\.|-)\s*(\d+)$/);
    if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) nums.add(i);
    else if (/^\d+$/.test(part.trim())) nums.add(Number(part.trim()));
  }
  return [...nums].sort((a, b) => a - b);
}

main(process.argv.slice(2)).then((c) => process.exit(c));
