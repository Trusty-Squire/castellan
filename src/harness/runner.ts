import type { ChainsFile, Mission } from "../contract/schema.js";
import { resolveChain, topoSort, effectiveGate, type MissionNode } from "../contract/schema.js";
import type { Engine, AttemptRecord, ToolCallRecord, ToolName } from "../engine/types.js";
import { Trace } from "./trace.js";
import { packContext } from "./context.js";
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

/** Executor system prompt — Appendix B, verbatim. */
export const EXECUTOR_SYSTEM_PROMPT = `You are a Squire: a focused coding agent executing ONE task.
You have four tools: read, write, edit, bash.
Work only within the paths you are told are writable.
When using write, the content argument is the exact file body. Do not write
JSON, Python dict/list literals, markdown fences, or summaries unless the target
file is actually that format. For .js files, write valid JavaScript source; if a
gate uses require('./file.js'), export with CommonJS module.exports.
Run the check command yourself before declaring done; if it
fails, fix and re-run. Declare done only when it exits 0.
Your final message: one short paragraph stating what changed
(file list) and the check result. Claim nothing you did not do;
your tool calls are audited against your claims.`;


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

  const rungs = ladder(chain);

  // Keep harness artifacts out of git: never staged by `git add -A`, never
  // removed by `git clean -fd` during a node reset.
  addGitExclude(workdir, [".squire/", ".squire"]);

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

      // Each attempt is preceded by a reset to the last green checkpoint.
      // For rung > 1 this reverts the previous failed attempt (RESET state).
      await resetTo(workdir, lastGreen);
      if (rung.rung > 1) {
        trace.append("reset", {
          nodeId: node.id,
          rung: rung.rung,
          payload: { to: lastGreen },
          costUsdSoFar: budget.globalSpent(),
        });
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

      let brief = node.brief;
      if (rung.addFailureContext && failure) {
        brief +=
          "\n\n" +
          buildFailureContext({
            ...failure,
            priorDiff: rung.addPriorDiff ? priorDiff : undefined,
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

      const consumed = await consumeAttempt(engine.runAttempt(req), {
        trace,
        nodeId: node.id,
        rungModel: rung.model,
        rungNumber: rung.rung,
        budget,
      });
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
        stderrTail: gate.stderrTail,
        reconcileViolations: rec.violations,
        confabulation: rec.confabulation,
        changedFiles: changed,
      };
      trace.append("node_fail", {
        nodeId: node.id,
        rung: rung.rung,
        payload: { gateExitCode: gate.exitCode, reason: nodeBudgetHit ? "node_budget" : "gate_or_reconcile" },
        costUsdSoFar: budget.globalSpent(),
      });
      log(`node(${node.id}): fail (rung ${rung.rung}, gate exit ${gate.exitCode})`);

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

    if (!outcome.passed && !halted) {
      halted = true;
      haltReason = `node "${node.id}" exhausted the escalation ladder`;
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
