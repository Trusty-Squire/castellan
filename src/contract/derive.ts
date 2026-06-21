import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { execa } from "execa";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { SquireError } from "../errors.js";
import {
  MissionSchema,
  NodeSchema,
  parseChains,
  resolveChain,
  type Mission,
  type ChainsFile,
} from "./schema.js";
import type { LlmClient } from "../llm/types.js";
import { configDir } from "../env.js";
import { DEFAULT_CHAINS_YAML, BUILTIN_CHAINS_SOURCE } from "./default-chains.js";

/** Planner system prompt — Appendix A, verbatim. */
export const HERALD_SYSTEM_PROMPT = `You are the Herald: a mission planner for a verification
harness. You will receive a goal and a repository survey.
Decompose the goal into 3-12 nodes forming a DAG.

Rules:
- Every node MUST have done_check: a single shell command,
  runnable in this repo, that exits 0 only if the node's
  work is objectively complete. Prefer the repo's existing
  test/build/lint commands. Never invent commands.
- Briefs are self-contained: the executor sees ONLY the brief
  and the files matched by context_globs. No references to
  "as discussed" or other nodes' reasoning.
- blast_radius: the narrowest glob set that permits the work.
- Budgets: distribute the mission budget; harder nodes more.
- If the goal cannot be decomposed into objectively checkable
  nodes, output {"error": "<one sentence why>"} instead.

Output ONLY JSON matching the schema provided. No markdown.`;

/** The model returns either an error or a plan (the node list). */
const PlanSchema = z.object({ nodes: z.array(NodeSchema).min(1) });
const ErrorSchema = z.object({ error: z.string().min(1) });

const SCHEMA_HINT = `Output JSON of exactly this shape:
{
  "nodes": [
    {
      "id": "kebab-id",
      "brief": "self-contained one-paragraph instruction",
      "deps": ["other-node-id"],
      "context_globs": ["src/**/*.ts"],
      "blast_radius": ["src/feature/**"],
      "done_check": "an existing runnable shell command, exit 0 = done",
      "budget_usd": 0.40,
      "max_context_tokens": 40000
    }
  ]
}
3 to 12 nodes, forming a DAG (deps reference earlier node ids).
If impossible, output {"error":"<one sentence>"} instead.`;

export interface DeriveInput {
  goal: string;
  budgetUsd: number;
  chainName: string;
  workdir: string;
  repoSurvey: string;
  llm: LlmClient;
  knightModel: string;
  maxTokens?: number;
}

export interface DeriveResult {
  mission: Mission;
  inTokens: number;
  outTokens: number;
}

/**
 * One frontier call that turns goal + repo survey into a Mission. zod-validated;
 * on failure ONE retry with the validation errors appended; second failure
 * throws. A model {"error": ...} response throws (no silent fallback). SPEC §8.
 */
export async function derivePlan(input: DeriveInput): Promise<DeriveResult> {
  const maxTokens = input.maxTokens ?? 4000;
  let inTokens = 0;
  let outTokens = 0;
  let priorError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const user = buildUserPrompt(input, priorError);
    const res = await input.llm.complete({
      model: input.knightModel,
      system: HERALD_SYSTEM_PROMPT,
      user,
      json: true,
      maxTokens,
    });
    inTokens += res.inTokens;
    outTokens += res.outTokens;

    const parsedJson = tryParseJson(res.text);
    if (!parsedJson.ok) {
      priorError = `Your previous output was not valid JSON: ${parsedJson.error}`;
      continue;
    }

    // A refusal is terminal — no retry, no silent fallback.
    const asError = ErrorSchema.safeParse(parsedJson.value);
    if (asError.success) {
      throw new SquireError("DERIVE_REFUSED", `planner refused: ${asError.data.error}`);
    }

    const plan = PlanSchema.safeParse(parsedJson.value);
    if (!plan.success) {
      priorError = formatZodIssues(plan.error.issues);
      continue;
    }

    const missionObj = {
      goal: input.goal,
      budget_usd: input.budgetUsd,
      chain: input.chainName,
      workdir: input.workdir,
      nodes: plan.data.nodes,
    };
    const mission = MissionSchema.safeParse(missionObj);
    if (!mission.success) {
      priorError = formatZodIssues(mission.error.issues);
      continue;
    }

    return { mission: mission.data, inTokens, outTokens };
  }

  throw new SquireError(
    "DERIVE_INVALID",
    `planner produced an invalid mission after one retry: ${priorError ?? "unknown"}`,
  );
}

