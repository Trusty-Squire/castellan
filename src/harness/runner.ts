import type { ChainsFile, Mission } from "../contract/schema.js";
import { resolveChain, topoSort, effectiveGate, type MissionNode } from "../contract/schema.js";
import type { Engine, AttemptRecord, ToolCallRecord, ToolName } from "../engine/types.js";
import { Trace } from "./trace.js";
import { packContext } from "./context.js";
import { scaffoldDomGate } from "./dom-gate.js";
import { scaffoldServeGate } from "./serve-gate.js";
import { reconcile } from "./reconcile.js";
import { executeGate, DEFAULT_GATE_TIMEOUT_MS, type Adjudicator } from "./gates.js";
import { BudgetMeter } from "./budget.js";
import { ladder, buildFailureContext, type FailureInfo } from "./escalate.js";
import {
  head,
  commitNode,
  resetTo,
  changedFilesSince,
  diffSince,
  addGitExclude,
  listFiles,
} from "./checkpoint.js";

/** Executor system prompt — Appendix B, plus a standard-work clause (build the simplest
 *  thing that passes the gate), added after observing the cheap model OVER-ENGINEER a node
 *  it could otherwise pass: it reached for cipher key/IV machinery when the gate only checked
 *  a secret wasn't stored in plaintext (a one-line base64 passes), and flailed. The gate is
 *  the work instruction; the worker's job is the least code that satisfies it. */
export const EXECUTOR_SYSTEM_PROMPT = `You are a Squire: a focused coding agent executing ONE task.
You have four tools: read, write, edit, bash.
Work only within the paths you are told are writable.
When using write, the content argument is the exact file body. Do not write
JSON, Python dict/list literals, markdown fences, or summaries unless the target
file is actually that format. For .js files, write valid JavaScript source; if a
gate uses require('./file.js'), export with CommonJS module.exports.
THE GATE IS YOUR COMPLETE DEFINITION OF DONE. Implement the SIMPLEST change that makes it
exit 0 — and stop. Do NOT add robustness, abstraction, or machinery the gate does not check:
if it only checks a secret is not stored in plaintext, a simple reversible encoding (e.g.
base64) suffices — do NOT manage cipher keys/IVs or install crypto packages; if it checks a
value is returned, just return it. Over-engineering beyond the gate is a top cause of failure
— more moving parts mean more to get wrong. Prefer the language's BUILT-INS over installing a
dependency whenever they suffice.
Run the check command yourself before declaring done; if it
fails, fix and re-run. Declare done only when it exits 0.
Your final message: one short paragraph stating what changed
(file list) and the check result. Claim nothing you did not do;
your tool calls are audited against your claims.

If, after genuinely attempting it, you conclude the CHECK or the TASK itself is
wrong — self-contradictory, impossible, or in conflict with the shared contract
(NOT merely hard) — do NOT fake a pass or flail. Instead end your final message
with exactly one line in this form:
DISPUTE: <gate|brief>: <one sentence naming the specific contradiction, with evidence>
A stronger model will be asked to confirm it, so raise a dispute ONLY when you can
point to the concrete contradiction — an unsubstantiated dispute just wastes a turn.`;

/** A node's structured push-back: the brief or gate it was handed is mis-specified. */
export interface NodeDispute {
  target: "gate" | "brief";
  evidence: string;
}

const DISPUTE_RE = /DISPUTE:\s*(gate|brief)\s*:\s*([^\n]+)/i;

/** Max retries of a rung when the provider errors transiently before any work is done. */
const MAX_TRANSIENT_RETRIES = 3;

/** Parse a dispute the builder raised in its final message. Requires real evidence
 *  (not a bare "DISPUTE: gate:") so an empty cry-wolf doesn't register. */
export function parseDispute(finalMessage: string): NodeDispute | null {
  const m = DISPUTE_RE.exec(finalMessage ?? "");
  if (!m) return null;
  const evidence = m[2]!.trim();
  if (evidence.length < 8) return null;
  return { target: m[1]!.toLowerCase() as "gate" | "brief", evidence };
}

/** The orchestrator's verdict on a node's dispute. */
export interface DisputeReview {
  /** True = the dispute is valid; the gate/brief was genuinely mis-specified. */
  upheld: boolean;
  /** When upheld: a corrected, READY-TO-RUN gate command (caller scaffold-wraps it). */
  gate?: string;
  reason: string;
}

