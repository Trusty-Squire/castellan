import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import { tryParseJson } from "./derive.js";
import { withFrontendFloorStories } from "../review/frontend-floor.js";

/**
 * L4 audit: independent reviewers with NO build memory read the finished code
 * against the spec and return polish recommendations. (The old L2 multi-reviewer
 * SPEC review — the ceo/design/eng/dx committee — was deleted in the streamline;
 * the spec now goes straight from authoring to the derive compile-check, and the
 * live visual audit carries the real product teeth.)
 */

const ENG_LENS =
  "architecture & data flow; edge cases & failure modes; test/eval coverage (does every requirement have a RUNNABLE gate, or is it only checkable by a human?); performance; security & safety";
const DESIGN_LENS =
  "information hierarchy; user flow & friction; the empty / loading / error states; visual clarity & consistency; accessibility; one moment of delight";

// ---------- L4: audit the built code, independent of the builder ----------

const AuditSchema = z.object({
  recommendations: z
    .array(
      z.object({
        lens: z.enum(["eng", "design", "dogfood"]),
        severity: z.enum(["high", "med", "low"]),
        note: z.string().min(1),
        file: z.string().optional(),
      }),
    )
    .default([]),
});
export type Audit = z.infer<typeof AuditSchema>;

const AUDIT_SYSTEM = `You are ser's audit reviewer. You have NO memory of how this was built — you see only the finished code and the spec it was meant to satisfy, with completely fresh eyes. Apply three lenses and report concrete, actionable polish:
ENGINEERING: ${ENG_LENS}.
DESIGN: ${DESIGN_LENS}.
DOGFOOD: actually trace a user doing each story end to end — where would a real user hit friction, confusion, or a rough edge?

Report only things that are real and worth fixing. For each, give the lens, a severity (high/med/low), a one-sentence concrete note, and the file if applicable. Do NOT restate what works. Output ONLY JSON: {"recommendations":[{"lens":"eng","severity":"med","note":"…","file":"app.js"}]}.`;

const DEFAULT_AUDIT_TIMEOUT_MS = 45_000;

export async function auditBuild(
  files: { path: string; src: string }[],
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
  maxBytes = 60000,
  timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
): Promise<Audit> {
  spec = withFrontendFloorStories(spec);
  // pack the code, capped, so the reviewer sees the whole product cheaply.
  let budget = maxBytes;
  const packed: string[] = [];
  for (const f of files) {
    const block = `--- ${f.path} ---\n${f.src}\n`;
    if (block.length > budget) { packed.push(`--- ${f.path} --- (truncated)\n${f.src.slice(0, budget)}\n`); break; }
    packed.push(block);
    budget -= block.length;
  }
  const user = [
    `THESIS: ${spec.thesis}`,
    `STORIES (each should work end to end):\n${spec.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    `CODE:\n${packed.join("\n")}`,
  ].join("\n\n");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  let res: Awaited<ReturnType<LlmClient["complete"]>>;
  try {
    res = await llm.complete({ model, system: AUDIT_SYSTEM, user, json: true, maxTokens: 3500, signal: ac.signal });
  } catch {
    return { recommendations: [] };
  } finally {
    clearTimeout(timer);
  }
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return { recommendations: [] };
  const checked = AuditSchema.safeParse(parsed.value);
  return checked.success ? checked.data : { recommendations: [] };
}
