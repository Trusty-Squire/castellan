#!/usr/bin/env node
import { readFileSync, existsSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseMission, resolveChain, type ChainsFile } from "./contract/schema.js";
import { resolveChains } from "./contract/derive.js";
import { runMission } from "./harness/runner.js";
import { summarizeTrace } from "./harness/trace.js";
import { MockEngine, fileScriptResolver } from "./engine/mock.js";
import { commitAll, initRepo, isClean } from "./harness/checkpoint.js";
import { SquireError } from "./errors.js";
import type { Engine } from "./engine/types.js";
import type { LlmClient } from "./llm/types.js";
import type { Audit } from "./contract/review.js";
import type { RenderResult } from "./review/visual.js";
import type { VisualVerdict } from "./review/types.js";
import { validateMissionFile } from "./contract/validate.js";
import { sanitizeInput } from "./term.js";
import { applyReviewPatches, visualAuditSummary } from "./funnel.js";
import type { Spec } from "./contract/spec.js";
import type { Mission } from "./contract/schema.js";

async function main(argv: string[]): Promise<number> {
  const { loadDotEnv } = await import("./env.js");
  loadDotEnv(process.cwd()); // .env.local/.env, nearest wins; real env always wins
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "trace":
      return cmdTrace(rest);
    case "derive":
      return cmdDerive(rest);
    case "experiment":
      return cmdExperiment(rest);
    case "validate":
      return cmdValidate(rest);
    case "do":
      return cmdDo(rest);
    case "fix":
      return cmdFix(rest);
    case "spec":
      return cmdSpec(rest);
    case "talk":
      return cmdTalk(rest);
    case "login":
      return cmdLogin(rest);
    case undefined: {
      // bare `ser` → the funnel TUI, always a FRESH session (idea→spec→build→audit→ship).
      const { runTui } = await import("./tui/app.js");
      return runTui(false);
    }
    case "-c":
    case "--continue": {
      // `ser --continue` → resume the saved session (like `claude --continue`).
      const { runTui } = await import("./tui/app.js");
      return runTui(true);
    }
    case "-h":
    case "--help":
      printUsage();
      return 0;
    default:
      // No subcommand matched → the whole argv is a product prompt. Run the one
      // funnel command; spec/build/audit/ship are its stages, selected via --to.
      return cmdPipeline(argv);
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "ser — Castellan: verified coding agent. An idea compiles to a gated build.",
      "",
      "  ser                               start fresh — talk through an idea, then build it",
      "  ser --continue   (-c)             resume your last session where you left off",
      '  ser "<what you want to build>"     non-interactive: spec → build → audit → ship',
      "",
      "Stop at any layer with --to (no separate commands to learn):",
      "  --to spec     your idea → a buildable, gated spec (idea, review, and the",
      "                derive compile-check, in one phase; asks only the genuine forks)",
      "  --to build    spec → working code that passes every gate",
      "  --to audit    + an independent reviewer's polish notes (no build memory)",
      "  --to ship     (default) verify the gates are green and hand it over",
      "  --yes         accept ser's recommended fork answers, no prompts",
      "  --spec <f>    resume from an existing spec   --workdir <dir>  build here",
      "  --chain <n>   model chain (default: cheap)   --outer-loops <n>  bounded post-MVP raise passes",
      "  --mock           dry engine",
      "",
      "Utilities:",
      "  ser login · ser talk [spec.yaml] · ser do \"<goal>\" · ser fix \"<bug>\"",
      "  ser run/derive/validate/trace/experiment (advanced; stages of the above)",
      "",
    ].join("\n"),
  );
}

interface Flags {
  positional: string[];
  bool: Set<string>;
  value: Map<string, string>;
}

function parseFlags(args: string[], valued: string[]): Flags {
  const positional: string[] = [];
  const bool = new Set<string>();
  const value = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.includes(name)) {
        value.set(name, args[++i] ?? "");
      } else {
        bool.add(name);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, bool, value };
}

function loadChains(missionDir: string, explicit?: string): { chains: ChainsFile; path: string } {
  // One resolver for every command: explicit, cwd, workdir, global config,
  // then built-in defaults (ser runs anywhere — no chains.yaml required).
  return resolveChains(missionDir, explicit);
}

async function cmdRun(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains", "harness"]);
  const missionPath = flags.positional[0];
  if (!missionPath) throw new SquireError("USAGE", "ser run <mission.yaml> [--mock]");
  const missionAbs = resolve(missionPath);
  if (!existsSync(missionAbs)) throw new SquireError("MISSION_NOT_FOUND", `mission not found: ${missionAbs}`);
  const missionDir = dirname(missionAbs);
  const mission = parseMission(readFileSync(missionAbs, "utf8"), missionAbs);
  return executeMissionObject(mission, missionDir, flags, basename(missionAbs).replace(/\.[^.]+$/, ""));
}

