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
import { synthesizeSpec } from "../src/contract/synthesize.js";
import { scoreSpec } from "../src/contract/spec-score.js";
import { loadDotEnv } from "../src/env.js";
import type { Spec } from "../src/contract/spec.js";
import {
  SCENARIOS,
  scoreTranscript,
  simUserMessage,
  judgeProcess,
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

async function runScenario(scenario: Scenario, deps: RunDeps): Promise<{ transcript: Transcript; finalSpec: Spec; elicited: Spec }> {
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
        await session.captureDecisions(userMsg).catch(() => []); // A40: capture facts in the opening idea
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

  // The conversation produced an elicited spec; the SYNTHESIS pass turns it into
  // the committed, MVP-scoped, objectively-gated spec that actually gets scored.
  const elicited = session.load();
  const finalSpec = await synthesizeSpec(elicited, deps.mapperLlm, deps.mapperModel).catch(() => elicited);
  return {
    transcript: { scenarioId: scenario.id, turns, finalDecisions: elicited.decisions.map((d) => d.statement) },
    finalSpec,
    elicited,
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
  // deterministic Tier-2 lift alone. --seeds N: run each scenario N times and
  // AVERAGE, so conversation+vanilla noise cancels (the loop can't gate a tuning
  // change off one noisy run). --concurrency K: cap simultaneous claude -p
  // processes — unbounded parallelism was breaking runs (A40).
  const mechanicalOnly = args.includes("--mechanical");
  const seeds = args.includes("--seeds") ? Math.max(1, parseInt(args[args.indexOf("--seeds") + 1] ?? "1", 10)) : 1;
  const concurrency = args.includes("--concurrency") ? Math.max(1, parseInt(args[args.indexOf("--concurrency") + 1] ?? "2", 10)) : 2;

  interface Run {
    scenarioId: string;
    lift: number;
    facts: number;
    obj: number; // ser objective-gate rate (the loop metric)
    serComp: number;
    vanComp: number;
    serWon: "ser" | "vanilla" | "tie" | null;
    dump: unknown;
  }

  async function evalRun(scenario: Scenario, runIdx: number): Promise<Run | null> {
    try {
      const dir = mkdtempSync(join(tmpdir(), `talk-eval-${scenario.id}-`));
      const deps: RunDeps = { mapperLlm: llm, mapperModel, knightModel: richModel, userLlm: llm, userModel: richModel, specPath: join(dir, "eval.spec.yaml") };
      const { transcript, finalSpec, elicited } = await runScenario(scenario, deps);
      const mech = scoreTranscript(scenario, transcript);
      const pj = mechanicalOnly ? null : await judgeProcess(scenario, transcript, llm, richModel).catch(() => null);
      const vanilla = await generateVanillaSpec(scenario, llm, mapperModel);
      const serQ = specQuality(finalSpec, scenario);
      const vanQ = specQuality(vanilla, scenario);
      const { a, b, serIs } = blindAssign(finalSpec, vanilla, runIdx % 2 === 1);
      const verdict = mechanicalOnly ? null : await judgeSpecPair(scenario.idea, a, b, llm, richModel).catch(() => null);
      const serWon: Run["serWon"] = verdict ? (verdict.winner === "tie" ? "tie" : verdict.winner === serIs ? "ser" : "vanilla") : null;
      const lift = serQ.composite - vanQ.composite;
      process.stderr.write(`  ✓ ${scenario.id} #${runIdx}: lift ${lift >= 0 ? "+" : ""}${lift} (facts ${pct(serQ.factCoverage)})\n`);
      return { scenarioId: scenario.id, lift, facts: serQ.factCoverage, obj: serQ.objectiveRate, serComp: serQ.composite, vanComp: vanQ.composite, serWon, dump: { scenario: scenario.id, runIdx, transcript, elicited, finalSpec, mech, processJudge: pj, serQ, vanQ, verdict, vanilla } };
    } catch (err) {
      process.stderr.write(`  ✗ ${scenario.id} #${runIdx} errored: ${(err as Error).message.split("\n")[0]}\n`);
      return null;
    }
  }

  // Concurrency-limited task pool over scenarios × seeds.
  const tasks: { scenario: Scenario; runIdx: number }[] = [];
  scenarios.forEach((s, si) => {
    for (let k = 0; k < seeds; k++) tasks.push({ scenario: s, runIdx: si * seeds + k });
  });
  const runs: (Run | null)[] = new Array(tasks.length);
  let nextTask = 0;
  process.stderr.write(`running ${scenarios.length} scenario(s) × ${seeds} seed(s) @ concurrency ${concurrency}${mechanicalOnly ? " [mechanical]" : ""}…\n`);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      for (;;) {
        const i = nextTask++;
        if (i >= tasks.length) return;
        runs[i] = await evalRun(tasks[i]!.scenario, tasks[i]!.runIdx);
      }
    }),
  );

  // Aggregate per scenario (average across seeds).
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
  const sd = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };
  const rows: string[][] = [];
  const allLifts: number[] = [];
  let serWins = 0;
  let judged = 0;
  for (const scenario of scenarios) {
    const r = runs.filter((x): x is Run => x !== null && x.scenarioId === scenario.id);
    if (r.length === 0) {
      rows.push([scenario.id, "0/" + seeds, "—", "—", "—", "—"]);
      continue;
    }
    const lifts = r.map((x) => x.lift);
    allLifts.push(...lifts);
    serWins += r.filter((x) => x.serWon === "ser").length;
    judged += r.filter((x) => x.serWon !== null).length;
    rows.push([
      scenario.id,
      `${r.length}/${seeds}`,
      `${Math.round(mean(r.map((x) => x.serComp)))} vs ${Math.round(mean(r.map((x) => x.vanComp)))}`,
      `${mean(lifts) >= 0 ? "+" : ""}${mean(lifts).toFixed(1)} ±${sd(lifts).toFixed(0)}`,
      pct(mean(r.map((x) => x.obj))),
      pct(mean(r.map((x) => x.facts))),
      judged > 0 ? `${r.filter((x) => x.serWon === "ser").length}/${r.filter((x) => x.serWon !== null).length}` : "n/a",
    ]);
  }

  process.stdout.write("\n══ TIER 2 — output vs same-facts vanilla, averaged over seeds ══\n");
  process.stdout.write(table(["scenario", "runs", "ser vs van", "lift μ±σ", "obj μ", "facts μ", "wins"], rows) + "\n");
  process.stdout.write(`\nMEAN LIFT: ${mean(allLifts) >= 0 ? "+" : ""}${mean(allLifts).toFixed(1)} (±${sd(allLifts).toFixed(0)}, n=${allLifts.length})` + (judged > 0 ? `   |   judge wins ${serWins}/${judged}` : "") + "\n");

  mkdirSync(join(process.cwd(), "results"), { recursive: true });
  const out = join(process.cwd(), "results", `talk-eval-${scenarios.length}x${seeds}.json`);
  writeFileSync(out, JSON.stringify(runs.filter(Boolean).map((r) => (r as Run).dump), null, 2));
  process.stderr.write(`\ntranscripts → ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`talk-eval failed: ${(err as Error).message}\n`);
  process.exit(1);
});
