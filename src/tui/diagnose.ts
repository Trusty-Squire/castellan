/**
 * Honest-halt diagnosis for the TUI build phase. When the build stops because a check
 * could not pass — even after the ladder escalated cheap→premium — we DON'T leave the
 * user with an opaque "HALTED". Instead:
 *   1. readHaltFacts() reconstructs what actually failed from the structured trace
 *      (the failing node, its exact check command, exit code, stderr tail, reconcile
 *      mismatches, how far the ladder climbed).
 *   2. investigateHalt() runs a PREMIUM pass that leads with the most likely cause —
 *      a poorly-designed check — and explains it in plain language with a real remedy.
 */
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "../llm/types.js";
import { readTrace, summarize, type TraceEvent } from "../harness/trace.js";
import { parseMission, effectiveGate } from "../contract/schema.js";
import { tryParseJson } from "../contract/derive.js";

export interface HaltFacts {
  haltReason: string;
  failingNodeId?: string;
  gateCommand?: string;
  gateExitCode?: number;
  stderrTail?: string;
  timedOut: boolean;
  reconcileViolations: string[];
  confabulation: boolean;
  maxRung?: number;
}

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" ? (p as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Reconstruct the failure facts from the trace (and the child's stdout as a fallback). */
export function readHaltFacts(tracePath: string, captured: string[]): HaltFacts {
  let events: TraceEvent[] = [];
  try { events = readTrace(tracePath); } catch { events = []; }

  // haltReason: prefer mission_end payload; else scrape the "MISSION HALTED — <reason>" line.
  const end = [...events].reverse().find((e) => e.kind === "mission_end");
  let haltReason = str(obj(end?.payload).haltReason) ?? "";
  if (!haltReason) {
    const line = captured.find((l) => /MISSION HALTED/i.test(l));
    haltReason = line ? line.replace(/.*MISSION HALTED\s*[—-]\s*/i, "").trim() : "the build could not pass every check";
  }

  const sum = summarize(events);
  const failed = sum.nodes.find((n) => n.failed && !n.passed);
  const lastFail = [...events].reverse().find((e) => e.kind === "node_fail");
  const failingNodeId = failed?.nodeId ?? lastFail?.nodeId;

  const pick = (kind: TraceEvent["kind"]): TraceEvent | undefined =>
    [...events].reverse().find((e) => e.kind === kind && (!failingNodeId || e.nodeId === failingNodeId));
  const g = obj(pick("gate")?.payload);
  const violations = obj(pick("reconcile")?.payload).violations;

  return {
    haltReason,
    failingNodeId,
    gateCommand: str(g.command),
    gateExitCode: num(g.exitCode),
    stderrTail: str(g.stderrTail),
    timedOut: g.timedOut === true,
    reconcileViolations: Array.isArray(violations) ? violations.filter((v): v is string => typeof v === "string") : [],
    confabulation: events.some((e) => e.kind === "confabulation_flag" && e.nodeId === failingNodeId),
    maxRung: failingNodeId ? sum.nodes.find((n) => n.nodeId === failingNodeId)?.maxRung : undefined,
  };
}

/** Total node count for the live "k/N" progress, from the derived mission. null until it exists. */
export function missionNodeCount(buildDir: string): number | null {
  const mp = join(buildDir, "mission.yaml");
  if (!existsSync(mp)) return null;
  try { return parseMission(readFileSync(mp, "utf8"), mp).nodes.length; } catch { return null; }
}

/** The failing piece's brief + the exact check it was judged by, for the diagnosis. */
export function failingNodeContext(buildDir: string, nodeId?: string): { brief: string; gate: string } | null {
  if (!nodeId) return null;
  const mp = join(buildDir, "mission.yaml");
  if (!existsSync(mp)) return null;
  try {
    const mission = parseMission(readFileSync(mp, "utf8"), mp);
    const node = mission.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const gate = effectiveGate(node);
    const cmd = (gate as { run?: string }).run ?? `(${gate.type} gate)`;
    return { brief: node.brief, gate: cmd };
  } catch { return null; }
}