/** Shared execution core for run/do/fix: workdir prep, engine, adjudicator, result. */
async function executeMissionObject(
  mission: ReturnType<typeof parseMission>,
  missionDir: string,
  flags: Flags,
  missionBaseName: string,
): Promise<number> {
  const { chains } = loadChains(missionDir, flags.value.get("chains"));
  const chainName = flags.value.get("chain") ?? mission.chain;
  const chain = resolveChain(chains, chainName);
  const declaredWorkdir = resolve(missionDir, mission.workdir);
  const useMock = flags.bool.has("mock");

  // Establish an effective workdir that is a real git repo. If the declared
  // workdir is not a git repo (or --sandbox is given), copy it to a temp dir
  // and git-init a baseline there, so the harness never mutates the source.
  const isRepo = existsSync(join(declaredWorkdir, ".git"));
  let workdir = declaredWorkdir;
  let sandboxed = false;
  if (!isRepo || flags.bool.has("sandbox")) {
    workdir = mkdtempSync(join(tmpdir(), "squire-run-"));
    cpSync(declaredWorkdir, workdir, {
      recursive: true,
      filter: (src) => !src.includes(`${"/"}node_modules`) && !src.endsWith(`${"/"}.git`),
    });
    await initRepo(workdir);
    sandboxed = true;
  } else if (!(await isClean(workdir))) {
    throw new SquireError(
      "DIRTY_WORKDIR",
      `workdir has uncommitted changes: ${workdir}. Commit or stash before running (the harness commits/resets per node).`,
    );
  }

  const missionId = `${missionBaseName}-${chainName}-${Date.now().toString(36)}`;
  const tracePath = join(workdir, ".squire", `trace-${missionId}.jsonl`);

  let engine: Engine;
  if (useMock) {
    engine = new MockEngine({ resolveScript: fileScriptResolver(join(missionDir, "engine-scripts")) });
  } else {
    const { makeBuildEngine } = await import("./backend.js");
    engine = await makeBuildEngine();
  }

  // Resolve harness mode: --harness <on|off> overrides the chain's setting.
  const harnessFlag = flags.value.get("harness");
  if (harnessFlag && harnessFlag !== "on" && harnessFlag !== "off") {
    throw new SquireError("USAGE", `--harness must be "on" or "off" (got "${harnessFlag}")`);
  }
  const harnessMode = (harnessFlag as "on" | "off" | undefined) ?? chain.harness;

  // Four-line readback (SPEC §8 style, applied to run as well).
  process.stdout.write(
    [
      `goal:    ${mission.goal}`,
      `chain:   ${chainName} (executor=${chain.executor}, knight=${chain.knight})`,
      `harness: ${harnessMode}${harnessMode === "off" ? " (ablation: raw, goal-only)" : ""}`,
      `budget:  $${mission.budget_usd}  over ${mission.nodes.length} node(s)`,
      `workdir: ${workdir}${sandboxed ? " (sandbox copy)" : ""}`,
      "",
    ].join("\n"),
  );
  // Emit the trace path at START (not only on halt) so a parent TUI can pin the
  // exact trace file and follow live progress without racing the newest-file scan.
  process.stdout.write(`trace: ${tracePath}\n`);

  const result = await runMission({
    mission,
    chains,
    engine,
    workdir,
    missionId,
    tracePath,
    chainNameOverride: chainName,
    harnessMode,
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: process.env.OPENROUTER_BASE_URL,
    log: (line) => process.stdout.write(line + "\n"),
    // Tier-4 human gates: interactive prompt when a TTY is attached; absent
    // otherwise so unattended runs fail loudly instead of self-approving.
    adjudicate: process.stdin.isTTY ? promptAdjudicator(workdir) : undefined,
  });

  process.stdout.write("\n" + summarizeTrace(tracePath) + "\n");
  if (result.completed) {
    process.stdout.write(`\nMISSION COMPLETE — ${result.committedNodeIds.length} node(s), $${result.totalCostUsd.toFixed(4)}\n`);
    return 0;
  }
  process.stdout.write(`\nMISSION HALTED — ${result.haltReason}\ntrace: ${tracePath}\n`);
  return 1;

}

async function cmdDo(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains", "harness", "gate", "radius", "budget"]);
  const goal = flags.positional[0];
  if (!goal) throw new SquireError("USAGE", 'ser do "<goal>" [--gate <cmd>] [--radius <glob>]');
  const { buildDoMission } = await import("./contract/packs.js");
  const workdir = process.cwd();
  const mission = buildDoMission(goal, workdir, {
    gate: flags.value.get("gate"),
    radius: flags.value.get("radius") ? [flags.value.get("radius")!] : undefined,
    budgetUsd: flags.value.get("budget") ? Number(flags.value.get("budget")) : undefined,
    chain: flags.value.get("chain"),
  });
  return executeMissionObject(mission, workdir, flags, "do");
}

async function cmdFix(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains", "harness", "test-cmd", "test-file", "radius", "budget"]);
  const bug = flags.positional[0];
  if (!bug) throw new SquireError("USAGE", 'ser fix "<bug description>" [--test-cmd <cmd>] [--test-file <path>]');
  const { buildFixMission } = await import("./contract/packs.js");
  const workdir = process.cwd();
  const mission = buildFixMission(bug, workdir, {
    testCmd: flags.value.get("test-cmd"),
    testFile: flags.value.get("test-file"),
    radius: flags.value.get("radius") ? [flags.value.get("radius")!] : undefined,
    budgetUsd: flags.value.get("budget") ? Number(flags.value.get("budget")) : undefined,
    chain: flags.value.get("chain"),
  });
  return executeMissionObject(mission, workdir, flags, "fix");
}

async function cmdSpec(args: string[]): Promise<number> {
  const sub = args[0];
  const { parseSpec } = await import("./contract/spec.js");
  const { checkSpec, verifyClaim } = await import("./contract/spec-session.js");
  const { stringify } = await import("yaml");
  const { writeFileSync: wf } = await import("node:fs");

  if (sub === "init") {
    const flags = parseFlags(args.slice(1), ["thesis"]);
    const file = flags.positional[0];
    if (!file) throw new SquireError("USAGE", 'ser spec init <name.spec.yaml> --thesis "<one paragraph>"');
    if (existsSync(resolve(file))) throw new SquireError("SPEC_EXISTS", `${file} already exists`);
    const { blankSpec } = await import("./contract/talk.js");
    wf(resolve(file), stringify(blankSpec(flags.value.get("thesis"))));
    process.stdout.write(`initialized ${file} — talk with: ser talk ${file}\n`);
    return 0;
  }

  if (sub === "check") {
    const file = args[1];
    if (!file) throw new SquireError("USAGE", "ser spec check <x.spec.yaml>");
    const spec = parseSpec(readFileSync(resolve(file), "utf8"), file);
    const { ok, lines } = checkSpec(spec);
    process.stdout.write(lines.join("\n") + "\n");
    return ok ? 0 : 1;
  }

  if (sub === "verify") {
    const flags = parseFlags(args.slice(1), ["chain", "chains"]);
    const [file, claimId] = flags.positional;
    if (!file || !claimId) throw new SquireError("USAGE", "ser spec verify <x.spec.yaml> <claim-id>");
    const { makeLlmClient } = await import("./backend.js");
    const { loadChainsForDerive } = await import("./contract/derive.js");
    const chains = loadChainsForDerive(process.cwd(), flags.value.get("chains"));
    const chain = resolveChain(chains, flags.value.get("chain") ?? "cheap");
    const spec = parseSpec(readFileSync(resolve(file), "utf8"), file);
    const llm = await makeLlmClient();
    const r = await verifyClaim(spec, claimId, llm, chain.executor);
    wf(resolve(file), stringify(r.spec));
    process.stdout.write(`${claimId}: ${r.verdict}\n  ${r.evidence}\n`);
    return r.verdict === "verified" ? 0 : 1;
  }

  if (sub === "score") {
    const flags = parseFlags(args.slice(1), ["chain", "chains"]);
    const file = flags.positional[0];
    if (!file) throw new SquireError("USAGE", "ser spec score <x.spec.yaml>");
    const spec = parseSpec(readFileSync(resolve(file), "utf8"), file);
    const { scoreSpec, renderScoreLine } = await import("./contract/spec-score.js");
    // Use the live diagnostician when a backend is available; mechanical-only otherwise.
    const { backendName, makeLlmClient } = await import("./backend.js");
    const live = backendName() === "codex" || Boolean(process.env.OPENROUTER_API_KEY);
    let s;
    if (live) {
      const { loadChainsForDerive } = await import("./contract/derive.js");
      const chain = resolveChain(loadChainsForDerive(process.cwd(), flags.value.get("chains")), flags.value.get("chain") ?? "cheap");
      const llm = await makeLlmClient();
      s = await scoreSpec(spec, { llm, model: chain.executor });
    } else {
      s = await scoreSpec(spec);
    }
    process.stdout.write(`${renderScoreLine(s)}\n`);
    for (const imp of s.improvements.slice(1, 6)) {
      process.stdout.write(`  [${imp.severity}/${imp.dimension}] ${imp.problem}\n    → ${imp.suggestion}\n`);
    }
    return s.ready ? 0 : 1;
  }

  if (sub === "talk") return cmdTalk(args.slice(1));

  throw new SquireError("USAGE", "ser spec init|check|verify|score|talk <x.spec.yaml>");
}

