/**
 * calibrate-envelope.ts — measure `node_context_budget` for an executor.
 *
 *   pnpm calibrate-envelope [--chain cheap] [--sizes 4000,8000,16000,32000,48000] [--reps 3]
 *
 * The node-chunking fix sizes every node to the executor's effective working
 * envelope (chains.yaml: node_context_budget), REPLACING the old "1-12 nodes"
 * count anchor. That number is load-bearing and must be MEASURED, not guessed
 * (the plan calls calibration a prerequisite, not a follow-up). This script does
 * the measurement: it runs a trivial, unambiguous task whose ONLY difficulty is
 * that the answer is buried in a context of a controlled size, sweeps the size
 * up, and finds the knee where FIRST-TRY (rung-1) pass rate falls off. That knee
 * is the envelope — set chains.yaml `node_context_budget` just below it.
 *
 * The task: a "needle" file declares `MAGIC = <n>`; filler files pad the context
 * to the target token count. The node must read it and write src/answer.txt
 * containing MAGIC+1. The gate is a literal grep — no build/test toolchain, so a
 * failure means "couldn't hold the context", not "couldn't run the gate".
 *
 * LIVE: needs OPENROUTER_API_KEY and makes real calls; the human runs it. It is
 * NOT a CI gate.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { parseChains, resolveChain } from "../src/contract/schema.js";
import { estimateTokens } from "../src/harness/context.js";
import { runTask } from "../src/experiment/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_SIZES = [4000, 8000, 16000, 24000, 32000, 48000];
const KNEE_PASS_RATE = 0.8; // first-try pass rate the envelope must sustain

async function main(argv: string[]): Promise<number> {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) value.set(argv[i]!.slice(2), argv[++i] ?? "");
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY required — calibrate-envelope is a LIVE measurement (the human runs it)\n");
    return 1;
  }
  const chains = parseChains(readFileSync(join(ROOT, "chains.yaml"), "utf8"));
  const chainName = value.get("chain") ?? "cheap";
  const chain = resolveChain(chains, chainName);
  const sizes = (value.get("sizes")?.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)) ?? DEFAULT_SIZES;
  const reps = Math.max(1, Number(value.get("reps") ?? "3"));

  process.stdout.write(`calibrating node_context_budget for executor "${chain.executor}" (chain ${chainName})\n`);
  process.stdout.write(`sizes (tokens): ${sizes.join(", ")} | reps each: ${reps}\n`);

  const rows: { size: number; firstTry: number; reps: number; rate: number }[] = [];
  for (const size of sizes) {
    let firstTry = 0;
    for (let rep = 0; rep < reps; rep++) {
      // A fresh magic number per rep so a provider cache can't shortcut the read.
      const magic = 100000 + size + rep * 7;
      const pass = await runOne(chains, chainName, size, magic, apiKey);
      if (pass) firstTry += 1;
      process.stdout.write(`  size ${size} rep ${rep + 1}/${reps}: ${pass ? "first-try PASS" : "miss"}\n`);
    }
    const rate = firstTry / reps;
    rows.push({ size, firstTry, reps, rate });
    process.stdout.write(`size ${size}: first-try ${firstTry}/${reps} (${Math.round(rate * 100)}%)\n`);
  }

  // The envelope is the LARGEST size that still sustains the target first-try rate.
  const sustained = rows.filter((r) => r.rate >= KNEE_PASS_RATE).map((r) => r.size);
  const knee = sustained.length > 0 ? Math.max(...sustained) : 0;
  process.stdout.write(`\n--- ENVELOPE ---\n`);
  for (const r of rows) process.stdout.write(`  ${r.size}: ${Math.round(r.rate * 100)}% first-try\n`);
  if (knee > 0) {
    process.stdout.write(`\nlargest size sustaining >=${Math.round(KNEE_PASS_RATE * 100)}% first-try: ${knee} tokens\n`);
    process.stdout.write(`SET chains.yaml ${chainName}.node_context_budget to ~${knee} (a touch below the knee for headroom).\n`);
  } else {
    process.stdout.write(`\nNo size sustained the target first-try rate — start the sweep lower (e.g. --sizes 2000,4000,8000).\n`);
  }
  return 0;
}

/** Run ONE synthetic single-node mission live; return whether it passed on rung 1. */
async function runOne(
  chains: ReturnType<typeof parseChains>,
  chainName: string,
  targetTokens: number,
  magic: number,
  apiKey: string,
): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "calib-env-"));
  try {
    const fixtureDir = join(dir, "fixture");
    mkdirSync(join(fixtureDir, "ctx"), { recursive: true });
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    // The needle, buried among filler files padded to the target token count.
    writeFileSync(join(fixtureDir, "ctx", "needle.ts"), `export const MAGIC = ${magic};\n`);
    let filled = estimateTokens(`export const MAGIC = ${magic};\n`);
    let part = 0;
    while (filled < targetTokens) {
      const chunk = `// filler ${part}\n` + "export const PAD_" + part + " = '" + "x".repeat(2000) + "';\n";
      writeFileSync(join(fixtureDir, "ctx", `filler-${part}.ts`), chunk);
      filled += estimateTokens(chunk);
      part += 1;
    }
    const expected = magic + 1;
    const mission = {
      goal: "echo the magic number plus one",
      budget_usd: 0.5,
      chain: chainName,
      workdir: ".",
      nodes: [
        {
          id: "echo",
          brief:
            "Somewhere in the provided ctx/ files there is exactly one line of the form `export const MAGIC = <number>;`. " +
            "Find that number, add 1 to it, and write the result (the number only, nothing else) to src/answer.txt.",
          context_globs: ["ctx/**"],
          blast_radius: ["src/answer.txt"],
          done_check: `grep -qx "${expected}" src/answer.txt`,
          budget_usd: 0.5,
          // The whole point: cap the node's context at the size under test.
          max_context_tokens: targetTokens + 2000,
        },
      ],
    };
    const missionPath = join(dir, "mission.yaml");
    writeFileSync(missionPath, stringify(mission));
    const m = await runTask({
      task: { num: 0, name: "calib", dir, missionPath, fixtureDir, scriptsDir: dir },
      chainName,
      chains,
      mock: false,
      apiKey,
    });
    // First-try success = the node passed at rung 1 (no escalation needed).
    return m.completed && (m.rungHistogram["1"] ?? 0) >= 1 && (m.recoveredNodes ?? 0) === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c));
