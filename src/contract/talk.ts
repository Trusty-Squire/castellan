import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, basename, join, isAbsolute } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { SquireError } from "../errors.js";
import type { LlmClient } from "../llm/types.js";
import { parseMission } from "./schema.js";
import { parseSpec, unverifiedLoadBearing, type Spec } from "./spec.js";
import { checkSpec, verifyClaim, type DeltaBatch } from "./spec-session.js";
import { deriveV2 } from "./derive2.js";
import { scoreSpec, renderScoreLine } from "./spec-score.js";
import { autofillSpec } from "./autofill.js";

/**
 * The unified interface (`ser talk`): one conversation across all tools.
 * The delta mapper REQUESTS a harness command via batch.action; this module
 * executes it mechanically and returns the harness's own report lines. The
 * model never performs work and never reports results — gates do.
 */

export type TalkAction = DeltaBatch["action"];

export interface TalkActionContext {
  specPath: string;
  llm: LlmClient;
  /** Cheap executor model — derive/verify stages run on it. */
  executorModel: string;
  chainName: string;
  budgetUsd?: number;
  /** Runs a compiled mission with the full harness; injected by the CLI. */
  execute?: (missionPath: string) => Promise<number>;
  /** One-keystroke spend confirmation; absent or false = run cancelled. */
  confirm?: (question: string) => Promise<boolean>;
}

export function missionPathFor(specPath: string): string {
  return specPath.replace(/\.spec\.yaml$/, "") + ".mission.yaml";
}

/** A fresh spec: TODO placeholders the conversation replaces (thesis pins
 * from the first real idea; R1 stays tier 0 until a gate is decided). */
export function blankSpec(thesis?: string): object {
  return {
    thesis: thesis ?? "TODO: one paragraph — pinned; drift is flagged against this",
    scope_fence: [],
    requirements: [{ id: "R1", statement: "TODO", acceptance: { tier: 0 } }],
    decisions: [],
    claims: [],
    open_questions: [{ id: "Q1", text: "what is the first requirement's objective check?", blocking: true }],
  };
}

/**
 * Resolve the session's spec file: the explicit arg (created if missing),
 * the sole *.spec.yaml in cwd, or a fresh one named after the directory.
 * Talk is ALWAYS runnable — a missing spec is a reason to create one, not
 * a usage error.
 */
export function ensureSpecFile(cwd: string, explicit?: string): { path: string; created: boolean } {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : join(cwd, explicit);
    if (existsSync(p)) return { path: p, created: false };
    writeFileSync(p, yamlStringify(blankSpec()));
    return { path: p, created: true };
  }
  const specs = readdirSync(cwd).filter((f) => f.endsWith(".spec.yaml"));
  if (specs.length === 1) return { path: join(cwd, specs[0]!), created: false };
  if (specs.length > 1) {
    throw new SquireError("USAGE", `multiple specs here (${specs.join(", ")}) — ser talk <file>`);
  }
  const name = basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-") || "product";
  const p = join(cwd, `${name}.spec.yaml`);
  writeFileSync(p, yamlStringify(blankSpec()));
  return { path: p, created: true };
}

/** Compile the spec; returns the mission path on success, null on refusal. */
async function deriveSpec(ctx: TalkActionContext, lines: string[]): Promise<string | null> {
  const spec = parseSpec(readFileSync(ctx.specPath, "utf8"), ctx.specPath);
  const result = await deriveV2({
    spec,
    workdir: dirname(ctx.specPath),
    llm: ctx.llm,
    model: ctx.executorModel,
    chainName: ctx.chainName,
    budgetUsd: ctx.budgetUsd ?? 2.5,
  });
  if (!result.ok) {
    for (const r of result.reasons) lines.push(`refused: ${r}`);
    for (const rem of result.remediations) {
      lines.push(`  ${rem.requirement}: ${rem.options.map((o) => o.split(":")[0]).join(" | ")}`);
    }
    return null;
  }
  const mp = missionPathFor(ctx.specPath);
  writeFileSync(mp, yamlStringify(result.mission));
  lines.push(result.readback, `mission written: ${mp}`);
  if (result.costUsd !== undefined) {
    lines.push(`planner spend: $${result.costUsd.toFixed(4)} (actual, provider-reported)`);
  }
  return mp;
}

