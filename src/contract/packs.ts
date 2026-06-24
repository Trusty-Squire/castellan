import { SquireError } from "../errors.js";
import { MissionSchema, type Mission } from "./schema.js";
import { renderGate } from "./gate-patterns.js";
import { detectCheckCommands } from "./derive.js";

/**
 * Mission packs (SPEC-v0.2 §7): parameterized missions built MECHANICALLY —
 * no LLM, no tokens. `ser do` = a single gated goal; `ser fix` = the
 * repro-then-fix pack (the repro is the gate).
 */

export interface DoOptions {
  gate?: string;
  radius?: string[];
  budgetUsd?: number;
  chain?: string;
}

/** One-node mission: the bit-by-bit developer's front door. Zero YAML. */
export function buildDoMission(goal: string, workdir: string, opts: DoOptions = {}): Mission {
  let gateRun = opts.gate;
  if (!gateRun) {
    const detected = detectCheckCommands(workdir);
    gateRun = detected[0];
    if (!gateRun) {
      throw new SquireError(
        "NO_GATE",
        "no check command detected in this repo (no package.json test/lint/build script or Makefile target) — supply one with --gate",
      );
    }
  }
  return MissionSchema.parse({
    goal,
    budget_usd: opts.budgetUsd ?? 1.0,
    chain: opts.chain ?? "cheap",
    workdir: ".",
    nodes: [
      {
        id: "do",
        brief: goal,
        context_globs: opts.radius ?? [],
        // A24: quick mode defaults to an open radius — single supervised goal,
        // the user is present; tighten with --radius for anything sharper.
        blast_radius: opts.radius ?? ["**"],
        gate: renderGate("tests-pass", { testCmd: gateRun }),
        budget_usd: opts.budgetUsd ?? 1.0,
      },
    ],
  });
}

export interface FixOptions {
  testCmd?: string;
  testFile?: string;
  radius?: string[];
  budgetUsd?: number;
  chain?: string;
  /** Source globs to PACK as context + the fix node's default writable set. Defaults to ["src/**"];
   *  set per-repo for non-src layouts (e.g. ["requests/**"] for psf/requests). */
  srcGlobs?: string[];
}

/**
 * Repro-then-fix (phase 3): node 1 writes a FAILING repro test (gate: the
 * suite must fail with an assertion signature, not a fixture crash); node 2
 * fixes (gate: repro passes + suite green + repro diff-guarded). The bug
 * report's repro IS the gate.
 */
export function buildFixMission(bug: string, workdir: string, opts: FixOptions = {}): Mission {
  const detected = detectCheckCommands(workdir);
  const testCmd = opts.testCmd ?? detected[0];
  if (!testCmd) {
    throw new SquireError("NO_GATE", "no test command detected — supply one with --test-cmd");
  }
  const testFile = opts.testFile ?? "test/repro.test.ts";
  const budget = opts.budgetUsd ?? 1.5;
  const srcGlobs = opts.srcGlobs ?? ["src/**"];
  // The repro lives next to the test file, whatever the repo's layout (test/, tests/, …).
  const testDir = testFile.includes("/") ? testFile.slice(0, testFile.lastIndexOf("/")) : ".";
  const testGlob = testDir === "." ? testFile : `${testDir}/**`;
  // The package/module the repro MUST exercise (top dir of the first source glob) — used by the
  // repro gate to reject a vacuous self.fail() repro that imports nothing real. "src" is the generic
  // TS root (imports are relative there) → no check.
  const pkg = (srcGlobs[0] ?? "").split("/")[0]!.replace(/\*+$/, "");
  const exercises = pkg && pkg !== "src" && !pkg.includes("*") ? pkg : undefined;

  return MissionSchema.parse({
    goal: `Fix bug: ${bug}`,
    budget_usd: budget,
    chain: opts.chain ?? "cheap",
    workdir: ".",
    nodes: [
      {
        id: "repro",
        brief:
          `Write a failing test at ${testFile} that REPRODUCES this bug: "${bug}". ` +
          `It MUST import the real code under test${exercises ? ` (the \`${exercises}\` package)` : ""} and CALL the specific ` +
          `function/method the bug is in with concrete inputs, then assert on the COMPUTED result — so ` +
          `that once the defect is fixed the test PASSES. Do NOT write a hardcoded self.fail()/assert ` +
          `False/throw — that exercises nothing and can never pass. Prefer a UNIT test of the exact ` +
          `function over an integration test that needs a network/server/external service the sandbox ` +
          `lacks. The test must fail now with an assertion failure (not a crash, not a missing-file ` +
          `error). Create any directories you need with recursive mkdir. Do not fix the bug in this step.`,
        context_globs: [...srcGlobs, testGlob],
        blast_radius: [testGlob],
        // A25: repro gates demand an assertion-failure signature and reject fixture crashes — the
        // dogfood lesson applied to bug repros — AND (SWE-bench) reject a vacuous repro that imports
        // nothing real (exercises), so the fix node can't be handed an unsatisfiable self.fail() gate.
        gate: renderGate("fail-for-the-right-reason", {
          testFile,
          testCmd: `${testCmd} ${testFile}`,
          mustMatch: "AssertionError|expected|FAIL",
          mustNotMatch: "ENOENT",
          ...(exercises ? { exercises } : {}),
        }),
        budget_usd: budget * 0.4,
      },
      {
        id: "fix",
        brief:
          `A failing repro test at ${testFile} demonstrates this bug: "${bug}". ` +
          `Fix the underlying defect so the repro passes and the whole suite stays green. ` +
          `Do not modify the repro test.`,
        deps: ["repro"],
        context_globs: [...srcGlobs, testFile],
        blast_radius: opts.radius ?? srcGlobs,
        gate: renderGate("tests-pass", {
          testCmd,
          guardPaths: [testFile],
        }),
        budget_usd: budget * 0.6,
      },
    ],
  });
}