const DiagnosisSchema = z.object({
  cause: z.enum(["bad_check", "missing_dependency", "wrong_approach", "genuine_infeasibility"]).default("bad_check"),
  explanation: z.string().default(""),
  check_verdict: z.string().default(""),
  remedy: z.string().default(""),
  owner: z.enum(["ser", "you"]).default("ser"),
  corrected_check: z.string().default(""),
  spec_change: z.string().default(""),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

const DIAGNOSE_SYSTEM = `You are ser, explaining honestly why a verified build stopped. You speak to a NON-TECHNICAL builder in plain, calm language — no jargon, no blame, no stack traces.

A fleet of coding agents tried this ONE piece up to four times, escalating from a cheap model to the strongest available; even the strongest could not make its check pass. When that happens, the MOST LIKELY cause is that THE CHECK ITSELF IS WRONG — it tests something the brief never asked for, depends on a tool or file that doesn't exist, or is impossible to satisfy as written. So investigate the CHECK FIRST: compare what the piece was asked to do (the brief) against what the check actually verifies and the error it produced.

Classify the root cause as exactly one of:
- "bad_check": the check is mis-designed (tests the wrong thing, is unsatisfiable, or depends on something absent). OWNER = "ser" — the check is ours to fix, not the user's call. Give a "corrected_check": a better shell command that fairly verifies the brief (exit 0 = pass).
- "missing_dependency": the build needs a package/tool/setup the check assumes exists. OWNER = "ser". Put the fix in "corrected_check" or "remedy".
- "wrong_approach": the brief is sound but the planned approach can't satisfy a FAIR check. OWNER = "you" — it needs a direction change. Give "spec_change": one sentence the spec stage can act on.
- "genuine_infeasibility": what was asked cannot be built as specified. OWNER = "you". Give "spec_change": the scope/vision change needed.

NEVER suggest weakening or deleting a check just to turn it green — only CORRECTING a genuinely-wrong check so it fairly tests the brief. If the check was fair and the build simply could not meet it, say so honestly (wrong_approach or genuine_infeasibility), do not invent a check problem.

Reply ONLY JSON: {"cause":"…","explanation":"2-3 plain sentences: what the piece needed and why the check kept failing","check_verdict":"one sentence: was this check fair, and why or why not","remedy":"one concrete next step","owner":"ser|you","corrected_check":"a shell command, only if you can give a fairer check, else empty","spec_change":"one sentence for the spec stage, only if owner is you, else empty"}.`;

/** Premium, gate-first diagnosis of why the build halted. Fails safe to a default on any error. */
export async function investigateHalt(
  facts: HaltFacts,
  nodeBrief: string,
  gateCmd: string,
  llm: LlmClient,
  model: string,
): Promise<Diagnosis> {
  const user = [
    `WHAT THIS PIECE WAS ASKED TO DO (brief):\n${nodeBrief || "(unknown)"}`,
    `THE CHECK THAT KEPT FAILING:\n${gateCmd || facts.gateCommand || "(unknown)"}`,
    `CHECK EXIT CODE: ${facts.gateExitCode ?? "?"}${facts.timedOut ? " (TIMED OUT)" : ""}`,
    `CHECK ERROR OUTPUT (tail):\n${(facts.stderrTail || "(none captured)").slice(-1500)}`,
    facts.reconcileViolations.length ? `RECONCILE MISMATCHES:\n${facts.reconcileViolations.join("\n")}` : "",
    facts.confabulation ? "NOTE: an attempt claimed a check ran that never actually did." : "",
    `The fleet escalated through ${facts.maxRung ?? 4} attempts (cheap → premium); even the strongest model failed this check.`,
  ].filter(Boolean).join("\n\n");

  let res: { text: string };
  try { res = await llm.complete({ model, system: DIAGNOSE_SYSTEM, user, json: true, maxTokens: 1200 }); }
  catch { return DiagnosisSchema.parse({}); }
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return DiagnosisSchema.parse({});
  const checked = DiagnosisSchema.safeParse(parsed.value);
  return checked.success ? checked.data : DiagnosisSchema.parse({});
}
