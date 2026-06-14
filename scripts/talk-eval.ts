/**
 * `pnpm talk-eval` — LIVE conversation eval for `ser talk`.
 *
 * Simulated-user agents drive the REAL SpecSession against the real cheap model
 * across several product scenarios; each transcript is scored by the mostly-
 * mechanical rubric in src/eval/talk-eval.ts and printed as a table. This is the
 * automated replacement for hand-dogfooding — a number for "is the conversation
 * serviceable", and a regression net. Network-required; never part of `pnpm test`.
 *
 * Usage: pnpm talk-eval [--scenario <id>] [--user-model <slug>]
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { OpenRouterClient } from "../src/llm/openrouter.js";
import { ClaudeCliClient } from "../src/llm/claude-cli.js";
import type { LlmClient } from "../src/llm/types.js";
import { resolveChains } from "../src/contract/derive.js";
import { resolveChain } from "../src/contract/schema.js";
import { SpecSession } from "../src/contract/spec-session.js";
import { blankSpec, stripTrailingQuestion } from "../src/contract/talk.js";
import { extractIdea } from "../src/contract/ingest.js";
import { ideaToTalkSpec, renderSeed } from "../src/contract/brief.js";
import { scoreSpec } from "../src/contract/spec-score.js";
import { loadDotEnv } from "../src/env.js";
import type { Spec } from "../src/contract/spec.js";
import {
  SCENARIOS,
  scoreTranscript,
  simUserMessage,
  judgeProcess,
  processScore,
  specQuality,
  generateVanillaSpec,
  judgeSpecPair,
  blindAssign,
  type Scenario,
  type EvalTurn,
  type Transcript,
  type RunDeps,
} from "../src/eval/talk-eval.js";

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
/** Fixed-width table from a header + rows. */
function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (c: string[]): string => c.map((x, i) => x.padEnd(w[i]!)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

function blockingCount(spec: { open_questions: { blocking: boolean }[] }): number {
  return spec.open_questions.filter((q) => q.blocking).length;
}

async function runScenario(scenario: Scenario, deps: RunDeps): Promise<{ transcript: Transcript; finalSpec: Spec }> {
  writeFileSync(deps.specPath, yamlStringify(blankSpec()));
  const session = new SpecSession({
    path: deps.specPath,
    llm: deps.mapperLlm,
    executorModel: deps.mapperModel,
    knightModel: deps.knightModel,
    git: false,
  });

  const turns: EvalTurn[] = [];
  let userMsg = scenario.idea;
  let lastAssistant = "";

  for (let i = 0; i < scenario.maxTurns; i++) {
    if (scenario.showPlanTurn === i + 1) userMsg = "show me the architecture and components";

    let turn: EvalTurn;
    try {
      if (i === 0) {
        // turn 1 mirrors the REPL seed path (idea phase), not the mapper
        const idea = await extractIdea(userMsg, deps.mapperLlm, deps.mapperModel);
        writeFileSync(deps.specPath, yamlStringify(ideaToTalkSpec(userMsg, idea)));
        const spec = session.load();
        lastAssistant = renderSeed(idea);
        turn = {
          user: userMsg,
          reply: lastAssistant,
          asked: "",
          action: "none",
          presentedPlan: false,
          blockingAfter: blockingCount(spec),
          ready: (await scoreSpec(spec)).ready,
        };
      } else {
        const batch = await session.turn(userMsg);
        if (!batch.pivot && batch.deltas.length > 0) await session.acceptLenient(batch);
        await session.reconcile().catch(() => []);
        await session.captureDecisions(userMsg).catch(() => []); // A40: record stated constraints
        const spec = session.load();
        const blockingAfter = blockingCount(spec);
        let reply = batch.reply;
        if (blockingAfter === 0) reply = stripTrailingQuestion(reply);
        lastAssistant = reply || (batch.action === "status" ? "(plan shown)" : "");
        turn = {
          user: userMsg,
          reply,
          asked: batch.question,
          action: batch.action,
          presentedPlan: batch.action === "status",
          blockingAfter,
          ready: (await scoreSpec(spec)).ready,
        };
      }
    } catch (err) {
      process.stderr.write(`  turn ${i + 1} errored: ${(err as Error).message.split("\n")[0]}\n`);
      break;
    }
    turns.push(turn);
    process.stderr.write(`  t${i + 1} [${turn.action}] you: ${userMsg.slice(0, 50)}\n`);

    // next user message (unless the showPlan override will replace it next loop)
    userMsg = (await simUserMessage(scenario, lastAssistant, deps).catch(() => "")) || "tell me more";
  }

  const finalSpec = session.load();
  return {
    transcript: { scenarioId: scenario.id, turns, finalDecisions: finalSpec.decisions.map((d) => d.statement) },
    finalSpec,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : undefined;
  const userModelOverride = args.includes("--user-model") ? args[args.indexOf("--user-model") + 1] : undefined;

  // Worker selection (A39): default to the Claude Code subscription (free-ish),
  // not the metered OpenRouter grant. Haiku is the engine under test; a stronger
  // Claude judges + plays the simulated user.
  const worker = args.includes("--worker") ? args[args.indexOf("--worker") + 1] : "claude";
  let llm: LlmClient;
  let mapperModel: string;
  let richModel: string;
  if (worker === "openrouter") {
    loadDotEnv(process.cwd());
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY required for --worker openrouter");
    llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
    const { chains } = resolveChains(process.cwd());
    const chain = resolveChain(chains, "cheap");
    mapperModel = chain.executor;
    richModel = userModelOverride ?? chain.knight;
  } else {
    llm = new ClaudeCliClient();
    mapperModel = "claude-haiku-4-5"; // the cheap engine under test
    richModel = userModelOverride ?? "claude-sonnet-4-6"; // judges + simulated user
  }
  process.stderr.write(`worker: ${worker}  (mapper=${mapperModel}, judge/user=${richModel})\n`);

  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenario matched "${only}"`);
  // --mechanical: skip the slow, high-variance LLM judges and gate on the
  // deterministic Tier-2 lift alone — fast, stable signal for tuning edits.
  const mechanicalOnly = args.includes("--mechanical");

  interface Row {
    si: number;
    t1: string[];
    t2: string[];
    serWon: "ser" | "vanilla" | "tie" | null;
    lift: number;
    dump: unknown;
  }

  async function evalScenario(scenario: Scenario, si: number): Promise<Row> {
    const dir = mkdtempSync(join(tmpdir(), `talk-eval-${scenario.id}-`));
    const deps: RunDeps = {
      mapperLlm: llm,
      mapperModel,
      knightModel: richModel,
      userLlm: llm,
      userModel: richModel,
      specPath: join(dir, "eval.spec.yaml"),
    };
    const { transcript, finalSpec } = await runScenario(scenario, deps);
    const mech = scoreTranscript(scenario, transcript);
    const pj = mechanicalOnly ? null : await judgeProcess(scenario, transcript, llm, richModel).catch(() => null);
    const vanilla = await generateVanillaSpec(scenario, llm, mapperModel);
    const serQ = specQuality(finalSpec, scenario);
    const vanQ = specQuality(vanilla, scenario);
    const { a, b, serIs } = blindAssign(finalSpec, vanilla, si % 2 === 1);
    const verdict = mechanicalOnly ? null : await judgeSpecPair(scenario.idea, a, b, llm, richModel).catch(() => null);
    let serWon: Row["serWon"] = null;
    if (verdict) serWon = verdict.winner === "tie" ? "tie" : verdict.winner === serIs ? "ser" : "vanilla";
    const lift = serQ.composite - vanQ.composite;
    process.stderr.write(`  ✓ ${scenario.id}: lift ${lift >= 0 ? "+" : ""}${lift}\n`);
    return {
      si,
      t1: [scenario.id, pct(mech.factsRecorded), String(mech.reasks), String(mech.askedWhenSettled), mech.turnsToBuildable === null ? "—" : `t${mech.turnsToBuildable}`, pj ? `${pj.forks}/${pj.captured}/${pj.defaulted}/${pj.coherence}` : "n/a", String(processScore(mech, pj))],
      t2: [scenario.id, `${serQ.composite} vs ${vanQ.composite}`, (lift >= 0 ? "+" : "") + lift, `${pct(serQ.gateCoverage)}/${pct(vanQ.gateCoverage)}`, `${pct(serQ.factCoverage)}/${pct(vanQ.factCoverage)}`, serWon === null ? "n/a" : serWon === "ser" ? "ser ✓" : serWon === "vanilla" ? "VANILLA" : "tie"],
      serWon,
      lift,
      dump: { scenario: scenario.id, transcript, mech, processJudge: pj, serQ, vanQ, verdict, vanilla },
    };
  }

  process.stderr.write(`running ${scenarios.length} scenario(s) in parallel${mechanicalOnly ? " [mechanical-only]" : ""}…\n`);
  const rows = (await Promise.all(scenarios.map((s, i) => evalScenario(s, i)))).sort((x, y) => x.si - y.si);

  const serWins = rows.filter((r) => r.serWon === "ser").length;
  const judged = rows.filter((r) => r.serWon !== null).length;
  const meanLift = Math.round(rows.reduce((s, r) => s + r.lift, 0) / rows.length);

  process.stdout.write("\n══ TIER 1 — process quality (did it extract the right decisions?) ══\n");
  process.stdout.write(table(["scenario", "facts", "reask", "incoh", "build@", "judge f/c/d/c", "score"], rows.map((r) => r.t1)) + "\n");
  process.stdout.write("\n══ TIER 2 — output vs same-facts vanilla one-shot (the ablation) ══\n");
  process.stdout.write(table(["scenario", "ser vs van", "lift", "gates s/v", "facts s/v", "judge"], rows.map((r) => r.t2)) + "\n");
  process.stdout.write(`\nMEAN LIFT: ${meanLift >= 0 ? "+" : ""}${meanLift}` + (judged > 0 ? `   |   judge wins ${serWins}/${judged}` : "") + "\n");

  mkdirSync(join(process.cwd(), "results"), { recursive: true });
  const out = join(process.cwd(), "results", `talk-eval-${scenarios.length}-scenarios.json`);
  writeFileSync(out, JSON.stringify(rows.map((r) => r.dump), null, 2));
  process.stderr.write(`\ntranscripts → ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`talk-eval failed: ${(err as Error).message}\n`);
  process.exit(1);
});
