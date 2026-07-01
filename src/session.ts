import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

export const SessionSchema = z.object({
  goal: z.string(),
  phase: z.enum(["spec", "build", "audit", "ship"]).default("spec"),
  state: z.enum(["working", "blocked", "complete"]).default("working"),
  summary: z.string(),
  next: z.string().optional(),
  specStatus: z.enum(["drafting", "locked", "needs_input"]).optional(),
  currentLoop: z.string().optional(),
  lastAttempt: z.string().optional(),
  lastVerifier: z.string().optional(),
  lastResult: z.string().optional(),
  failureClass: z.enum([
    "clarification_needed",
    "localization_context",
    "runner_environment",
    "patch_application",
    "regression_gate",
    "oracle_false_positive",
    "provider_timeout",
    "verifier_unavailable",
    "model_capability",
  ]).optional(),
  nextMutation: z.string().optional(),
  humanNeeded: z.boolean().optional(),
  blocker: z.string().optional(),
  workdir: z.string().optional(),
  specPath: z.string().optional(),
  latestTrace: z.string().optional(),
  updatedAt: z.string(),
});

export type SerSession = z.infer<typeof SessionSchema>;

export function sessionPath(root = process.cwd()): string {
  return join(resolve(root), ".ser", "session.json");
}

export function readSession(root = process.cwd()): SerSession | null {
  const path = sessionPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface LocatedSession {
  root: string;
  path: string;
  session: SerSession;
}

export function readNearestSession(start = process.cwd()): LocatedSession | null {
  let root = resolve(start);
  while (true) {
    const path = sessionPath(root);
    const session = readSession(root);
    if (session) return { root, path, session };
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

export function writeSession(session: Omit<SerSession, "updatedAt"> & { updatedAt?: string }, root = process.cwd()): string {
  const path = sessionPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const body = SessionSchema.parse({
    ...session,
    updatedAt: session.updatedAt ?? new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return path;
}

function displayPath(path: string | undefined, root: string): string | undefined {
  if (!path) return undefined;
  const abs = resolve(path);
  const rel = relative(resolve(root), abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

export function formatSessionStatus(session: SerSession, root = process.cwd()): string {
  const lines = [
    `Goal: ${session.goal}`,
    `State: ${session.state}`,
    `Now: ${session.summary}`,
  ];
  if (session.currentLoop) lines.push(`Loop: ${session.currentLoop}`);
  if (session.lastAttempt) lines.push(`Last attempt: ${session.lastAttempt}`);
  if (session.lastVerifier) lines.push(`Last verifier: ${session.lastVerifier}`);
  if (session.lastResult) lines.push(`Last result: ${session.lastResult}`);
  if (session.nextMutation) lines.push(`Next mutation: ${session.nextMutation}`);
  if (session.next) lines.push(`Next: ${session.next}`);
  if (session.blocker) lines.push(`Blocker: ${session.blocker}`);
  if (typeof session.humanNeeded === "boolean") lines.push(`Human needed: ${session.humanNeeded ? "yes" : "no"}`);
  if (session.workdir) lines.push(`Workdir: ${displayPath(session.workdir, root)}`);
  if (session.specPath) lines.push(`Spec: ${displayPath(session.specPath, root)}`);
  return lines.join("\n");
}