/**
 * The unified interface (`ser talk`): one conversation across all tools.
 * The mapper records deltas and may REQUEST a harness command (check/verify/
 * derive/run/status); the harness executes it mechanically and prints its own
 * report. The differences between the tools happen in the background.
 */
async function cmdTalk(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains", "budget"]);
  const { SpecSession } = await import("./contract/spec-session.js");
  const { dispatchAction, ensureSpecFile, renderPlan, stripTrailingQuestion, funnelStage, funnelNext, renderFunnel } =
    await import("./contract/talk.js");

  // Color: --no-color forces off, --color forces on, else auto (TTY or
  // FORCE_COLOR/CLICOLOR_FORCE). Auto-detection is unreliable under some
  // tmux/SSH/phone setups, hence the explicit flag.
  const colorOverride = flags.bool.has("no-color") ? false : flags.bool.has("color") ? true : undefined;
  const { makeStyler, colorsEnabled, styleLockedIn } = await import("./style.js");
  const st = makeStyler(colorsEnabled(process.env, Boolean(process.stdout.isTTY), colorOverride));

  const { path: specFile, created } = ensureSpecFile(process.cwd(), flags.positional[0]);
  if (created) process.stdout.write(st.gray(`new spec: ${specFile} — your first message pins the thesis.`) + "\n");
  const { makeLlmClient } = await import("./backend.js");
  const { chains, path: chainsPath } = resolveChains(process.cwd(), flags.value.get("chains"));
  const chainName = flags.value.get("chain") ?? "cheap";
  const chain = resolveChain(chains, chainName);
  const { BUILTIN_CHAINS_SOURCE } = await import("./contract/default-chains.js");
  if (chainsPath === BUILTIN_CHAINS_SOURCE) {
    process.stdout.write(st.gray(`chain: ${chainName} (built-in defaults — drop a chains.yaml here to customize)`) + "\n");
  }
  const llm = await makeLlmClient();
  const session = new SpecSession({
    path: specFile,
    llm,
    executorModel: chain.executor,
    knightModel: chain.knight,
  });
  const actionCtx = {
    specPath: session.path,
    llm,
    executorModel: chain.executor,
    chainName,
    budgetUsd: flags.value.get("budget") ? Number(flags.value.get("budget")) : undefined,
    confirm: async (q: string) => /^y(es)?\b/i.test((await ask(`${q} [y/N]: `)).trim()),
    execute: async (missionPath: string) => {
      const mission = parseMission(readFileSync(missionPath, "utf8"), missionPath);
      // ALWAYS sandbox a talk-run: the spec dir is a thinking space, often
      // inside a larger repo. The harness does git reset --hard on failed
      // nodes — it must never touch the user's working tree. The run executes
      // in an isolated temp copy; the printed workdir is where artifacts land.
      const runFlags: Flags = { positional: [], bool: new Set(flags.bool), value: new Map(flags.value) };
      runFlags.bool.add("sandbox");
      return executeMissionObject(mission, dirname(missionPath), runFlags, basename(missionPath).replace(/\.[^.]+$/, ""));
    },
  };
  const { extractIdea } = await import("./contract/ingest.js");
  const { ideaToTalkSpec, renderSeed } = await import("./contract/brief.js");
  const { scoreSpec } = await import("./contract/spec-score.js");
  const { writeFileSync: w } = await import("node:fs");
  type Spec = ReturnType<typeof session.load>;

  // The notebook updates in the BACKGROUND. A turn shows ser's reply (the
  // conversation), a single dim note of what changed, and readiness only the
  // moment it flips to buildable — never a per-turn diagnostic dump.
  const fresh = (sp: Spec): boolean =>
    /^TODO/.test(sp.thesis) || (sp.requirements.length === 1 && /^TODO/.test(sp.requirements[0]!.statement));
  const isCommand = (m: string): boolean => /^(build|run|ship|check|derive|status|score|ready|verify)\b/i.test(m);
  let lastReady = (await scoreSpec(session.load())).ready;
  let built = false; // flips after the first run — advances the funnel to POLISH
  const note = (s: string): void => { process.stdout.write(st.dim("· " + s) + "\n"); };

  process.stdout.write(st.bold("ser") + st.gray(" — just talk. it builds the plan as you go; 'undo' reverts, empty line exits.") + "\n");
  let undoStack: string[] = [];
  for (;;) {
    const msg = (await ask("\n" + st.cyan(st.bold("you")) + st.gray("  "))).trim();
    if (!msg) return 0;
    if (msg === "undo") {
      const prev = undoStack.pop();
      if (!prev) { note("nothing to undo"); continue; }
      w(session.path, prev);
      session.reject();
      note(`reverted (next on ${session.currentModel()})`);
      lastReady = (await scoreSpec(session.load())).ready;
      continue;
    }
    const before = readFileSync(session.path, "utf8");
    // CONVERGENCE: decompose a product through the calibrated idea phase, not
    // the legacy mapper. Shared by a fresh start and a pivot to a new product.
    const seed = async (pivotNote: boolean): Promise<void> => {
      process.stdout.write(st.dim("  …working it out") + "\n");
      const idea = await extractIdea(msg, llm, chain.executor);
      undoStack.push(before);
      w(session.path, (await import("yaml")).stringify(ideaToTalkSpec(msg, idea)));
      // Capture facts in the OPENING idea too ("…on a laptop") — the seed path
      // would otherwise never record them as decisions (A40).
      try { await session.captureDecisions(msg); } catch { /* best-effort */ }
      process.stdout.write("\n" + renderSeed(idea) + "\n");
      note((pivotNote ? "new direction — old spec reset ('undo' restores it); " : "") +
        `${idea.components.length} requirements, ${idea.decisions.filter((d) => d.bucket === 1).length} to decide`);
      lastReady = (await scoreSpec(session.load())).ready;
    };
    try {
      if (fresh(session.load()) && !isCommand(msg)) { await seed(false); continue; }

      const batch = await session.turn(msg);
      // A pivot is a new product — re-decompose it via the idea phase (same
      // calibrated path), rather than the mapper's incremental decomposition.
      if (batch.pivot) { await seed(true); continue; }
      // Apply FIRST so we know the post-turn open forks before printing the reply.
      let applied: Parameters<typeof styleLockedIn>[0] = [];
      if (batch.deltas.length > 0) {
        const res = await session.acceptLenient(batch);
        applied = res.applied;
        if (res.applied.length > 0) {
          undoStack.push(before);
          if (undoStack.length > 20) undoStack = undoStack.slice(-20);
        }
        if (res.dropped.length > 0) note(st.red(`${res.dropped.length} edit(s) didn't apply`));
      }
      // Semantic dedupe (A37): resolve forks a decision already answers, so the
      // mapper stops re-asking settled questions. Harness-applied; best-effort.
      let cleared: unknown[] = [];
      try {
        cleared = await session.reconcile();
      } catch {
        /* reconcile is best-effort — never break the conversation */
      }
      // Capture (A40): record constraints the user stated that the mapper dropped.
      let captured: unknown[] = [];
      try {
        captured = await session.captureDecisions(msg);
      } catch {
        /* capture is best-effort */
      }
      // Coherence: when NOTHING is open to ask, the model must not pose a fork —
      // "laptop locked but asking anyway". Strip a trailing question; the ✓ line
      // below carries the next step.
      let reply = batch.reply;
      if (session.load().open_questions.filter((q) => q.blocking).length === 0) {
        reply = stripTrailingQuestion(reply);
      }
      if (reply) process.stdout.write("\n" + reply + "\n");
      if (applied.length > 0) note(styleLockedIn(applied, st));
      if (cleared.length > 0) note(st.dim(`cleared ${cleared.length} already-answered question(s)`));
      if (captured.length > 0) note(st.dim(`recorded ${captured.length} decision(s) from what you said`));
      if (batch.action !== "none") {
        try {
          for (const line of await dispatchAction(batch.action, batch.action_arg, actionCtx)) {
            const colored = /REFUTED|⚠|halted|cancelled|not buildable|not ready/i.test(line) ? st.red(line)
              : /READY|complete|every requirement|building\./i.test(line) ? st.green(line) : line;
            process.stdout.write(colored + "\n");
          }
          if (batch.action === "run") built = true; // crossed into POLISH
        } catch (err) {
          note(st.red(`${batch.action} failed: ${(err as Error).message.split("\n")[0]}`));
        }
      }
      // Readiness: announce ONLY on the flip to buildable (mechanical = instant, free).
      // Present the plan BEFORE inviting "build it" — so the user sees what they'd ship.
      const spec = session.load();
      const ready = (await scoreSpec(spec)).ready;
      if (ready && !lastReady) {
        for (const line of renderPlan(spec)) process.stdout.write(st.dim(line) + "\n");
        process.stdout.write(st.green('\n✓ that\'s buildable — say "build it" when you want to go.') + "\n");
      }
      lastReady = ready;
      // The funnel, every turn: where you are (idea → build → polish) + next move.
      const stage = funnelStage(ready, built);
      process.stdout.write(st.dim(renderFunnel(stage, funnelNext(spec, stage))) + "\n");
    } catch (err) {
      note(st.red(`hiccup: ${(err as Error).message.split("\n")[0]} — keep talking`));
    }
  }
}