function buildUserPrompt(input: DeriveInput, priorError?: string): string {
  const parts = [
    `GOAL:\n${input.goal}`,
    "",
    `REPOSITORY SURVEY:\n${input.repoSurvey}`,
    "",
    `MISSION BUDGET (USD, distribute across nodes): ${input.budgetUsd}`,
    `CHAIN: ${input.chainName}`,
    `WORKDIR: ${input.workdir}`,
    "",
    SCHEMA_HINT,
  ];
  if (priorError) {
    parts.push("", `Your previous attempt was rejected. Fix these problems and output valid JSON:\n${priorError}`);
  }
  return parts.join("\n");
}

/** Assemble the repo survey (SPEC §8 inputs). */
export async function buildRepoSurvey(workdir: string): Promise<string> {
  const lines: string[] = [];

  let files: string[] = [];
  try {
    const ls = await execa("git", ["ls-files"], { cwd: workdir, reject: false });
    files = ls.stdout.split("\n").filter(Boolean);
  } catch {
    files = [];
  }
  lines.push(`FILES (${files.length}):`);
  lines.push(files.slice(0, 200).join("\n"));

  for (const name of ["README.md", "package.json", "Cargo.toml"]) {
    const p = join(workdir, name);
    if (existsSync(p)) {
      const body = readFileSync(p, "utf8").slice(0, 4000);
      lines.push("", `--- ${name} ---`, body);
    }
  }

  const checks = detectCheckCommands(workdir);
  if (checks.length > 0) {
    lines.push("", "DETECTED CHECK COMMANDS:", ...checks.map((c) => `  ${c}`));
  }

  // Ground gates in tools that ACTUALLY EXIST here — a gate that calls a missing
  // command exits 127 and halts the build for no real reason. The gate-inferer is
  // told to prefer present tools; `python` vs `python3` matters (many boxes lack
  // the bare `python` alias).
  const tools = await detectAvailableTools();
  lines.push(
    "",
    "AVAILABLE TOOLS (gates MUST use only these interpreters/runners — present=yes):",
    ...tools.map((t) => `  ${t.name}: ${t.present ? "yes" : "MISSING — do not use"}`),
    "Prefer the present ones. Use `python3` (not `python`) unless `python` shows present.",
  );
  return lines.join("\n");
}

/** Probe which common interpreters/test-runners exist, so gates only use present ones. */
export async function detectAvailableTools(): Promise<{ name: string; present: boolean }[]> {
  const has = async (name: string): Promise<boolean> => {
    try {
      return (await execa("command", ["-v", name], { shell: true, reject: false })).exitCode === 0;
    } catch {
      return false;
    }
  };
  const names = ["python3", "python", "pytest", "node", "npm", "go", "cargo", "rg", "bash"];
  const base = await Promise.all(names.map(async (name) => ({ name, present: await has(name) })));
  // A headless browser makes the dom-behavior gate satisfiable; without this line the
  // survey's "gates MUST use only these tools" wrongly forbids it and the planner falls
  // back to a grep stub. Detected, not assumed.
  const browserBins = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  let browser = false;
  for (const b of browserBins) if (await has(b)) { browser = true; break; }
  base.push({ name: "headless browser (enables the dom-behavior UI gate)", present: browser });
  // Playwright is HARNESS-PROVIDED for a single-file browser-behavior spec: the build
  // installs @playwright/test + chromium on demand. Advertised so the planner stops
  // treating "npx playwright test one.spec.ts" as an unavailable/forbidden tool.
  base.push({ name: "playwright (npx playwright test <one.spec.ts> — single UI-behavior spec; harness installs it)", present: true });
  return base;
}

/** Detect test/lint/build commands from package.json scripts or a Makefile. */
export function detectCheckCommands(workdir: string): string[] {
  const cmds: string[] = [];
  const pkgPath = join(workdir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      for (const key of ["test", "lint", "build", "typecheck"]) {
        if (pkg.scripts?.[key]) cmds.push(`npm run ${key}`);
      }
      // Serve scripts — the `serve` a dom-behavior gate needs to boot the app.
      for (const key of ["start", "dev", "preview", "serve"]) {
        if (pkg.scripts?.[key]) cmds.push(`npm run ${key}  # serve (for dom-behavior)`);
      }
    } catch {
      // ignore malformed package.json
    }
  }
  if (existsSync(join(workdir, "Makefile"))) {
    const mk = readFileSync(join(workdir, "Makefile"), "utf8");
    for (const target of ["test", "lint", "build", "check"]) {
      if (new RegExp(`^${target}:`, "m").test(mk)) cmds.push(`make ${target}`);
    }
  }
  return cmds;
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = stripFences(text);
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1]!.trim();
  // If extra prose surrounds the object, grab the outermost {...}.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

