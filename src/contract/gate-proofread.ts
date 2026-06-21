/**
 * The gate SATISFIABILITY proofreader. A recurring, expensive failure: an authored gate
 * READS persisted/authenticated state it never SEEDS — an empty `SELECT … WHERE`, a
 * login as a user nobody registered — so NO build can pass it, and the executor burns its
 * whole escalation ladder discovering that. Authored gates slip this even from a premium
 * model (measured across the trustysquire probe). So the harness proofreads gates at derive
 * time and repairs the clear cases before the build ever runs them.
 *
 * HIGH PRECISION by design: only flag a read that has NO seeding mechanism at all (no
 * INSERT/store, no register/signup, no script that could populate state). A gate that can
 * set up its own preconditions is trusted — false-flagging a good gate would break a
 * working build, which is worse than missing one.
 */
import type { LlmClient } from "../llm/types.js";

/** A gate that can plausibly seed its own state — if so, we trust it and don't proofread further. */
function canSeedItself(gate: string): boolean {
  return /\bINSERT\b|\bUPDATE\b|VALUES\s*\(|\bcreate[_-]?user\b|\bregister\b|\bsign[_-]?up\b|\bstore[_-]?key\b|\.save\(|\.set\(|\bseed\b|\.\/[\w./-]+\.(sh|py|js|mjs|ts)\b|\bnode\s+[\w./-]+\.(c?js|mjs)\b|\bpython3?\s+[\w./-]+\.py\b/i.test(gate);
}

/**
 * PURE: the satisfiability issues with a gate command. Empty array = no clear problem.
 * Each issue is a human-readable reason the gate cannot be passed by ANY correct build.
 */
export function gateProofread(gate: string): string[] {
  const issues: string[] = [];
  if (!gate || canSeedItself(gate)) return issues;

  // 1. Reads a specific persisted row it never wrote → the query is empty → never passes.
  if (/\bSELECT\b[\s\S]*\bWHERE\b/i.test(gate)) {
    issues.push(
      "reads a specific row (SELECT … WHERE) but the gate never seeds it — the query is empty, so no build can pass it",
    );
  }

  // 2. Authenticates as a literal user it never registers → real auth rejects the unknown
  //    user → never passes. Needs both an auth-read shape AND an auth context to fire.
  const authReadShape = /\/login\b|["']username["']\s*:|["']email["'][\s\S]*["']password["']|-u\s+\S+:\S+/.test(gate);
  const authContext = /login|auth|token|access_token|dashboard|\/api\//i.test(gate);
  if (authReadShape && authContext) {
    issues.push(
      "authenticates as a user it never registers — a correct auth rejects the unknown user, so no build can pass it",
    );
  }
  return issues;
}

/**
 * Repair an unsatisfiable gate via the PLANNER (knight): rewrite it to seed its
 * preconditions FIRST, through the build's own interface, then make the SAME assertion.
 * Returns the corrected command, or null if the model couldn't produce one. The caller
 * re-proofreads the result and only adopts it if it now passes (and isn't vacuous).
 */
export async function repairUnsatisfiableGate(
  llm: LlmClient,
  model: string,
  args: { brief: string; contract: string; gate: string; issues: string[] },
): Promise<string | null> {
  const system =
    "You fix ONE shell gate (exit 0 = pass) that is UNSATISFIABLE because it READS state it never SEEDS. Rewrite it so it SEEDS its preconditions FIRST through the BUILD'S OWN interface — register the user via the built endpoint THEN log in; store the record via the built API or the storage module THEN read it; INSERT the row THEN SELECT it — and then makes the SAME real assertion. Keep it a SINGLE shell command (use && to chain). NEVER weaken it to a vacuous pass (no `true`, no bare `exit 0`, no `| head` swallow), and NEVER `echo` a throwaway server/script and test THAT — drive the artifact the build produces. Output ONLY the corrected shell command, no prose, no code fences.";
  const user = `SHARED CONTRACT:\n${args.contract}\n\nNODE BRIEF:\n${args.brief}\n\nUNSATISFIABLE GATE:\n${args.gate}\n\nWHY IT CAN'T PASS:\n- ${args.issues.join("\n- ")}`;
  try {
    const res = await llm.complete({ model, system, user, json: false, maxTokens: 900 });
    const cmd = res.text
      .trim()
      .replace(/^```[\w-]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}