/**
 * `ser login` — put OPENROUTER_API_KEY in ONE canonical place
 * (~/.config/castellan/.env, mode 600) so every directory inherits it and
 * no .env files need scattering. Prefers a key already in the environment
 * (e.g. migrated from a project .env.local), else prompts. The key is read
 * by the user's own CLI process and written straight to disk — it never
 * passes through the model.
 */
async function cmdLogin(args: string[]): Promise<number> {
  const { globalEnvPath, upsertEnvVar } = await import("./env.js");
  const flags = parseFlags(args, []);
  const target = globalEnvPath();
  // A key picked up from a project .env.local during startup load is fine to
  // migrate; an inherited shell export is too. Either way, consolidate it.
  let key = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const migrating = key.length > 0 && !flags.bool.has("prompt");
  if (!migrating) {
    key = (await ask("OpenRouter API key (sk-or-...): ")).trim();
  }
  if (!key) {
    process.stderr.write("no key provided — nothing written\n");
    return 1;
  }
  upsertEnvVar(target, "OPENROUTER_API_KEY", key);
  const masked = key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "(set)";
  process.stdout.write(
    `${migrating ? "consolidated" : "saved"} OPENROUTER_API_KEY (${masked}) to ${target} [mode 600]\n` +
      `ser reads it from here in every directory — you can delete scattered .env keys now.\n`,
  );
  return 0;
}

/**
 * `ser idea "<prompt>"` — pipeline slice 1 (idea phase) in isolation: stories,
 * components (minimum viable), and decisions bucketed ask/default/silent. A
 * validation surface for the story-extraction + bucket-tagging before any UI.
 */
/**
 * The whole funnel under one command: `ser "<what you want>"` walks five layers,
 * each a STAGE you can stop at with `--to <stage>`:
 *   idea   user's words → clear user stories
 *   spec   stories → an eng + design spec with eval gates; asks only the forks
 *          that need real human judgment or can't be objectively checked
 *   build  spec → working code that passes every gate (the ground-truth loop)
 *   audit  finished code → polish notes from an independent reviewer (no build memory)
 *   ship   verify the gates are green and hand it over
 * Flags: --yes (accept ser's recommended fork answers) · --spec <file> (resume from a
 *   spec) · --workdir <dir> (build here) · --out <file> (spec path) · --chain · --mock · --outer-loops <n>.
 */