/** A requirement's gate in plain words — what proves it works — not raw shell. */
function gateLabel(a: Spec["requirements"][number]["acceptance"]): string {
  if (a.tier === 0) return "no check yet ⚠";
  if (a.tier === 4) return `human-reviewed (${a.artifact})`;
  return `auto-checked: ${a.gate}`;
}

/**
 * The plan in plain words. Leads with the COMPONENTS — what actually gets
 * built — in legible language, each with how it's proven (not a raw shell
 * command). Then the decisions the user can veto, the stories served, and
 * anything still open. Terse but complete.
 */
export function renderPlan(spec: Spec): string[] {
  const lines: string[] = [];
  lines.push(`thesis: ${spec.thesis}`);
  lines.push("");
  lines.push(`components — what gets built (${spec.requirements.length}):`);
  spec.requirements.forEach((r, i) => {
    lines.push(`  ${i + 1}. ${r.statement}`);
    lines.push(`       proven by: ${gateLabel(r.acceptance)}`);
  });
  if (spec.decisions.length > 0) {
    lines.push("");
    lines.push(`decisions (yours to veto — say "undo" or correct any, ${spec.decisions.length}):`);
    for (const d of spec.decisions) lines.push(`  • ${d.statement}`);
  }
  if (spec.stories.length > 0) {
    lines.push("");
    lines.push(`user stories (${spec.stories.length}):`);
    for (const s of spec.stories) lines.push(`  • ${s}`);
  }
  const blocking = spec.open_questions.filter((q) => q.blocking);
  if (blocking.length > 0) {
    lines.push("");
    lines.push(`still open (${blocking.length}):`);
    for (const q of blocking) lines.push(`  ? ${q.text}`);
  }
  return lines;
}

/**
 * When nothing is open to ask, the model must not pose a fork (it contradicts
 * "buildable"). Drop a trailing question, keeping the lock-in before it; the
 * harness's own ✓/next-step line carries the conversation. Empty if the reply
 * was nothing but a question.
 */
export function stripTrailingQuestion(reply: string): string {
  const t = reply.trimEnd();
  if (!t.endsWith("?")) return reply;
  const cut = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("\n"));
  return cut > 0 ? t.slice(0, cut + 1).trimEnd() : "";
}

// ── The funnel: idea → build → polish (surfaced as a per-turn stage line) ──
// IDEA  = shape it: components, decisions, and VERIFY the load-bearing claims.
// BUILD = make it real: compile + run gated, harden gates, fix what they flag.
// POLISH= make it good: a designer's-eye review of the product (gstack-style).
export type Stage = "idea" | "build" | "polish";

/** Where the conversation is. idea until buildable; build once it compiles;
 *  polish once it has been built at least once this session. */
export function funnelStage(ready: boolean, built: boolean): Stage {
  if (built) return "polish";
  return ready ? "build" : "idea";
}

/** The single most useful next move for the current stage. */
export function funnelNext(spec: Spec, stage: Stage): string {
  if (stage === "polish") return "design review — a designer's eye on the product";
  if (stage === "build") return 'say "build it" to run the gated build';
  // idea: surface the one thing still keeping it from buildable
  const bq = spec.open_questions.find((q) => q.blocking);
  if (bq) return `answer: ${bq.text}`;
  const t0 = spec.requirements.find((r) => r.acceptance.tier === 0);
  if (t0) return `give ${t0.id} an objective check`;
  const claim = unverifiedLoadBearing(spec)[0];
  if (claim) return `verify the load-bearing claim: ${claim.claim}`;
  return "keep shaping it";
}

/** The compact stage line: ✓ done · ● current · ○ ahead, plus the next move. */
export function renderFunnel(stage: Stage, next: string): string {
  const order: Stage[] = ["idea", "build", "polish"];
  const ci = order.indexOf(stage);
  const mark = (s: Stage): string => {
    const i = order.indexOf(s);
    const lit = i === ci ? `● ${s.toUpperCase()}` : s;
    return i < ci ? `✓ ${s}` : lit;
  };
  return `${order.map(mark).join("  ▸  ")}    next: ${next}`;
}