/**
 * Adjudicates a node's dispute. Supplied by the funnel (which owns the planner/LLM)
 * so the runner stays engine/LLM-agnostic. An upheld review returns a corrected gate;
 * the runner then re-allocates the node to the SAME cheap executor — a wrong gate is
 * a planning defect, so it should NOT cost an escalation to opus.
 */
export type DisputeReviewer = (input: {
  nodeId: string;
  brief: string;
  gate: string;
  dispute: NodeDispute;
}) => Promise<DisputeReview>;


/** Command string for reconcile's confabulation matching ("" for human/judge gates). */
function gateCommandOf(node: MissionNode): string {
  return effectiveGate(node).run ?? "";
}

/**
 * Later nodes often refine a file created by an earlier node. The planner can
 * forget to list that writable file in context_globs, which leaves stronger
 * escalation rungs staring at fixtures instead of the broken implementation.
 * Include literal blast-radius paths as context; skip broad globs to avoid
 * packing an entire large repo when a node is allowed to touch src/**.
 */
function effectiveContextGlobs(node: MissionNode): string[] {
  const globs = new Set(node.context_globs);
  for (const path of node.blast_radius) {
    if (isLiteralPathGlob(path)) globs.add(path);
  }
  return [...globs];
}

function isLiteralPathGlob(path: string): boolean {
  return !/[*?[\]{}!]/.test(path);
}

export interface NodeOutcome {
  nodeId: string;
  passed: boolean;
  attempts: number;
  maxRung: number;
  blastDenied: number;
  confabulations: number;
  costUsd: number;
  gateExitCode?: number;
}

export interface MissionResult {
  missionId: string;
  completed: boolean;
  halted: boolean;
  haltReason?: string;
  nodes: NodeOutcome[];
  committedNodeIds: string[];
  totalCostUsd: number;
  tracePath: string;
}

export interface RunMissionOptions {
  mission: Mission;
  chains: ChainsFile;
  engine: Engine;
  /** Effective working directory: a ready git repo. */
  workdir: string;
  missionId: string;
  tracePath: string;
  chainNameOverride?: string;
  apiKey?: string;
  baseUrl?: string;
  gateTimeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Override the chain's harness mode. "off" runs the ablation (raw, goal-only). */
  harnessMode?: "on" | "off";
  /** Tier-4 human-gate adjudicator (SPEC-v0.2 §4). Absent in unattended contexts. */
  adjudicate?: Adjudicator;
  /** Adjudicates a node's DISPUTE that its gate/brief is mis-specified. When present,
   *  an upheld dispute repairs the gate and re-runs the SAME cheap executor (no
   *  escalation). Absent → a dispute just re-attributes the honest halt. */
  disputeReviewer?: DisputeReviewer;
}

/**
 * Mission executor — the node state machine (SPEC §5).
 * PENDING → PACKED → RUNNING → RECONCILING → GATING → COMMITTED | RESET → (escalate | HALT).
 */
