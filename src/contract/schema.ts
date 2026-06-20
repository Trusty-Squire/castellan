import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { SquireError } from "../errors.js";

/**
 * zod schemas are the single source of truth for all file formats
 * (mission.yaml, chains.yaml). Parse the outside world here; typed
 * values flow everywhere downstream.
 */

const globList = z.array(z.string().min(1));

/**
 * Gate ladder (SPEC-v0.2 §4). Tiers: command (exit code, the v0.1 default),
 * metric (a frozen perceptual/statistical metric behind a shell command),
 * judge (pinned external model + rubric — SOFT ONLY in v0.2: flags, never
 * fails), human (a recorded verdict on an adjudication artifact).
 */
export const GateSchema = z
  .object({
    type: z.enum(["command", "metric", "judge", "human"]),
    /** command|metric: the shell command, exit 0 = pass. */
    run: z.string().min(1).optional(),
    /** human|judge: the artifact (path/glob) the verdict adjudicates. */
    artifact: z.string().min(1).optional(),
    /** Soft gates flag instead of failing. v0.2: judge gates MUST be soft. */
    soft: z.boolean().default(false),
    /** Pinned judge config (tier 3). Hard judge gates are v0.3+. */
    judge: z
      .object({
        model: z.string().min(1),
        rubric: z.string().min(1),
        votes: z.number().int().positive().default(3),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((gate, ctx) => {
    const need = (cond: boolean, message: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (gate.type === "command" || gate.type === "metric") {
      need(Boolean(gate.run), `${gate.type} gate requires "run"`);
    }
    if (gate.type === "human") {
      need(Boolean(gate.artifact), 'human gate requires "artifact" (what the verdict adjudicates)');
    }
    if (gate.type === "judge") {
      need(Boolean(gate.judge), 'judge gate requires "judge" config (pinned model + rubric)');
      need(gate.soft === true, "judge gates must be soft:true in v0.2 (hard judge gates need a calibration set)");
    }
  });

export type Gate = z.infer<typeof GateSchema>;

export const NodeSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "node id must be [a-zA-Z0-9_-]"),
    brief: z.string().min(1),
    deps: z.array(z.string().min(1)).default([]),
    context_globs: globList.default([]),
    blast_radius: globList,
    /** v0.1 form — equivalent to gate: { type: "command", run: <done_check> }. */
    done_check: z.string().min(1).optional(),
    /** v0.2 form — exactly one of done_check | gate per node. */
    gate: GateSchema.optional(),
    budget_usd: z.number().positive(),
    max_context_tokens: z.number().int().positive().default(40_000),
  })
  .strict()
  .superRefine((node, ctx) => {
    if (Boolean(node.done_check) === Boolean(node.gate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `node "${node.id}" must have exactly one of done_check | gate`,
      });
    }
  });

export type MissionNode = z.infer<typeof NodeSchema>;

/** Resolve a node's gate regardless of which form (v0.1 done_check / v0.2 gate) it used. */
export function effectiveGate(node: MissionNode): Gate {
  if (node.gate) return node.gate;
  return { type: "command", run: node.done_check!, soft: false };
}

export const MissionSchema = z
  .object({
    goal: z.string().min(1),
    budget_usd: z.number().positive(),
    chain: z.string().min(1),
    workdir: z.string().default("."),
    /** Budget for tier-4 human checkpoints across the mission (SPEC-v0.2 §4). */
    max_human_checks: z.number().int().nonnegative().default(3),
    nodes: z.array(NodeSchema).min(1),
  })
  .strict()
  .superRefine((mission, ctx) => {
    const humanGates = mission.nodes.filter((n) => n.gate?.type === "human").length;
    if (humanGates > mission.max_human_checks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${humanGates} human gate(s) exceed max_human_checks (${mission.max_human_checks})`,
        path: ["nodes"],
      });
    }
    const ids = new Set<string>();
    for (const node of mission.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ["nodes"],
        });
      }
      ids.add(node.id);
    }
    for (const node of mission.nodes) {
      for (const dep of node.deps) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `node "${node.id}" depends on unknown node "${dep}"`,
            path: ["nodes"],
          });
        }
        if (dep === node.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `node "${node.id}" depends on itself`,
            path: ["nodes"],
          });
        }
      }
    }
    // Reject cycles up front so the runner can trust the DAG.
    const cycle = findCycle(mission.nodes);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dependency cycle: ${cycle.join(" -> ")}`,
        path: ["nodes"],
      });
    }
  });

