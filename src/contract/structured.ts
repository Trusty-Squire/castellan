import type { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import { formatZodIssues, tryParseJson } from "./derive.js";

interface StructuredRequest<T extends z.ZodTypeAny> {
  llm: LlmClient;
  model: string;
  system: string;
  user: string;
  schema: T;
  label: string;
  maxTokens: number;
  repairAttempts?: number;
  timeoutMs?: number;
}

export interface StructuredResult<T> {
  value: T;
  repaired: boolean;
}

export async function completeJsonWithRepair<T extends z.ZodTypeAny>(
  req: StructuredRequest<T>,
): Promise<StructuredResult<z.infer<T>>> {
  let res = await completeBounded(req, req.system, req.user);
  let checked = parseAndValidate(req.schema, res.text);
  if (checked.ok) return { value: checked.value, repaired: false };

  checked = parseAndValidate(req.schema, removeControlChars(res.text));
  if (checked.ok) return { value: checked.value, repaired: true };

  const repairAttempts = req.repairAttempts ?? 1;
  for (let attempt = 0; attempt < repairAttempts; attempt++) {
    res = await completeBounded(req, repairSystem(req.label), repairUser(req.label, checked.error, res.text));
    checked = parseAndValidate(req.schema, res.text);
    if (checked.ok) return { value: checked.value, repaired: true };
    checked = parseAndValidate(req.schema, removeControlChars(res.text));
    if (checked.ok) return { value: checked.value, repaired: true };
  }

  throw new Error(checked.error);
}

async function completeBounded<T extends z.ZodTypeAny>(
  req: StructuredRequest<T>,
  system: string,
  user: string,
): ReturnType<LlmClient["complete"]> {
  const timeoutMs = req.timeoutMs ?? Number(process.env.SER_PLANNER_TIMEOUT_MS ?? 90000);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await req.llm.complete({
      model: req.model,
      system,
      user,
      json: true,
      maxTokens: req.maxTokens,
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw new Error(`planner call timed out after ${timeoutMs}ms`);
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted|aborterror|timed out/i.test(err.message));
}

function parseAndValidate<T extends z.ZodTypeAny>(
  schema: T,
  text: string,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  const parsed = tryParseJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const checked = schema.safeParse(parsed.value);
  if (!checked.success) return { ok: false, error: formatZodIssues(checked.error.issues) };
  return { ok: true, value: checked.data };
}

function removeControlChars(text: string): string {
  return text.replace(/[\u0000-\u001F]/g, "");
}

function repairSystem(label: string): string {
  return [
    `You repair malformed JSON for ${label}.`,
    "Return ONLY valid JSON. No Markdown fences, prose, comments, or trailing text.",
    "Preserve the user's meaning. Do not add new product scope while repairing syntax or schema issues.",
  ].join(" ");
}

function repairUser(label: string, error: string, raw: string): string {
  return [
    `${label} failed to parse or validate.`,
    "",
    `ERROR:\n${error}`,
    "",
    "RAW OUTPUT TO REPAIR:",
    raw,
  ].join("\n");
}