export async function runMission(opts: RunMissionOptions): Promise<MissionResult> {
  const { mission, chains, engine, workdir, missionId, tracePath } = opts;
  const log = opts.log ?? (() => {});
  const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const chainName = opts.chainNameOverride ?? mission.chain;
  const chain = resolveChain(chains, chainName);

  // Ablation: harness OFF runs a single raw, goal-only attempt (no nodes, no
  // gates mid-run, no checkpoints, no blast radius, no escalation), then scores.
  const harnessMode = opts.harnessMode ?? chain.harness;
  if (harnessMode === "off") {
    return runRaw(opts, chainName, chain.executor, chain.budget_scale);
  }

  let rungs = ladder(chain);
  // SER_NO_KNIGHT: cap the ladder at the CHEAP rungs (drop any rung that runs the knight) so a
  // test measures whether the cheap models pass ON THEIR OWN — a knight rescue isn't a
  // cheap-model pass. Keep at least rung 1 so the node still runs.
  if (process.env.SER_NO_KNIGHT && process.env.SER_NO_KNIGHT !== "0") {
    const cheapRungs = rungs.filter((r) => r.model !== chain.knight);
    rungs = cheapRungs.length > 0 ? cheapRungs : rungs.slice(0, 1);
  }

  // Keep harness artifacts out of git: never staged by `git add -A`, never
  // removed by `git clean -fd` during a node reset.
  addGitExclude(workdir, [".squire/", ".squire"]);
  // Drop the self-contained dom-behavior + serve-gate runners into .squire/ so a
  // frontend gate or a boot-wrapped HTTP gate runs with bare `node` (no `ser` on PATH,
  // no deps). Survives the per-rung reset.
  scaffoldDomGate(workdir);
  scaffoldServeGate(workdir);

  const trace = new Trace(tracePath, missionId, { now: opts.now });
  const scale = chain.budget_scale;
  const budget = new BudgetMeter(chains.prices, mission.budget_usd * scale);

  trace.append("mission_start", {
    payload: { goal: mission.goal, chain: chainName, budgetUsd: mission.budget_usd * scale, budgetScale: scale, workdir },
    costUsdSoFar: 0,
  });

  let lastGreen = await head(workdir);
  const order = topoSort(mission.nodes);
  const committed = new Set<string>();
  const outcomes: NodeOutcome[] = [];
  let halted = false;
  let haltReason: string | undefined;

  for (const node of order) {
    if (halted) break;

    // A node runs only when all deps are COMMITTED (topo order guarantees
    // deps precede; if any failed we'd already have halted).
    if (!node.deps.every((d) => committed.has(d))) {
      halted = true;
      haltReason = `node "${node.id}" cannot run: unmet deps`;
      break;
    }

    budget.beginNode(node.budget_usd * scale);
    const outcome: NodeOutcome = {
      nodeId: node.id,
      passed: false,
      attempts: 0,
      maxRung: 0,
      blastDenied: 0,
      confabulations: 0,
      costUsd: 0,
    };
    outcomes.push(outcome);

    let failure: FailureInfo | undefined;
    let priorDiff: string | undefined;
    // The most recent rung's dispute (if any). The ladder runs weakest→strongest,
    // so a dispute that survives to the LAST rung that ran is the strongest model's
    // verdict — that's the substantiation. A weak model that cries "bad gate" but is
    // then overruled by a stronger rung that simply tries (no dispute) is cleared.
    let lastDispute: (NodeDispute & { rung: number; model: string }) | undefined;
    // Node-level retry: a substantiated dispute repairs the gate and re-runs the SAME
    // ladder from rung 1 (the cheap executor) — it does NOT escalate. Bounded so a
    // pathological dispute loop can't spin.
    let gateRepairsLeft = opts.disputeReviewer ? 2 : 0;
    let rerunLadder = true;
    while (rerunLadder) {
      rerunLadder = false;
      failure = undefined;
      priorDiff = undefined;
      lastDispute = undefined;

    for (const rung of rungs) {
      outcome.attempts = rung.rung;
      outcome.maxRung = rung.rung;
      trace.append("node_start", {
        nodeId: node.id,
        attempt: rung.rung,
        rung: rung.rung,
        payload: { model: rung.model },
        costUsdSoFar: budget.globalSpent(),
      });

      // Each FRESH attempt is preceded by a reset to the last green checkpoint.
      // For rung > 1 this reverts the previous failed attempt (RESET state).
      // A REPAIR rung is the exception: it KEEPS the prior attempt's (failed) working tree so the
      // same model can fix only what the gate reported, instead of rewriting from scratch.
      if (rung.repair) {
        trace.append("repair", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { model: rung.model, keptWorkdir: true },
          costUsdSoFar: budget.globalSpent(),
        });
      } else {
        await resetTo(workdir, lastGreen);
        if (rung.rung > 1) {
          trace.append("reset", {
            nodeId: node.id,
            rung: rung.rung,
            payload: { to: lastGreen },
            costUsdSoFar: budget.globalSpent(),
          });
        }
      }

      const pack = packContext({
        workdir,
        globs: effectiveContextGlobs(node),
        maxTokens: node.max_context_tokens,
      });
      trace.append("pack", {
        nodeId: node.id,
        rung: rung.rung,
        payload: {
          files: pack.files.map((f) => f.path),
          truncated: pack.truncated,
          droppedFiles: pack.droppedFiles,
          estTokens: pack.estTokens,
        },
        costUsdSoFar: budget.globalSpent(),
      });

      // A truncated pack means the node's context no longer fits the executor's
      // envelope — a PLANNING defect surfaced at run time (the node was sized too
      // coarse, or its context_globs are too broad). We do NOT mutate the DAG inline
      // (that's a scheduler rewrite); we HALT honestly with a diagnostic so the funnel
      // can re-derive the remaining nodes from the last green checkpoint. The dropped
      // files vs. the glob set let a reader tell real over-scope from a sloppy glob.
      if (pack.truncated) {
        halted = true;
        haltReason =
          `node "${node.id}" over-scoped at run time: context packed to ~${pack.estTokens} tokens over the ${node.max_context_tokens}-token envelope, ` +
          `dropping ${pack.droppedFiles.length} file(s) [${pack.droppedFiles.slice(0, 5).join(", ")}${pack.droppedFiles.length > 5 ? ", …" : ""}]. ` +
          `Re-derive this node smaller or narrow its context_globs (${effectiveContextGlobs(node).join(", ")}).`;
        trace.append("budget_stop", {
          nodeId: node.id,
          rung: rung.rung,
          payload: {
            scope: "context",
            estTokens: pack.estTokens,
            maxTokens: node.max_context_tokens,
            droppedFiles: pack.droppedFiles,
          },
          costUsdSoFar: budget.globalSpent(),
        });
        break;
      }

      let brief = node.brief;
      if (rung.addFailureContext && failure) {
        brief +=
          "\n\n" +
          buildFailureContext({
            ...failure,
            priorDiff: rung.addPriorDiff ? priorDiff : undefined,
            repair: rung.repair,
          });
      }

      const req = {
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        brief,
        files: pack.files,
        cwd: workdir,
        model: { slug: rung.model, apiKey: opts.apiKey, baseUrl: opts.baseUrl },
        tools: { blastRadius: node.blast_radius },
        maxTokens: node.max_context_tokens,
        nodeId: node.id,
        rung: rung.rung,
        doneCheck: gateCommandOf(node),
      };

      // Retry a TRANSIENT provider error (a 500/429/overload blip) that struck BEFORE the
      // worker did any work — otherwise a momentary infra hiccup burns a whole escalation rung
      // (measured: a provider 500 outage killed all 4 rungs of a node that passes when the
      // provider is healthy — every model, opus included, so it's the provider, not the model).
      // Only retry when no tool ran (zero side effects to duplicate); backoff between tries.
      let consumed = await consumeAttempt(engine.runAttempt(req), {
        trace,
        nodeId: node.id,
        rungModel: rung.model,
        rungNumber: rung.rung,
        budget,
      });
      for (
        let retry = 1;
        retry <= MAX_TRANSIENT_RETRIES &&
        consumed.record.errored &&
        consumed.record.toolCalls.length === 0 &&
        isTransientProviderError(consumed.record.errorMessage) &&
        !consumed.globalBudgetExceeded;
        retry++
      ) {
        const backoffMs = 1000 * 2 ** (retry - 1);
        trace.append("provider_retry", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { attempt: retry, error: consumed.record.errorMessage, backoffMs },
          costUsdSoFar: budget.globalSpent(),
        });
        await sleep(backoffMs);
        consumed = await consumeAttempt(engine.runAttempt(req), {
          trace,
          nodeId: node.id,
          rungModel: rung.model,
          rungNumber: rung.rung,
          budget,
        });
      }
      const record = consumed.record;
      outcome.blastDenied += record.blastDeniedCount;
      outcome.costUsd = budget.nodeSpent();

      // Global hard cap → MISSION_HALTED immediately, state preserved.
      if (consumed.globalBudgetExceeded) {
        trace.append("budget_stop", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { scope: "global", globalUsd: budget.globalSpent(), capUsd: mission.budget_usd },
          costUsdSoFar: budget.globalSpent(),
        });
        halted = true;
        haltReason = `global budget cap $${mission.budget_usd} exceeded`;
        break;
      }

      const changed = await changedFilesSince(workdir, lastGreen);
      const rec = reconcile({
        blastRadius: node.blast_radius,
        doneCheck: gateCommandOf(node),
        changedFiles: changed,
        record,
      });
      trace.append("reconcile", {
        nodeId: node.id,
        rung: rung.rung,
        payload: {
          violations: rec.violations,
          missingFromDiff: rec.missingFromDiff,
          outOfRadius: rec.outOfRadius,
        },
        costUsdSoFar: budget.globalSpent(),
      });
      if (rec.confabulation) {
        outcome.confabulations += 1;
        trace.append("confabulation_flag", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { finalMessage: record.finalMessage.slice(0, 500) },
          costUsdSoFar: budget.globalSpent(),
        });
      }

      const gate = await executeGate(effectiveGate(node), {
        cwd: workdir,
        nodeId: node.id,
        brief: node.brief,
        timeoutMs: gateTimeoutMs,
        adjudicate: opts.adjudicate,
      });
      outcome.gateExitCode = gate.exitCode;
      trace.append("gate", {
        nodeId: node.id,
        rung: rung.rung,
        payload: {
          command: gate.command,
          gateType: gate.gateType ?? "command",
          exitCode: gate.exitCode,
          passed: gate.passed,
          timedOut: gate.timedOut,
          stdoutTail: gate.stdoutTail,
          stderrTail: gate.stderrTail,
          verdict: gate.verdict ?? null,
        },
        costUsdSoFar: budget.globalSpent(),
      });
      if (gate.judgeFlag) {
        trace.append("judge_flag", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { flag: gate.judgeFlag },
          costUsdSoFar: budget.globalSpent(),
        });
      }

      const nodeBudgetHit = consumed.nodeBudgetExceeded;
      // A node whose gate PASSED is done and verified — commit it even if the
      // attempt ran over its per-node budget. The per-node cap gates STARTING
      // another attempt (below), not discarding completed+verified work; the
      // global cap is the hard mission stop. (Without this, an expensive model
      // gets cap-killed on work it actually finished.)
      const nodePass = gate.passed && rec.violations.length === 0;

      if (nodePass) {
        const sha = await commitNode(workdir, node.id);
        lastGreen = sha;
        committed.add(node.id);
        outcome.passed = true;
        trace.append("checkpoint", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { sha },
          costUsdSoFar: budget.globalSpent(),
        });
        trace.append("node_pass", {
          nodeId: node.id,
          rung: rung.rung,
          // The gate passed but the attempt ran over its per-node budget: we
          // keep the verified work and flag it (a warning, not a failure).
          payload: nodeBudgetHit
            ? { over_budget_committed: true, nodeUsd: budget.nodeSpent(), capUsd: node.budget_usd * scale }
            : null,
          costUsdSoFar: budget.globalSpent(),
        });
        log(
          `node(${node.id}): pass (rung ${rung.rung})${nodeBudgetHit ? " [over budget — committed anyway]" : ""}`,
        );
        break;
      }


      // Failure: capture facts for the next rung's FAILURE CONTEXT, then fail.
      priorDiff = await diffSince(workdir, lastGreen);
      failure = {
        gateCommand: gate.command,
        exitCode: gate.exitCode,
        timedOut: gate.timedOut,
        stdoutTail: gate.stdoutTail,
        stderrTail: gate.stderrTail,
        reconcileViolations: rec.violations,
        confabulation: rec.confabulation,
        changedFiles: changed,
      };
      // Did the builder push back that the task itself is mis-specified? Track the
      // most recent rung's verdict (a later rung that just tries, no dispute, clears it).
      const dispute = parseDispute(record.finalMessage);
      lastDispute = dispute ? { ...dispute, rung: rung.rung, model: rung.model } : undefined;
      trace.append("node_fail", {
        nodeId: node.id,
        rung: rung.rung,
        payload: {
          gateExitCode: gate.exitCode,
          reason: nodeBudgetHit ? "node_budget" : dispute ? "disputed" : "gate_or_reconcile",
          ...(dispute ? { dispute: { target: dispute.target, evidence: dispute.evidence } } : {}),
        },
        costUsdSoFar: budget.globalSpent(),
      });
      log(`node(${node.id}): fail (rung ${rung.rung}, gate exit ${gate.exitCode})${dispute ? ` — disputes its ${dispute.target}` : ""}`);

      // The builder disputed the task AND a reviewer is configured → adjudicate NOW,
      // before climbing the ladder. An upheld dispute repairs the gate and re-runs the
      // SAME cheap executor (a wrong gate is a planning defect — don't burn opus on it).
      if (dispute && opts.disputeReviewer && gateRepairsLeft > 0) {
        const review = await opts.disputeReviewer({
          nodeId: node.id,
          brief: node.brief,
          gate: effectiveGate(node).run ?? "",
          dispute,
        });
        trace.append("dispute_review", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { upheld: review.upheld, target: dispute.target, reason: review.reason, repaired: Boolean(review.upheld && review.gate) },
          costUsdSoFar: budget.globalSpent(),
        });
        if (review.upheld && review.gate) {
          node.gate = { ...effectiveGate(node), run: review.gate };
          gateRepairsLeft -= 1;
          rerunLadder = true;
          log(`node(${node.id}): dispute UPHELD — repaired the ${dispute.target}; re-allocating to ${rungs[0]!.model}`);
          break; // exit the rung ladder; the node-level while re-runs it from rung 1
        }
        // rejected → the gate stands; fall through to normal escalation.
      }

      // The node FAILED its gate. If it also burned its per-node budget, stop
      // escalating — the next rung would only spend more without a result.
      if (nodeBudgetHit) {
        break;
      }
      const isLastRung = rung.rung === rungs[rungs.length - 1]!.rung;
      if (!isLastRung) {
        trace.append("escalate", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { fromRung: rung.rung, toRung: rung.rung + 1, nextModel: rungs[rung.rung]!.model },
          costUsdSoFar: budget.globalSpent(),
        });
      }
    }
    } // end node-level dispute-retry loop (an upheld dispute re-runs the ladder once)

    if (!outcome.passed && !halted) {
      halted = true;
      // Attribution: if the strongest rung that ran disputed the task as mis-specified,
      // halt with THAT — "the gate/brief is wrong, here's the evidence" — not the
      // model-blaming "exhausted the ladder". The orchestrator (and the human) now
      // see a harness defect distinctly from a model ceiling.
      haltReason = lastDispute
        ? `node "${node.id}" disputes its ${lastDispute.target} as mis-specified (rung ${lastDispute.rung}/${lastDispute.model}): ${lastDispute.evidence}`
        : `node "${node.id}" exhausted the escalation ladder`;
    }
  }

  // Leave the repo at the last green checkpoint for a consistent end state.
  await resetTo(workdir, lastGreen);

  const completed = committed.size === mission.nodes.length;
  trace.append("mission_end", {
    payload: {
      completed,
      halted,
      haltReason,
      committed: [...committed],
      nodeCount: mission.nodes.length,
    },
    costUsdSoFar: budget.globalSpent(),
  });

  return {
    missionId,
    completed,
    halted,
    haltReason,
    nodes: outcomes,
    committedNodeIds: [...committed],
    totalCostUsd: budget.globalSpent(),
    tracePath,
  };
}