async function cmdPipeline(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ["chain", "chains", "to", "spec", "out", "workdir", "budget", "harness", "max-rebuilds", "outer-loops"]);
  const prompt = flags.positional[0];
  const fromSpec = flags.value.get("spec");
  if (!prompt && !fromSpec) {
    throw new SquireError("USAGE", 'ser "<what you want to build>"  [--to spec|build|audit|ship] [--yes] [--workdir <dir>]');
  }
  // One pre-build gate: "spec" absorbs idea-extraction, review, and the derive
  // compile-check. The spec is the contract; everything before build produces a
  // verified-buildable spec.
  const STAGES = ["spec", "build", "audit", "ship"] as const;
  const to = (flags.value.get("to") ?? "ship") as (typeof STAGES)[number];
  if (!STAGES.includes(to)) throw new SquireError("USAGE", `--to must be one of ${STAGES.join("|")} (got "${to}")`);
  const stopAfter = STAGES.indexOf(to);
  const stopAfterStage = (stage: (typeof STAGES)[number]): boolean => stopAfter === STAGES.indexOf(stage);
  const yes = flags.bool.has("yes");

  const { makeStyler, colorsEnabled } = await import("./style.js");
  const st = makeStyler(colorsEnabled(process.env, Boolean(process.stdout.isTTY), flags.bool.has("no-color") ? false : flags.bool.has("color") ? true : undefined));
  const layer = (n: number, name: string): void => { process.stdout.write("\n" + st.bold(`── LAYER ${n} · ${name} ` + "─".repeat(Math.max(0, 44 - name.length))) + "\n"); };
  const { loadChainsForDerive } = await import("./contract/derive.js");
  const chainName = flags.value.get("chain") ?? "cheap";
  const chain = resolveChain(loadChainsForDerive(process.cwd(), flags.value.get("chains")), chainName);
  const { stringify } = await import("yaml");
  const { makeLlmClient } = await import("./backend.js");
  const llm = await makeLlmClient();

  // ---- LAYER 1 idea + LAYER 2 spec ----
  let specPath: string;
  if (fromSpec) {
    specPath = resolve(fromSpec);
    if (!existsSync(specPath)) throw new SquireError("SPEC_NOT_FOUND", `spec not found: ${specPath}`);
    process.stdout.write(st.gray(`resuming from ${basename(specPath)}`) + "\n");
  } else {
    const { extractIdea } = await import("./contract/ingest.js");
    const { resolveBrief, ideaToSpec } = await import("./contract/brief.js");
    const { reviewSpec } = await import("./contract/review.js");
    const { withFrontendFloorStories } = await import("./review/frontend-floor.js");

    layer(1, "spec — your idea → a buildable, gated spec");
    process.stdout.write(st.gray("mapping your idea to clear user stories…") + "\n");
    const idea = await extractIdea(prompt!, llm, chain.executor);
    process.stdout.write("\n" + st.bold("User stories:") + "\n");
    idea.stories.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s}\n`));
    const io = { print: (l: string) => process.stdout.write(l + "\n"), ask: yes ? (async () => "") : ask };
    const resolutions = await resolveBrief(idea.decisions, io, st);
    const spec = withFrontendFloorStories(ideaToSpec(prompt!, idea, resolutions));
    // review lens (gstack eng + design review, borrowed): notes + the forks that
    // genuinely need a human / can't be objectively gated.
    process.stdout.write(st.gray("\nrunning the eng + design review lens…") + "\n");
    const review = await reviewSpec(spec, llm, chain.executor);
    // ser closes obvious gaps himself — each becomes a new gated requirement.
    const { added: addedReqs, skipped: skippedReqs } = applyReviewPatches(spec, review.patches);
    for (const p of skippedReqs) process.stdout.write(st.gray("  committee rejected coverage-only patch: ") + p.statement + "\n");
    for (const r of addedReqs) process.stdout.write(st.gray("  + ") + r.statement + "\n");
    let qn = spec.open_questions.length;
    for (const q of review.open_questions) {
      let text = q.text, answered = false;
      if (!yes) { const a = (await ask(st.bold("\n  judgment call: ") + q.text + st.gray("\n  > "))).trim(); if (a) { text = `${q.text} → ${a}`; answered = true; } }
      // only block when a human actively skipped a load-bearing call; --yes/answered proceed (flagged).
      spec.open_questions.push({ id: `Q${++qn}`, text, blocking: q.blocking && !yes && !answered });
    }
    specPath = resolve(flags.value.get("out") ?? `${basename(prompt!).replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 32).replace(/^-|-$/g, "") || "product"}.spec.yaml`);
    const { writeFileSync: wf } = await import("node:fs");
    wf(specPath, stringify(spec));
    const { scoreSpec, renderScoreLine } = await import("./contract/spec-score.js");
    const sc = await scoreSpec(spec);
    process.stdout.write("\n" + st.gray(`spec → ${basename(specPath)}`) + "\n");
    process.stdout.write((sc.ready ? st.green : st.yellow)(renderScoreLine(sc)) + "\n");
  }
  // ---- spec compile-check (still part of the one "spec" phase) ----
  // The spec is "ready" iff it derives into a buildable mission. We derive HERE
  // (option 1) so the user only ever sees a spec that already compiled — never
  // approve-then-fail at build. mission.yaml is internal (derived, regenerated).
  const buildDir = resolve(flags.value.get("workdir") ?? `./${basename(specPath).replace(/\.spec\.yaml$/, "") || "build"}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(buildDir, { recursive: true });
  const missionPath = join(buildDir, "mission.yaml");
  const { runDeriveV2 } = await import("./contract/derive2.js");
  const { parseSpec } = await import("./contract/spec.js");
  const { auditBuild } = await import("./contract/review.js");
  const { makeVisualClient } = await import("./backend.js");
  // Thread --budget through to the plan compiler: the mission budget is what
  // decompose distributes per node, and the per-node budget is what lets the
  // escalation ladder run (a failed cheap rung can only escalate to the deepseek
  // fallback / opus knight if the node budget covers another attempt). Without this
  // the mission always defaults to $2.5 (~$0.25/node), so the first cheap attempt
  // exhausts the node budget and the ladder breaks before it can escalate.
  const budgetArgs = flags.value.get("budget") ? ["--budget", String(flags.value.get("budget"))] : [];
  process.stdout.write(st.gray("\ncompiling the spec to a buildable plan…") + "\n");
  const compileRc = await runDeriveV2([specPath, "--workdir", buildDir, "--out", missionPath, "--chain", chainName, ...budgetArgs, ...(yes ? ["--yes"] : [])]);
  if (compileRc !== 0) {
    process.stdout.write(st.yellow("\nthis spec can't be built as written (the plan compiler refused above) — revise the spec and re-run. ser won't proceed on an unverified plan.") + "\n");
    return compileRc;
  }
  process.stdout.write(st.green("  spec is buildable — plan compiled.") + "\n");
  let missionReady = true; // the build loop's first attempt reuses this compiled mission

  if (stopAfterStage("spec")) return 0;

  // ---- LAYER 2 build + LAYER 3 audit, as a BOUNDED REBUILD LOOP ----
  // A visual block folds its fixes back into the spec and rebuilds; we halt
  // honestly only after exhausting cheap iterations (loop endurance is the product).
  const slug = basename(specPath).replace(/\.spec\.yaml$/, "");
  const maxRebuilds = Math.max(1, Number(flags.value.get("max-rebuilds") ?? 3));
  const maxOuterLoops = Math.max(1, Number(flags.value.get("outer-loops") ?? 1));
  const rank: Record<string, number> = { high: 0, med: 1, low: 2 };

  let recs: Audit["recommendations"] = [];
  let delivered = false;
  let visualClient: { llm: LlmClient; model: string } | null | undefined;
  let selectedVerdict: VisualVerdict | null = null;
  let directRebuildMission: Mission | null = null;

  for (let outer = 1; outer <= maxOuterLoops; outer++) {
    let pendingChange: { stories: string[] } | undefined;
    const feasibleCandidates: Array<{
      attempt: number;
      snapshotDir: string;
      shot: RenderResult;
      verdict: VisualVerdict;
      recs: Audit["recommendations"];
    }> = [];
    delivered = false;
    selectedVerdict = null;

    if (outer > 1) {
      layer(2, `raise spec ${outer}/${maxOuterLoops} — improve the MVP in a tractable slice`);
      process.stdout.write(st.gray("starting a new outer loop from the improved spec…") + "\n");
    }

    for (let attempt = 1; attempt <= maxRebuilds; attempt++) {
    // Fold the previous audit's blocking fixes into the spec before rebuilding:
    // each becomes an explicit story (so the visual judge re-checks it) plus, via
    // ONE design-reviewer pass, objective gates — no full pipeline re-run, no scope
    // creep. This is the autonomous equivalent of the TUI's pendingChange.
      if (pendingChange) {
        process.stdout.write(st.yellow(`\n↻ rebuild ${attempt}/${maxRebuilds} — folding the audit's blocking fixes back into the spec…`) + "\n");
        const { reviewOuterDeltaBatch } = await import("./review/raise.js");
        const currentSpec = parseSpec(readFileSync(specPath, "utf8"), specPath);
        const committee = reviewOuterDeltaBatch(pendingChange.stories, currentSpec.stories);
        const acceptedStories = committee.filter((d) => d.accepted).map((d) => d.story);
        const rejected = committee.filter((d) => !d.accepted);
        for (const d of rejected) process.stdout.write(st.gray(`  committee rejected: ${d.story} (${d.reason})\n`));
        if (acceptedStories.length === 0) {
          process.stdout.write(st.yellow("\nall proposed rebuild deltas were rejected by the product/execution/adversarial committee; halting rather than mutating the spec with bad feedback.") + "\n");
          return 1;
        }
        const delta = await refoldSpec(specPath, acceptedStories, llm, chain.executor);
        directRebuildMission = await buildDeltaMissionFromRefold(specPath, delta, {
          chainName,
          budgetUsd: Number(flags.value.get("budget") ?? "2.5"),
        });
        pendingChange = undefined;
      }

      layer(2, attempt > 1 ? `build — rebuild ${attempt}/${maxRebuilds}` : "build — run the compiled plan to passing gates");
      if (directRebuildMission) {
        const { stringify } = await import("yaml");
        const { writeFileSync: wf } = await import("node:fs");
        wf(missionPath, stringify(directRebuildMission));
        if (existsSync(join(buildDir, ".git"))) {
          await commitAll(buildDir, "pipeline: prepare focused rebuild mission");
        }
        process.stdout.write(st.gray(`compiled a focused ${directRebuildMission.nodes.length}-node rebuild mission from the raised delta\n`));
        directRebuildMission = null;
      } else if (missionReady) {
        // first build of this run reuses the mission compiled during the spec phase.
        missionReady = false;
        process.stdout.write(st.gray("running the plan compiled during the spec phase…\n"));
      } else {
        process.stdout.write(st.gray("re-deriving the gated build plan…\n"));
        const drc = await runDeriveV2([specPath, "--workdir", buildDir, "--out", missionPath, "--chain", chainName, ...budgetArgs, ...(yes ? ["--yes"] : [])]);
        if (drc !== 0) return drc;
      }
    // Keep language/test ephemera out of the git diff so reconcile's blast-radius
    // check never trips on a __pycache__/.pyc/node_modules byproduct.
    const gitignorePath = join(buildDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      const { writeFileSync: wfg } = await import("node:fs");
      wfg(gitignorePath, ["__pycache__/", "*.pyc", "*.pyo", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "node_modules/", ".venv/", "venv/", "*.egg-info/", ".DS_Store"].join("\n") + "\n");
    }
      if (!existsSync(join(buildDir, ".git"))) await initRepo(buildDir);
      const mission = parseMission(readFileSync(missionPath, "utf8"), missionPath);
      const buildRc = await executeMissionObject(mission, buildDir, flags, slug);
    // A build halt is already a loop-exhausted state — the executor's own rung
    // ladder retried before giving up — so it's an honest halt, not a first-fail stop.
      if (buildRc !== 0) { process.stdout.write(st.yellow("\nbuild halted honestly — a gate is still red after the executor's retries. ser will not ship unverified work.") + "\n"); return buildRc; }
      if (stopAfterStage("build")) return 0;

    // ---- LAYER 4 audit (independent reviewer, no build memory) ----
      layer(3, attempt > 1 ? `audit — re-check ${attempt}/${maxRebuilds}` : "audit — fresh eyes on the finished code");
      const { withFrontendFloorStories } = await import("./review/frontend-floor.js");
      const builtSpec = withFrontendFloorStories(parseSpec(readFileSync(specPath, "utf8"), specPath));
      const files = collectSourceFiles(buildDir);
      process.stdout.write(st.gray(`reviewing ${files.length} file(s) against ${builtSpec.stories.length} stories…`) + "\n");
      const audit = await auditBuild(files, { thesis: builtSpec.thesis, stories: builtSpec.stories }, llm, chain.executor);
      recs = audit.recommendations.sort((a, b) => (rank[a.severity]! - rank[b.severity]!));
      if (recs.length === 0) process.stdout.write(st.green("  audit: no polish recommended — the build is clean.") + "\n");
      for (const r of recs) {
        const sev = r.severity === "high" ? st.yellow("[high]") : r.severity === "med" ? st.bold("[med] ") : st.gray("[low] ");
        process.stdout.write(`  ${sev} ${st.gray(r.lens.padEnd(7))} ${r.note}${r.file ? st.gray("  (" + r.file + ")") : ""}\n`);
      }

    // Live visual review with TEETH: render the built UI, judge the screenshot,
    // collect the fixes that must block ship (an unsatisfied story / AI-slop).
      let fixes: { note: string; fix: string }[] = [];
      const { renderBuild, visualReview, polishFixes, qualityScore } = await import("./review/visual.js");
      const shot = await renderBuild(buildDir);
      if (!shot.ok) {
        if (/not a visual build/i.test(shot.note ?? "")) {
          process.stdout.write(st.gray(`  visual review skipped — ${shot.note}\n`));
        } else {
          process.stdout.write(st.yellow(`\nvisual review unavailable — ${shot.note}. ser will not ship a UI it could not render and inspect.`) + "\n");
          return 1;
        }
      } else {
        visualClient ??= await makeVisualClient();
        if (!visualClient) {
          process.stdout.write(st.yellow("\nvisual review unavailable — no multimodal reviewer is configured. ser will not ship a rendered UI without that check.") + "\n");
          return 1;
        }
        const verdict = await visualReview(shot, { thesis: builtSpec.thesis, stories: builtSpec.stories }, visualClient.llm, visualClient.model);
        if (!verdict) {
          process.stdout.write(st.yellow("\nvisual review failed to produce a verdict. ser will not ship a rendered UI without that check.") + "\n");
          return 1;
        }
        const summary = visualAuditSummary(verdict);
        for (const d of summary.lowDims) {
          process.stdout.write(`  ${st.yellow(`${d.score}/10`)} ${st.gray("design ")} ${d.name}\n`);
        }
        fixes = summary.fixes;
        if (fixes.length === 0) {
          const score = qualityScore(verdict);
          process.stdout.write(st.green(`  feasible UI candidate ${attempt} captured`) + st.gray(` (quality ${score})`) + "\n");
          feasibleCandidates.push({ attempt, snapshotDir: snapshotBuildDir(buildDir), shot, verdict, recs: [...recs] });
          const polish = polishFixes(verdict);
          if (polish.length > 0 && attempt < maxRebuilds) {
            pendingChange = { stories: polish };
            process.stdout.write(st.gray(`  continuing search with ${polish.length} quality-targeted fix(es)…`) + "\n");
            continue;
          }
          if (polish.length === 0) delivered = true;
          break;
        }
      }

      // The audit blocks ship. LOOP if we have attempts left; halt only when spent.
      process.stdout.write(st.yellow(`\nvisual review blocks ship — the built UI doesn't deliver the spec yet:\n`));
      for (const f of fixes) process.stdout.write(`  ${st.yellow("✗")} ${f.fix}\n`);
      if (attempt < maxRebuilds) {
        pendingChange = { stories: fixes.map((f) => f.fix) };
        process.stdout.write(st.gray(`\nfolding these into the spec and rebuilding (attempt ${attempt + 1}/${maxRebuilds})…`) + "\n");
        continue;
      }
      process.stdout.write(st.yellow(`\nvisual review still blocks after ${maxRebuilds} rebuilds — halting honestly with the issues above. ser will not ship a UI that fails its own design review.`) + "\n");
      return 1;
    }

    if (!feasibleCandidates.length && !delivered) return 1;
    if (feasibleCandidates.length > 0) {
      const { withFrontendFloorStories } = await import("./review/frontend-floor.js");
      const { chooseVisualCandidate } = await import("./review/visual.js");
      const winnerSpec = withFrontendFloorStories(parseSpec(readFileSync(specPath, "utf8"), specPath));
      const winner = visualClient
        ? await chooseVisualCandidate(
            feasibleCandidates.map((c) => ({ id: `candidate ${c.attempt}`, shot: c.shot, verdict: c.verdict })),
            { thesis: winnerSpec.thesis, stories: winnerSpec.stories },
            visualClient.llm,
            visualClient.model,
          )
        : {
            candidate: { id: `candidate ${feasibleCandidates[0]!.attempt}`, shot: feasibleCandidates[0]!.shot, verdict: feasibleCandidates[0]!.verdict },
            rationale: "single feasible candidate",
            mode: "score" as const,
          };
      const selectedAttempt = Number(winner.candidate.id.replace(/^candidate /, ""));
      const selected = feasibleCandidates.find((c) => c.attempt === selectedAttempt) ?? feasibleCandidates[0]!;
      restoreSnapshot(selected.snapshotDir, buildDir);
      recs = selected.recs;
      selectedVerdict = selected.verdict;
      delivered = true;
      process.stdout.write(st.green(`  selected ${winner.candidate.id} for ship`) + st.gray(` (${winner.mode}: ${winner.rationale})`) + "\n");
      process.stdout.write(st.green("  visual review: the screen delivers every story.") + "\n");
    }
    if (!delivered) return 1;
    if (stopAfterStage("audit")) return 0;

    if (outer >= maxOuterLoops || !selectedVerdict) break;
    const { withFrontendFloorStories } = await import("./review/frontend-floor.js");
    const { planOuterDelta } = await import("./review/raise.js");
    const nextSpec = withFrontendFloorStories(parseSpec(readFileSync(specPath, "utf8"), specPath));
    const delta = planOuterDelta(nextSpec, recs, selectedVerdict);
    if (delta.stories.length === 0) break;
    process.stdout.write(st.gray(`\nraising the spec with ${delta.stories.length} tractable delta(s) for the next outer loop…`) + "\n");
    delta.stories.forEach((story, i) => process.stdout.write(`  ${i + 1}. ${story}\n`));
    const raised = await refoldSpec(specPath, delta.stories, llm, chain.executor);
    directRebuildMission = await buildDeltaMissionFromRefold(specPath, raised, {
      chainName,
      budgetUsd: Number(flags.value.get("budget") ?? "2.5"),
    });
  }
  if (!delivered) return 1;

  // ---- LAYER 5 ship ----
  layer(4, "ship");
  const highs = recs.filter((r) => r.severity === "high").length;
  process.stdout.write(st.green(`\n✓ shipped → ${buildDir}`) + "\n");
  process.stdout.write(st.gray(`  every gate green · ${recs.length} audit note(s)${highs ? `, ${highs} high-severity worth a look` : ""}\n`));
  return 0;
}