export type Mission = z.infer<typeof MissionSchema>;

export const ChainSchema = z
  .object({
    executor: z.string().min(1),
    fallback: z.string().min(1),
    knight: z.string().min(1),
    /** "off" runs the ablation: one raw attempt, goal-only, no harness scaffolding. */
    harness: z.enum(["on", "off"]).default("on"),
    /** Multiply all mission budgets (global + per-node) by this factor. Used to
     *  match an expensive chain to budgets sized for a cheaper model. */
    budget_scale: z.number().positive().default(1),
    /** The EXECUTOR's effective working-context envelope (tokens) — NOT its max
     *  window. The planner sizes each node to this (replacing the "1-12 nodes"
     *  count anchor) and it's copied into each derived node's max_context_tokens.
     *  Calibrate per executor (where first-try pass rate falls off); conservative
     *  default until measured. Optional so existing chains.yaml files still parse. */
    node_context_budget: z.number().positive().default(40000),
  })
  .strict();

export type Chain = z.infer<typeof ChainSchema>;

export const PriceSchema = z
  .object({ in: z.number().nonnegative(), out: z.number().nonnegative() })
  .strict();

export type Price = z.infer<typeof PriceSchema>;

export const ChainsFileSchema = z
  .object({
    chains: z.record(z.string(), ChainSchema),
    prices: z.record(z.string(), PriceSchema).default({}),
  })
  .strict();

export type ChainsFile = z.infer<typeof ChainsFileSchema>;

/** Parse + validate a mission.yaml string. Throws SquireError on failure. */
export function parseMission(yamlText: string, source = "mission.yaml"): Mission {
  return validate(MissionSchema, parseYamlSafe(yamlText, source), source);
}

/** Parse + validate a chains.yaml string. Throws SquireError on failure. */
export function parseChains(yamlText: string, source = "chains.yaml"): ChainsFile {
  return validate(ChainsFileSchema, parseYamlSafe(yamlText, source), source);
}

/** Resolve a chain by name, with a clear error if absent. */
export function resolveChain(chains: ChainsFile, name: string): Chain {
  const chain = chains.chains[name];
  if (!chain) {
    const known = Object.keys(chains.chains).join(", ") || "(none)";
    throw new SquireError(
      "UNKNOWN_CHAIN",
      `chain "${name}" not found in chains.yaml (known: ${known})`,
    );
  }
  return chain;
}

/**
 * Deterministic topological order: stable by declaration order, deps first.
 * Assumes the DAG is acyclic (enforced at schema validation).
 */
export function topoSort(nodes: MissionNode[]): MissionNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const order: MissionNode[] = [];
  const visit = (node: MissionNode): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    for (const dep of node.deps) {
      const depNode = byId.get(dep);
      if (depNode) visit(depNode);
    }
    order.push(node);
  };
  for (const node of nodes) visit(node);
  return order;
}

/** Returns a cycle path if the node graph has one, else null. */
function findCycle(nodes: MissionNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    for (const dep of node?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) {
        const from = stack.indexOf(dep);
        return [...stack.slice(from), dep];
      }
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    color.set(id, BLACK);
    stack.pop();
    return null;
  };

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) {
      const cycle = dfs(node.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function parseYamlSafe(yamlText: string, source: string): unknown {
  try {
    return parseYaml(yamlText);
  } catch (err) {
    throw new SquireError("YAML_PARSE", `failed to parse ${source}: ${(err as Error).message}`);
  }
}

function validate<S extends z.ZodTypeAny>(schema: S, value: unknown, source: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new SquireError("SCHEMA_INVALID", `invalid ${source}:\n${issues}`, result.error.issues);
  }
  return result.data;
}