/** `ser derive "<goal>" [--chain <name>] [--budget <usd>] [--out <file>] [--yes] [--workdir <dir>]`. */
export async function runDerive(args: string[]): Promise<number> {
  const { positional, value, bool } = parseDeriveArgs(args);
  const goal = positional[0];
  if (!goal) throw new SquireError("USAGE", 'ser derive "<goal>" [--chain <name>] [--yes]');

  const workdir = resolve(value.get("workdir") ?? process.cwd());
  const chainName = value.get("chain") ?? "cheap";
  const budgetUsd = Number(value.get("budget") ?? "2.5");
  const outPath = resolve(value.get("out") ?? join(workdir, "mission.yaml"));

  const chains = loadChainsForDerive(workdir, value.get("chains"));
  const chain = resolveChain(chains, chainName);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY is required for squire derive");
  const { OpenRouterClient } = await import("../llm/openrouter.js");
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });

  const repoSurvey = await buildRepoSurvey(workdir);
  const { mission } = await derivePlan({
    goal,
    budgetUsd,
    chainName,
    workdir: ".",
    repoSurvey,
    llm,
    knightModel: chain.knight,
  });

  writeFileSync(outPath, yamlStringify(mission));

  // Four-line readback.
  process.stdout.write(
    [
      `done-when: ${mission.nodes.map((n) => `${n.id} (${n.done_check})`).join("; ")}`,
      `budget:    $${mission.budget_usd} across ${mission.nodes.length} node(s)`,
      `blast:     ${[...new Set(mission.nodes.flatMap((n) => n.blast_radius))].join(", ")}`,
      `chain:     ${chainName} (knight=${chain.knight})`,
      `written:   ${outPath}`,
      "",
    ].join("\n"),
  );

  if (!bool.has("yes")) {
    const ok = await confirm("proceed? [y/N] ");
    if (!ok) {
      process.stdout.write("aborted.\n");
      return 1;
    }
  }
  return 0;
}

/**
 * Resolve the chains config. Order: explicit --chains, cwd/chains.yaml,
 * workdir/chains.yaml, the global ~/.config/castellan/chains.yaml, then the
 * built-in defaults. Never throws — ser runs anywhere; the path is "<built-in
 * defaults>" when no file is found. An explicit --chains that does not exist
 * IS an error (the user named a file they expected to use).
 */
export function resolveChains(workdir: string, explicit?: string): { chains: ChainsFile; path: string } {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(explicit);
    if (!existsSync(p)) throw new SquireError("CHAINS_NOT_FOUND", `--chains file not found: ${p}`);
    return { chains: parseChains(readFileSync(p, "utf8"), p), path: p };
  }
  const candidates = [join(process.cwd(), "chains.yaml"), join(workdir, "chains.yaml"), join(configDir(), "chains.yaml")];
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : resolve(c);
    if (existsSync(p)) return { chains: parseChains(readFileSync(p, "utf8"), p), path: p };
  }
  return { chains: parseChains(DEFAULT_CHAINS_YAML, BUILTIN_CHAINS_SOURCE), path: BUILTIN_CHAINS_SOURCE };
}

export function loadChainsForDerive(workdir: string, explicit?: string): ChainsFile {
  return resolveChains(workdir, explicit).chains;
}

function parseDeriveArgs(args: string[]): {
  positional: string[];
  value: Map<string, string>;
  bool: Set<string>;
} {
  const positional: string[] = [];
  const value = new Map<string, string>();
  const bool = new Set<string>();
  const valued = ["chain", "chains", "budget", "out", "workdir"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.includes(name)) value.set(name, args[++i] ?? "");
      else bool.add(name);
    } else {
      positional.push(a);
    }
  }
  return { positional, value, bool };
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolveP) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolveP(/^y(es)?$/i.test(String(data).trim()));
    });
  });
}