interface ConsumeResult {
  record: AttemptRecord;
  globalBudgetExceeded: boolean;
  nodeBudgetExceeded: boolean;
}

/**
 * Drain one attempt's EngineEvent stream into an AttemptRecord, charging the
 * budget on every usage event and tracing tool activity. Executed writes are
 * reconstructed from (tool_call write/edit) + (ok tool_result), keeping the
 * runner engine-agnostic.
 */
/** Raw mode for the path of least scaffolding. See the harness-off ablation. */
const RAW_NODE_ID = "(raw)";

/**
 * Ablation runner (harness OFF). One raw attempt: the model gets ONLY the
 * mission goal + a repo file listing + the executor system prompt, the four
 * tools, and the GLOBAL budget hard-stop. No fresh-context nodes, no per-node
 * gates mid-run, no checkpoints, no blast radius, no escalation. When it ends
 * (done or budget), every node's done_check is executed and counted; the same
 * trace event shapes are emitted so experiment.ts consumes both modes uniformly.
 */
async function runRaw(
  opts: RunMissionOptions,
  chainName: string,
  executorSlug: string,
  scale: number,
): Promise<MissionResult> {
  const { mission, chains, engine, workdir, missionId, tracePath } = opts;
  const log = opts.log ?? (() => {});
  const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  addGitExclude(workdir, [".squire/", ".squire"]);
  const trace = new Trace(tracePath, missionId, { now: opts.now });
  const budget = new BudgetMeter(chains.prices, mission.budget_usd * scale);
  budget.beginNode(mission.budget_usd * scale);

  trace.append("mission_start", {
    payload: { goal: mission.goal, chain: chainName, budgetUsd: mission.budget_usd, workdir, mode: "raw" },
    costUsdSoFar: 0,
  });

  const listing = await listFiles(workdir);
  const goalPrompt = [
    `GOAL:\n${mission.goal}`,
    "",
    "You are working in a git repository. These files exist:",
    listing.map((f) => `  ${f}`).join("\n"),
    "",
    "Complete the goal. Decompose it yourself. Use read/write/edit/bash to make",
    "and verify your changes. There are no further instructions and no other steps;",
    "do everything the goal requires, then stop.",
  ].join("\n");

  const req = {
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    brief: goalPrompt,
    files: [],
    cwd: workdir,
    model: { slug: executorSlug, apiKey: opts.apiKey, baseUrl: opts.baseUrl },
    tools: { blastRadius: ["**"] }, // no blast radius in raw mode
    maxTokens: 40_000,
    nodeId: RAW_NODE_ID,
    rung: 1,
  };

  trace.append("node_start", {
    nodeId: RAW_NODE_ID,
    attempt: 1,
    rung: 1,
    payload: { model: executorSlug, mode: "raw" },
    costUsdSoFar: 0,
  });

  const consumed = await consumeAttempt(engine.runAttempt(req), {
    trace,
    nodeId: RAW_NODE_ID,
    rungModel: executorSlug,
    rungNumber: 1,
    budget,
  });

  if (consumed.globalBudgetExceeded) {
    trace.append("budget_stop", {
      nodeId: RAW_NODE_ID,
      rung: 1,
      payload: { scope: "global", globalUsd: budget.globalSpent(), capUsd: mission.budget_usd },
      costUsdSoFar: budget.globalSpent(),
    });
    log(`raw: global budget cap $${mission.budget_usd} hit; scoring partial state`);
  }

  // Scoring: execute every node's done_check against the final working tree.
  const committed = new Set<string>();
  const outcomes: NodeOutcome[] = [];
  for (const node of mission.nodes) {
    const g = effectiveGate(node);
    // Raw scoring is unattended by definition: human gates score as not-passed
    // with a note (A23); judge gates are soft and score as passed-with-flag.
    const gate =
      g.type === "human" && !opts.adjudicate
        ? {
            command: `human:${g.artifact}`,
            passed: false,
            exitCode: 1,
            timedOut: false,
            stdoutTail: "",
            stderrTail: "human gate unscoreable in unattended raw mode",
            durationMs: 0,
            gateType: "human" as const,
          }
        : await executeGate(g, {
            cwd: workdir,
            nodeId: node.id,
            brief: node.brief,
            timeoutMs: gateTimeoutMs,
            adjudicate: opts.adjudicate,
          });
    trace.append("gate", {
      nodeId: node.id,
      rung: 1,
      payload: {
        command: gate.command,
        exitCode: gate.exitCode,
        passed: gate.passed,
        timedOut: gate.timedOut,
        stdoutTail: gate.stdoutTail,
        stderrTail: gate.stderrTail,
        mode: "raw_score",
      },
      costUsdSoFar: budget.globalSpent(),
    });
    outcomes.push({
      nodeId: node.id,
      passed: gate.passed,
      attempts: 1,
      maxRung: 1,
      blastDenied: 0,
      confabulations: 0,
      costUsd: 0,
      gateExitCode: gate.exitCode,
    });
    if (gate.passed) {
      committed.add(node.id);
      trace.append("node_pass", { nodeId: node.id, rung: 1, costUsdSoFar: budget.globalSpent() });
      log(`raw score: ${node.id} PASS`);
    } else {
      trace.append("node_fail", {
        nodeId: node.id,
        rung: 1,
        payload: { gateExitCode: gate.exitCode },
        costUsdSoFar: budget.globalSpent(),
      });
      log(`raw score: ${node.id} fail (gate exit ${gate.exitCode})`);
    }
  }

  const completed = committed.size === mission.nodes.length;
  trace.append("mission_end", {
    payload: { completed, halted: false, mode: "raw", committed: [...committed], nodeCount: mission.nodes.length },
    costUsdSoFar: budget.globalSpent(),
  });

  return {
    missionId,
    completed,
    halted: false,
    haltReason: completed ? undefined : "raw mode: not all node checks passed",
    nodes: outcomes,
    committedNodeIds: [...committed],
    totalCostUsd: budget.globalSpent(),
    tracePath,
  };
}