/**
 * Fold an audit's blocking fixes back into the spec for the next rebuild. Each fix
 * becomes an explicit story (so the visual judge re-checks it) plus, via ONE design-
 * reviewer pass, a few objective gates that force the build to deliver it. Bounded
 * and de-duped — no full pipeline re-run, so it can't re-trigger scope creep.
 */
interface RefoldDelta {
  stories: string[];
  requirements: Spec["requirements"];
}

async function refoldSpec(specPath: string, fixes: string[], llm: LlmClient, model: string): Promise<RefoldDelta> {
  const { parseSpec } = await import("./contract/spec.js");
  const { designReview } = await import("./review/reviewers.js");
  const { isTestOnlyDelta } = await import("./review/raise.js");
  const { stringify } = await import("yaml");
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const spec = parseSpec(rf(specPath, "utf8"), specPath);
  const addedStories: string[] = [];
  const addedRequirements: Spec["requirements"] = [];
  for (const f of fixes) {
    if (!spec.stories.includes(f)) {
      spec.stories.push(f);
      addedStories.push(f);
    }
  }
  const dr = await designReview(spec, llm, model);
  const seen = new Set(spec.requirements.map((r) => norm(r.statement)));
  let rn = spec.requirements.length;
  for (const p of dr.patches.filter((p) => p.kind === "objective").slice(0, 4)) {
    if (isTestOnlyDelta(p.statement)) continue;
    const key = norm(p.statement);
    if (seen.has(key)) continue;
    seen.add(key);
    const req = { id: `R${++rn}`, statement: p.statement, acceptance: { tier: 1, gate: p.gate } as const };
    spec.requirements.push(req);
    addedRequirements.push(req);
  }
  wf(specPath, stringify(spec));
  return { stories: addedStories, requirements: addedRequirements };
}

