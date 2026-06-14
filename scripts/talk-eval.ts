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
import { resolveChains } from "../src/contract/derive.js";
import { resolveChain } from "../src/contract/schema.js";
import { SpecSession } from "../src/contract/spec-session.js";
import { blankSpec, stripTrailingQuestion } from "../src/contract/talk.js";
import { extractIdea } from "../src/contract/ingest.js";
import { ideaToTalkSpec, renderSeed } from "../src/contract/brief.js";
import { scoreSpec } from "../src/contract/spec-score.js";
import { loadDotEnv } from "../src/env.js";
import {
  SCENARIOS,
  scoreTranscript,
  formatScoreTable,
  simUserMessage,
  type Scenario,
  type EvalTurn,
  type Transcript,
  type RunDeps,
} from "../src/eval/talk-eval.js";

function blockingCount(spec: { open_questions: { blocking: boolean }[] }): number {
  return spec.open_questions.filter((q) => q.blocking).length;
}

async function runScenario(scenario: Scenario, deps: RunDeps): Promise<Transcript> {
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

  return { scenarioId: scenario.id, turns, finalDecisions: session.load().decisions.map((d) => d.statement) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : undefined;
  const userModelOverride = args.includes("--user-model") ? args[args.indexOf("--user-model") + 1] : undefined;

  loadDotEnv(process.cwd()); // same env path as `ser` — picks up ~/.config/castellan/.env
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY required for talk-eval (it makes real model calls)");
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
  const { chains } = resolveChains(process.cwd());
  const chain = resolveChain(chains, "cheap");

  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenario matched "${only}"`);

  const rows: { scenario: string; score: ReturnType<typeof scoreTranscript> }[] = [];
  const transcripts: Transcript[] = [];
  for (const scenario of scenarios) {
    process.stderr.write(`\n▶ ${scenario.id}: "${scenario.idea}"\n`);
    const dir = mkdtempSync(join(tmpdir(), `talk-eval-${scenario.id}-`));
    const deps: RunDeps = {
      mapperLlm: llm,
      mapperModel: chain.executor,
      knightModel: chain.knight,
      userLlm: llm,
      // the simulated user can be a stronger model so it answers faithfully
      userModel: userModelOverride ?? chain.knight,
      specPath: join(dir, "eval.spec.yaml"),
    };
    const transcript = await runScenario(scenario, deps);
    transcripts.push(transcript);
    rows.push({ scenario: scenario.id, score: scoreTranscript(scenario, transcript) });
  }

  process.stdout.write("\n" + formatScoreTable(rows) + "\n");
  mkdirSync(join(process.cwd(), "results"), { recursive: true });
  const out = join(process.cwd(), "results", `talk-eval-${transcripts.length}-scenarios.json`);
  writeFileSync(out, JSON.stringify({ rows, transcripts }, null, 2));
  process.stderr.write(`\ntranscripts → ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`talk-eval failed: ${(err as Error).message}\n`);
  process.exit(1);
});
