/**
 * gate-strength — the decisive eval (the deferred Phase-1 item). A UX gate is only
 * worth authoring if it FAILS a defective impl. clairvoyance shipped because its
 * gate ("an <li> exists") passed a size-less UI. So for each UX gate the design
 * reviewer emits, we ship a complete/ fixture (should PASS) and an incomplete/
 * fixture with the defect (should FAIL), and assert both. A gate that passes the
 * incomplete impl is too weak — exactly the clairvoyance failure mode.
 *
 * Extends src/experiment/gate-attack.ts: runs the gate in a throwaway copy of the
 * fixture. Pure/LLM-free → hermetic vitest; the live script additionally checks
 * that the gate the reviewer GENERATES also fails the incomplete impl.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGate } from "../harness/gates.js";

export interface UxGateCase {
  tag: string;
  /** A runnable shell gate (exit 0 = pass), run with cwd = the fixture copy. */
  gate: string;
  /** Impl that satisfies the requirement — the gate must PASS here. */
  completeDir: string;
  /** Impl with the defect (e.g. size-less) — the gate must FAIL here. */
  incompleteDir: string;
}

export interface GateStrengthResult {
  tag: string;
  gate: string;
  passesComplete: boolean;
  failsIncomplete: boolean;
  /** A strong gate passes the complete impl AND fails the incomplete one. */
  strong: boolean;
  detail: string;
}

/** Run a gate in a throwaway copy of `fixtureDir`; returns whether it passed. */
async function runInCopy(gate: string, fixtureDir: string, timeoutMs: number): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "gate-strength-"));
  try {
    cpSync(fixtureDir, dir, { recursive: true });
    const r = await runGate(gate, dir, timeoutMs);
    return r.passed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert a gate passes the complete impl and fails the incomplete one. */
export async function checkGateStrength(
  c: UxGateCase,
  opts: { timeoutMs?: number } = {},
): Promise<GateStrengthResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const passesComplete = await runInCopy(c.gate, c.completeDir, timeoutMs);
  const failsIncomplete = !(await runInCopy(c.gate, c.incompleteDir, timeoutMs));
  const strong = passesComplete && failsIncomplete;
  const detail = strong
    ? "passes complete, fails incomplete"
    : `${passesComplete ? "" : "did NOT pass complete; "}${failsIncomplete ? "" : "did NOT fail incomplete (too weak)"}`.trim();
  return { tag: c.tag, gate: c.gate, passesComplete, failsIncomplete, strong, detail };
}

export interface GateStrengthGate {
  passed: boolean;
  strong: number;
  total: number;
  weak: string[]; // tags of gates that failed the strength check
}

/** Aggregate gate: every UX gate must be STRONG (100%). */
export function gateGateStrength(results: GateStrengthResult[]): GateStrengthGate {
  const strong = results.filter((r) => r.strong);
  const weak = results.filter((r) => !r.strong).map((r) => r.tag);
  return { passed: results.length > 0 && weak.length === 0, strong: strong.length, total: results.length, weak };
}

/**
 * Run a reviewer-GENERATED gate against the incomplete impl: a real UX gate must
 * fail there. Used by the live script to prove the design reviewer authors gates
 * with teeth, not just structure-presence greps.
 */
export async function generatedGateFailsIncomplete(
  gate: string,
  incompleteDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  return !(await runInCopy(gate, incompleteDir, opts.timeoutMs ?? 30_000));
}