async function consumeAttempt(
  stream: AsyncIterable<import("../engine/types.js").EngineEvent>,
  ctx: {
    trace: Trace;
    nodeId: string;
    rungModel: string;
    rungNumber: number;
    budget: BudgetMeter;
  },
): Promise<ConsumeResult> {
  const { trace, nodeId, rungModel, rungNumber, budget } = ctx;
  const pending = new Map<string, ToolCallRecord>();
  const toolCalls: ToolCallRecord[] = [];
  const denied = new Set<string>();
  let blastDeniedCount = 0;
  let inTokens = 0;
  let outTokens = 0;
  let finalMessage = "";
  let errored = false;
  let errorMessage: string | undefined;
  let globalBudgetExceeded = false;
  let nodeBudgetExceeded = false;

  for await (const ev of stream) {
    switch (ev.kind) {
      case "text":
        finalMessage = ev.text;
        break;
      case "tool_call": {
        const rec: ToolCallRecord = {
          id: ev.id,
          name: ev.name,
          args: ev.args,
          ok: false,
          output: "",
          denied: false,
          path: readArg(ev.args, "path"),
          command: ev.name === "bash" ? readArg(ev.args, "command") : undefined,
        };
        pending.set(ev.id, rec);
        toolCalls.push(rec);
        trace.append("tool_call", {
          nodeId: nodeId,
          rung: rungNumber,
          payload: { id: ev.id, name: ev.name, path: rec.path, command: rec.command },
          costUsdSoFar: budget.globalSpent(),
        });
        break;
      }
      case "blast_denied": {
        denied.add(ev.id);
        blastDeniedCount += 1;
        const rec = pending.get(ev.id);
        if (rec) rec.denied = true;
        trace.append("blast_denied", {
          nodeId: nodeId,
          rung: rungNumber,
          payload: { id: ev.id, name: ev.name, path: ev.path, reason: ev.reason },
          costUsdSoFar: budget.globalSpent(),
        });
        break;
      }
      case "tool_result": {
        const rec = pending.get(ev.id);
        if (rec) {
          rec.ok = ev.ok;
          rec.output = ev.output;
          rec.denied = rec.denied || denied.has(ev.id);
        }
        trace.append("tool_result", {
          nodeId: nodeId,
          rung: rungNumber,
          payload: { id: ev.id, ok: ev.ok, outputTail: tail(ev.output) },
          costUsdSoFar: budget.globalSpent(),
        });
        break;
      }
      case "usage": {
        inTokens += ev.inTokens;
        outTokens += ev.outTokens;
        const charge = budget.charge(rungModel, ev.inTokens, ev.outTokens);
        trace.append("usage", {
          nodeId: nodeId,
          rung: rungNumber,
          payload: {
            model: rungModel,
            inTokens: ev.inTokens,
            outTokens: ev.outTokens,
            costUsd: charge.costUsd,
            nodeUsd: charge.nodeUsd,
            globalUsd: charge.globalUsd,
            unpriced: charge.unpricedModel,
          },
          costUsdSoFar: charge.globalUsd,
        });
        if (charge.nodeExceeded) nodeBudgetExceeded = true;
        if (charge.globalExceeded) {
          globalBudgetExceeded = true;
          // Hard stop: stop consuming further events immediately.
          return finalize();
        }
        break;
      }
      case "done":
        finalMessage = ev.finalMessage || finalMessage;
        break;
      case "error":
        errored = true;
        errorMessage = ev.message;
        finalMessage = finalMessage || ev.message;
        trace.append("engine_error", {
          nodeId: nodeId,
          rung: rungNumber,
          payload: { message: ev.message },
          costUsdSoFar: budget.globalSpent(),
        });
        break;
    }
  }

  return finalize();

  function finalize(): ConsumeResult {
    const executedWrites = toolCalls
      .filter((tc) => (tc.name === "write" || tc.name === "edit") && tc.ok && !tc.denied && tc.path)
      .map((tc) => tc.path!);
    const record: AttemptRecord = {
      toolCalls,
      executedWrites: [...new Set(executedWrites)],
      blastDeniedCount,
      inTokens,
      outTokens,
      finalMessage,
      errored,
      errorMessage,
    };
    return { record, globalBudgetExceeded, nodeBudgetExceeded };
  }
}

/** A provider/infra error that is worth RETRYING (transient), not a model/work failure. */
export function isTransientProviderError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /\b(429|500|502|503|504)\b|too many requests|rate.?limit|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|timed? out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readArg(args: unknown, key: string): string | undefined {
  if (typeof args === "object" && args !== null && key in args) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function tail(s: string, n = 600): string {
  return s.length <= n ? s : "…" + s.slice(s.length - n);
}

// Re-export for callers that build tool policies.
export type { ToolName };
