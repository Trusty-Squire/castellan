#!/usr/bin/env node
import { readFileSync, existsSync, cpSync, mkdtempSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseMission, resolveChain, type ChainsFile } from "./contract/schema.js";
import { resolveChains } from "./contract/derive.js";
import { runMission } from "./harness/runner.js";
import { summarizeTrace } from "./harness/trace.js";
import { MockEngine, fileScriptResolver } from "./engine/mock.js";
import { initRepo, isClean } from "./harness/checkpoint.js";
import { SquireError } from "./errors.js";
import type { Engine } from "./engine/types.js";
import { validateMissionFile } from "./contract/validate.js";
import { sanitizeInput } from "./term.js";

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
    case "idea":
      return cmdIdea(rest);
    case "plan":
      return cmdPlan(rest);
    case undefined:
    case "-h":
    case "--help":
      printUsage();
      return command === undefined ? 1 : 0;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "ser — Castellan: verified coding agent. Specs compile to gated loops.",
      "",
      "Usage:",
      "  ser login                 — store OPENROUTER_API_KEY in one place (~/.config/castellan/.env)",
      "  ser talk [x.spec.yaml] [--color|--no-color]  — unified interface: talk; check/derive/run behind it (creates the spec if absent)",
      "  ser run <mission.yaml> [--mock] [--chain <name>] [--sandbox]",
      "  ser derive \"<goal>\" [--chain <name>] [--yes] [--out <file>]",
      "  ser trace <trace.jsonl>",
      "  ser do \"<goal>\" [--gate <cmd>] [--radius <glob>] [--budget <usd>]",
      "  ser fix \"<bug>\" [--test-cmd <cmd>] [--test-file <path>]",
      "  ser spec init|check|verify|talk <x.spec.yaml> [...]",
      "  ser validate <mission.yaml> [--chains <file>]",
      "  ser experiment [-- <experiment args>]",
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
    const { PiEngine } = await import("./engine/pi.js");
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY is required for a real run (use --mock otherwise)");
    engine = new PiEngine();
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required for ser spec verify");
    const { OpenRouterClient } = await import("./llm/openrouter.js");
    const { loadChainsForDerive } = await import("./contract/derive.js");
    const chains = loadChainsForDerive(process.cwd(), flags.value.get("chains"));
    const chain = resolveChain(chains, flags.value.get("chain") ?? "cheap");
    const spec = parseSpec(readFileSync(resolve(file), "utf8"), file);
    const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
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
    // Use the live diagnostician when a key is present; mechanical-only otherwise.
    const apiKey = process.env.OPENROUTER_API_KEY;
    let s;
    if (apiKey) {
      const { OpenRouterClient } = await import("./llm/openrouter.js");
      const { loadChainsForDerive } = await import("./contract/derive.js");
      const chain = resolveChain(loadChainsForDerive(process.cwd(), flags.value.get("chains")), flags.value.get("chain") ?? "cheap");
      const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
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
  const { dispatchAction, ensureSpecFile, renderPlan } = await import("./contract/talk.js");

  // Color: --no-color forces off, --color forces on, else auto (TTY or
  // FORCE_COLOR/CLICOLOR_FORCE). Auto-detection is unreliable under some
  // tmux/SSH/phone setups, hence the explicit flag.
  const colorOverride = flags.bool.has("no-color") ? false : flags.bool.has("color") ? true : undefined;
  const { makeStyler, colorsEnabled, styleLockedIn } = await import("./style.js");
  const st = makeStyler(colorsEnabled(process.env, Boolean(process.stdout.isTTY), colorOverride));

  const { path: specFile, created } = ensureSpecFile(process.cwd(), flags.positional[0]);
  if (created) process.stdout.write(st.gray(`new spec: ${specFile} — your first message pins the thesis.`) + "\n");
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required for ser talk");
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  const { chains, path: chainsPath } = resolveChains(process.cwd(), flags.value.get("chains"));
  const chainName = flags.value.get("chain") ?? "cheap";
  const chain = resolveChain(chains, chainName);
  const { BUILTIN_CHAINS_SOURCE } = await import("./contract/default-chains.js");
  if (chainsPath === BUILTIN_CHAINS_SOURCE) {
    process.stdout.write(st.gray(`chain: ${chainName} (built-in defaults — drop a chains.yaml here to customize)`) + "\n");
  }
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
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
      if (batch.reply) process.stdout.write("\n" + batch.reply + "\n");
      if (batch.deltas.length > 0) {
        const { applied, dropped } = await session.acceptLenient(batch);
        if (applied.length > 0) {
          undoStack.push(before);
          if (undoStack.length > 20) undoStack = undoStack.slice(-20);
          note(styleLockedIn(applied, st));
        }
        if (dropped.length > 0) note(st.red(`${dropped.length} edit(s) didn't apply`));
      }
      if (batch.action !== "none") {
        try {
          for (const line of await dispatchAction(batch.action, batch.action_arg, actionCtx)) {
            const colored = /REFUTED|⚠|halted|cancelled|not buildable|not ready/i.test(line) ? st.red(line)
              : /READY|complete|every requirement|building\./i.test(line) ? st.green(line) : line;
            process.stdout.write(colored + "\n");
          }
        } catch (err) {
          note(st.red(`${batch.action} failed: ${(err as Error).message.split("\n")[0]}`));
        }
      }
      // Readiness: announce ONLY on the flip to buildable (mechanical = instant, free).
      // Present the plan BEFORE inviting "build it" — so the user sees what they'd ship.
      const ready = (await scoreSpec(session.load())).ready;
      if (ready && !lastReady) {
        for (const line of renderPlan(session.load())) process.stdout.write(st.dim(line) + "\n");
        process.stdout.write(st.green('\n✓ that\'s buildable — say "build it" when you want to go.') + "\n");
      }
      lastReady = ready;
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
async function cmdIdea(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains"]);
  const prompt = flags.positional[0];
  if (!prompt) throw new SquireError("USAGE", 'ser idea "<product prompt>"');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required for ser idea");
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  const { loadChainsForDerive } = await import("./contract/derive.js");
  const chain = resolveChain(loadChainsForDerive(process.cwd(), flags.value.get("chains")), flags.value.get("chain") ?? "cheap");
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
  const { extractIdea, renderIdea } = await import("./contract/ingest.js");
  const r = await extractIdea(prompt, llm, chain.executor);
  process.stdout.write(renderIdea(r).join("\n") + "\n");
  return 0;
}

/**
 * `ser plan "<prompt>" [out.spec.yaml]` — pipeline slices 1+2: the idea phase
 * decomposes the prompt into stories + components + bucketed decisions, the
 * decision brief resolves the asks with you (accept/pick/type/skip) and shows
 * the defaults, and the result compiles into a spec ready to derive.
 */
async function cmdPlan(args: string[]): Promise<number> {
  const flags = parseFlags(args, ["chain", "chains"]);
  const prompt = flags.positional[0];
  if (!prompt) throw new SquireError("USAGE", 'ser plan "<product prompt>" [out.spec.yaml]');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required for ser plan");
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  const { loadChainsForDerive } = await import("./contract/derive.js");
  const chain = resolveChain(loadChainsForDerive(process.cwd(), flags.value.get("chains")), flags.value.get("chain") ?? "cheap");
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
  const { makeStyler, colorsEnabled } = await import("./style.js");
  const st = makeStyler(colorsEnabled(process.env, Boolean(process.stdout.isTTY), flags.bool.has("no-color") ? false : flags.bool.has("color") ? true : undefined));

  const { extractIdea } = await import("./contract/ingest.js");
  const { resolveBrief, ideaToSpec } = await import("./contract/brief.js");
  const { stringify } = await import("yaml");

  process.stdout.write(st.gray("thinking through the stories and components…") + "\n");
  const idea = await extractIdea(prompt, llm, chain.executor);
  process.stdout.write("\n" + st.bold("Stories (minimum viable):") + "\n");
  idea.stories.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s}\n`));
  process.stdout.write("\n" + st.bold("Components:") + "\n");
  for (const c of idea.components) process.stdout.write(`  ${st.green("[t" + c.gate.tier + "]")} ${c.statement}\n`);
  process.stdout.write("\n");

  const io = { print: (l: string) => process.stdout.write(l + "\n"), ask };
  const resolutions = await resolveBrief(idea.decisions, io, st);

  const spec = ideaToSpec(prompt, idea, resolutions);
  const out = resolve(flags.positional[1] ?? `${basename(prompt).replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 32).replace(/^-|-$/g, "") || "product"}.spec.yaml`);
  const { writeFileSync: wf } = await import("node:fs");
  wf(out, stringify(spec));

  const { scoreSpec, renderScoreLine } = await import("./contract/spec-score.js");
  const s = await scoreSpec(spec);
  process.stdout.write("\n" + st.gray(`spec written: ${out}`) + "\n");
  process.stdout.write((s.ready ? st.green : st.yellow)(renderScoreLine(s)) + "\n");
  process.stdout.write(st.gray(`refine: ser talk ${basename(out)}   ·   build: ser derive ${basename(out)}`) + "\n");
  return 0;
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