async function buildDeltaMissionFromRefold(
  specPath: string,
  delta: RefoldDelta,
  opts: { chainName: string; budgetUsd: number },
): Promise<Mission | null> {
  const { parseSpec } = await import("./contract/spec.js");
  const { buildDirectMission } = await import("./contract/derive2.js");
  const { readFileSync: rf } = await import("node:fs");
  const spec = parseSpec(rf(specPath, "utf8"), specPath);
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set<string>();
  const items: Array<{ statement: string; acceptance?: Spec["requirements"][number]["acceptance"] }> = [];
  const push = (statement: string, acceptance?: Spec["requirements"][number]["acceptance"]): void => {
    const key = norm(statement);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ statement, acceptance });
  };

  // Outer-loop delta requirements come from reviewer patches and often carry
  // overfit gate strings (for example, assuming a `tests/` directory when the
  // app keeps tests in `src/`). Compile them back through the primitive
  // interactive-app gate builder instead of replaying those brittle literals.
  for (const req of delta.requirements) push(req.statement, req.acceptance?.tier === 4 ? req.acceptance : undefined);
  for (const story of delta.stories) push(story);
  if (items.length === 0) return null;
  return buildDirectMission({
    thesis: spec.thesis,
    items,
    chainName: opts.chainName,
    budgetUsd: opts.budgetUsd,
    idPrefix: "d",
  });
}