export async function dispatchAction(
  action: TalkAction,
  arg: string,
  ctx: TalkActionContext,
): Promise<string[]> {
  const lines: string[] = [];
  switch (action) {
    case "none":
      return lines;

    case "status":
    case "check": {
      const spec = parseSpec(readFileSync(ctx.specPath, "utf8"), ctx.specPath);
      if (action === "status") lines.push(...renderPlan(spec));
      lines.push(...checkSpec(spec).lines);
      return lines;
    }

    case "score": {
      const spec = parseSpec(readFileSync(ctx.specPath, "utf8"), ctx.specPath);
      const s = await scoreSpec(spec, { llm: ctx.llm, model: ctx.executorModel });
      lines.push(renderScoreLine(s));
      for (const imp of s.improvements.slice(1, 6)) {
        lines.push(`  [${imp.severity}/${imp.dimension}] ${imp.problem}\n    → ${imp.suggestion}`);
      }
      return lines;
    }

    case "verify": {
      const spec = parseSpec(readFileSync(ctx.specPath, "utf8"), ctx.specPath);
      const claimId = arg || unverifiedLoadBearing(spec)[0]?.claim;
      if (!claimId) return ["nothing to verify — no unverified load-bearing claims"];
      const r = await verifyClaim(spec, claimId, ctx.llm, ctx.executorModel);
      writeFileSync(ctx.specPath, yamlStringify(r.spec));
      return [`${claimId}: ${r.verdict}`, `  ${r.evidence}`];
    }

    case "derive": {
      await deriveSpec(ctx, lines);
      return lines;
    }

    case "run": {
      if (!ctx.execute) return ["run is not available in this session"];
      // Readiness is a gate: a thin spec compiles into a coarse, stub-passable
      // plan. Below threshold we either surface the gaps (default) or — when
      // the user says "build it anyway" (arg "auto"/"force") — autonomously
      // fill what we can before spending anything.
      const force = arg === "auto" || arg === "force";
      let s = await scoreSpec(parseSpec(readFileSync(ctx.specPath, "utf8"), ctx.specPath), {
        llm: ctx.llm,
        model: ctx.executorModel,
      });
      if (!s.ready && !force) {
        const blockers = s.improvements.filter((i) => i.severity === "blocking");
        lines.push(
          `not building yet — ${blockers.length} requirement(s)/decision(s) not buildable (need an eval gate, ` +
            `a resolved question, or a feasible claim). Close these, or say "build it anyway" and I'll fill them:`,
        );
        for (const imp of blockers.slice(0, 4)) {
          const lead = imp.needsUser ? "decide" : "ser can do";
          lines.push(`  [${imp.dimension}, ${lead}] ${imp.problem}\n    → ${imp.suggestion}`);
        }
        return lines;
      }
      if (!s.ready && force) {
        lines.push(`spec not buildable yet — filling the gaps myself...`);
        const r = await autofillSpec(ctx.specPath, ctx.llm, ctx.executorModel);
        lines.push(`autofilled ${r.applied.length} edit(s) over ${r.rounds} round(s)`);
        for (const def of r.defaults) lines.push(`  ${def} (undo to change)`);
        for (const ref of r.refutedClaims) lines.push(`  ⚠ feasibility REFUTED — ${ref.id}: ${ref.evidence}`);
        s = r.finalScore;
        if (!s.ready) {
          const blockers = s.improvements.filter((i) => i.severity === "blocking");
          lines.push(`still not buildable — ${blockers.length} blocker(s) need you:`);
          for (const imp of blockers.slice(0, 4)) {
            lines.push(`  [${imp.needsUser ? "decide" : imp.dimension}] ${imp.problem}\n    → ${imp.suggestion}`);
          }
          return lines;
        }
        lines.push(`every requirement now gated — building.`);
      }
      let mp = missionPathFor(ctx.specPath);
      const stale = !existsSync(mp) || statSync(mp).mtimeMs < statSync(ctx.specPath).mtimeMs;
      if (stale) {
        const derived = await deriveSpec(ctx, lines);
        if (!derived) return lines; // refusal — spec not ready, nothing runs
        mp = derived;
      }
      const mission = parseMission(readFileSync(mp, "utf8"), mp);
      const confirmed = ctx.confirm
        ? await ctx.confirm(
            `run "${mission.goal}" — ${mission.nodes.length} node(s), budget $${mission.budget_usd}, chain ${mission.chain}?`,
          )
        : false;
      if (!confirmed) {
        lines.push("run cancelled (not confirmed)");
        return lines;
      }
      const code = await ctx.execute(mp);
      lines.push(code === 0 ? "mission complete — every gate green" : "mission halted — see trace above");
      return lines;
    }
  }
}