/** Walk a build dir for reviewable source (skips git/node_modules/harness files). */
function collectSourceFiles(dir: string): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const skip = new Set([".git", "node_modules", ".squire"]);
  const ok = /\.(js|jsx|ts|tsx|mjs|cjs|html|css|json|py|go|rs|md)$/;
  const walk = (d: string, base: string): void => {
    for (const f of readdirSync(d)) {
      if (skip.has(f) || f === "mission.yaml" || f.endsWith(".spec.yaml") || f === "progress.log") continue;
      const p = join(d, f), rel = base ? `${base}/${f}` : f;
      if (statSync(p).isDirectory()) walk(p, rel);
      else if (ok.test(f) && out.length < 40) out.push({ path: rel, src: readFileSync(p, "utf8") });
    }
  };
  walk(dir, "");
  return out;
}

function snapshotBuildDir(buildDir: string): string {
  const snapshotDir = mkdtempSync(join(tmpdir(), "ser-ui-candidate-"));
  cpSync(buildDir, snapshotDir, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}.git${sep}`) && !src.endsWith(`${sep}.git`) && !src.includes(`${sep}node_modules${sep}`),
  });
  return snapshotDir;
}

function restoreSnapshot(snapshotDir: string, buildDir: string): void {
  for (const name of readdirSync(buildDir)) {
    if (name === ".git") continue;
    rmSync(join(buildDir, name), { recursive: true, force: true });
  }
  cpSync(snapshotDir, buildDir, { recursive: true });
}

async function cmdTrace(args: string[]): Promise<number> {
  const flags = parseFlags(args, []);
  const path = flags.positional[0];
  if (!path) throw new SquireError("USAGE", "ser trace <trace.jsonl>");
  process.stdout.write(summarizeTrace(resolve(path)) + "\n");
  return 0;
}

async function cmdDerive(args: string[]): Promise<number> {
  // v2 herald pipeline (SPEC-v0.2 §6); v1 remains importable for tests.
  const { runDeriveV2 } = await import("./contract/derive2.js");
  return runDeriveV2(args);
}

async function cmdExperiment(args: string[]): Promise<number> {
  // Delegate to the experiment script (the benchmark entrypoint, SPEC §12).
  const { execa } = await import("execa");
  const script = resolve(dirname(new URL(import.meta.url).pathname), "..", "scripts", "experiment.ts");
  const result = await execa("npx", ["tsx", script, ...args], { stdio: "inherit", reject: false });
  return result.exitCode ?? 1;
}

async function cmdValidate(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chains"]);
  const missionPath = flags.positional[0];
  if (!missionPath) throw new SquireError("USAGE", "ser validate <mission.yaml> [--chains <file>]");
  
  const missionAbs = resolve(missionPath);
  if (!existsSync(missionAbs)) throw new SquireError("MISSION_NOT_FOUND", `mission not found: ${missionAbs}`);
  
  const missionDir = dirname(missionAbs);
  const { path: chainsPath } = loadChains(missionDir, flags.value.get("chains"));
  
  const result = validateMissionFile(missionAbs, chainsPath);
  
  // Print one line per issue prefixed "error:" or "warn:" (include the nodeId when present)
  for (const issue of result.issues) {
    const prefix = `${issue.level}:`;
    const nodeIdPart = issue.nodeId ? ` [node:${issue.nodeId}]` : "";
    process.stdout.write(`${prefix}${nodeIdPart} ${issue.message}\n`);
  }
  
  // Print final summary line
  const errorCount = result.issues.filter(i => i.level === "error").length;
  const warnCount = result.issues.filter(i => i.level === "warn").length;
  process.stdout.write(`validation complete: ${errorCount} error(s), ${warnCount} warning(s)\n`);
  
  // Return exit code 0 when the report is ok (warnings alone are fine), 1 otherwise
  return errorCount > 0 ? 1 : 0;
}


/** Interactive tier-4 adjudicator: show the artifact path, take approve/reject + reason. */
function promptAdjudicator(workdir: string): import("./harness/gates.js").Adjudicator {
  return async ({ nodeId, artifact }) => {
    process.stdout.write(`\n[human gate] node "${nodeId}" — review artifact: ${join(workdir, artifact)}\n`);
    const answer = await ask(`approve? [y/N + optional reason]: `);
    const approved = /^y(es)?\b/i.test(answer.trim());
    const reason = answer.trim().replace(/^y(es)?\s*/i, "").replace(/^n(o)?\s*/i, "") || (approved ? "approved" : "rejected");
    return { approved, reason, by: process.env.USER ?? "human" };
  };
}

let stdinEnded = false;
function readChunk(): Promise<string> {
  // Once stdin has ended (piped input exhausted, or Ctrl-D), every further read
  // resolves empty immediately — 'end' only fires once, so without this a brief
  // with more asks than input lines would deadlock and never write its spec.
  if (stdinEnded) return Promise.resolve("");
  return new Promise((resolveP) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (d: Buffer | string): void => { cleanup(); resolveP(String(d)); };
    const onEnd = (): void => { stdinEnded = true; cleanup(); resolveP(""); };
    const cleanup = (): void => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/** Prompt and read one line, skipping pure mouse/escape noise (phone terminals). */
async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  for (;;) {
    const { text, noise } = sanitizeInput(await readChunk());
    if (!noise) return text; // a real empty line (just Enter) still returns "" and exits the loop
    // pure escape/mouse garbage — keep waiting without echoing or exiting
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof SquireError) {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
      if (err.tracePath) process.stderr.write(`trace: ${err.tracePath}\n`);
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    process.exit(1);
  });
