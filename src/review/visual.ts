/**
 * Live visual review (the clairvoyance catch). Two steps, deliberately separated:
 *   1. renderBuild() — serve the built dir and screenshot it with a headless
 *      browser. Pluggable + degrades: prefer system Chrome/Chromium headless;
 *      if no browser is found, return { ok:false } and the caller skips.
 *   2. visualReview() — a PREMIUM MULTIMODAL judge looks at the screenshot + the
 *      spec stories and decides what is ACTUALLY VISIBLE (storyChecks are the teeth).
 * blockingFixes() is pure: it turns a verdict into the fixes that must block ship.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import type { LlmClient } from "../llm/types.js";
import { tryParseJson } from "../contract/derive.js";
import { DefectClosureListSchema, VisualChoiceSchema, VisualVerdictSchema, type DefectClosure, type VisualVerdict } from "./types.js";
import { VISUAL_CLOSURE_SYSTEM, VISUAL_COMPARISON_SYSTEM, VISUAL_JUDGE_SYSTEM } from "./prompts.js";

export interface RenderResult {
  ok: boolean;
  screenshotPath?: string;
  /** PNG as a data URL, ready for a multimodal LlmClient call. */
  dataUrl?: string;
  images?: { kind: "desktop" | "mobile"; screenshotPath: string; dataUrl: string }[];
  note?: string;
}

export interface VisualCandidate {
  id: string;
  shot: RenderResult;
  verdict: VisualVerdict;
}

export interface RenderTarget {
  serveDir: string;
  entry: string;
}

function looksLikeSourceEntry(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const html = readFileSync(file, "utf8");
    return /<script[^>]+src=["']\/src\//i.test(html);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

const CHROME_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const DEFAULT_VISUAL_REVIEW_TIMEOUT_MS = 45_000;
const MOBILE_WIDTH = 430;
const MOBILE_HEIGHT = 932;
const DESKTOP_WIDTH = 1100;
const DESKTOP_HEIGHT = 1400;

/** First Chrome/Chromium binary on PATH, or null. */
async function findChrome(): Promise<string | null> {
  for (const bin of CHROME_BINS) {
    try {
      await execa("which", [bin]);
      return bin;
    } catch {
      /* not found, try next */
    }
  }
  return null;
}

/** Serve `dir` on an ephemeral port; returns the server + chosen port. */
function serve(dir: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
      const file = join(dir, rel);
      if (!file.startsWith(dir) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
      res.end(readFileSync(file));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ port: addr.port, close: () => server.close() });
      else reject(new Error("could not bind server"));
    });
  });
}

/** Render the built UI to a screenshot. Degrades to { ok:false } if no browser. */
export function resolveRenderTarget(buildDir: string, entry = "index.html"): RenderTarget | null {
  const directEntry = join(buildDir, entry);
  const distEntry = join(buildDir, "dist", entry);
  if (existsSync(directEntry) && existsSync(distEntry) && looksLikeSourceEntry(directEntry)) {
    return { serveDir: join(buildDir, "dist"), entry };
  }
  if (existsSync(directEntry)) return { serveDir: buildDir, entry };
  if (existsSync(distEntry)) return { serveDir: join(buildDir, "dist"), entry };
  return null;
}

/** Render the built UI to a screenshot. Degrades to { ok:false } if no browser. */
export async function renderBuild(
  buildDir: string,
  opts: { entry?: string; width?: number; height?: number } = {},
): Promise<RenderResult> {
  const target = resolveRenderTarget(buildDir, opts.entry ?? "index.html");
  if (!target) {
    return { ok: false, note: `no ${opts.entry ?? "index.html"} to render (not a visual build)` };
  }
  const chrome = await findChrome();
  if (!chrome) return { ok: false, note: "no Chrome/Chromium found — visual review skipped" };

  const dir = mkdtempSync(join(tmpdir(), "ser-shot-"));
  const desktopShot = join(dir, "desktop.png");
  const mobileShot = join(dir, "mobile.png");
  const w = opts.width ?? DESKTOP_WIDTH;
  const h = opts.height ?? DESKTOP_HEIGHT;
  let server: { port: number; close: () => void } | null = null;
  try {
    server = await serve(target.serveDir);
    const url = `http://127.0.0.1:${server.port}/${target.entry}`;
    await capture(chrome, url, desktopShot, w, h);
    await capture(chrome, url, mobileShot, MOBILE_WIDTH, MOBILE_HEIGHT);
    if (!existsSync(desktopShot)) return { ok: false, note: "browser produced no screenshot" };
    const images: NonNullable<RenderResult["images"]> = [
      {
        kind: "desktop" as const,
        screenshotPath: desktopShot,
        dataUrl: `data:image/png;base64,${readFileSync(desktopShot).toString("base64")}`,
      },
    ];
    if (existsSync(mobileShot)) {
      images.push({
        kind: "mobile",
        screenshotPath: mobileShot,
        dataUrl: `data:image/png;base64,${readFileSync(mobileShot).toString("base64")}`,
      });
    }
    return { ok: true, screenshotPath: images[0]!.screenshotPath, dataUrl: images[0]!.dataUrl, images };
  } catch (err) {
    return { ok: false, note: `render failed: ${(err as Error).message.split("\n")[0]}` };
  } finally {
    server?.close();
  }
}

async function capture(chrome: string, url: string, shot: string, width: number, height: number): Promise<void> {
  await execa(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--screenshot=${shot}`,
      `--window-size=${width},${height}`,
      "--virtual-time-budget=4000",
      url,
    ],
    { timeout: 60_000 },
  );
}

/**
 * Multimodal judge of a rendered screenshot against the spec stories. null on failure.
 *
 * A null here makes the funnel HONEST-HALT ("won't ship a UI it couldn't verify"), so a
 * TRANSIENT blip — a network hiccup, a 5xx, the per-call timeout, or a one-off malformed
 * JSON the model occasionally emits — must NOT collapse to the same null as a genuine
 * "the judge will not produce a verdict". Both are retryable: re-asking almost always
 * clears them. We retry the whole call up to `attempts` times (fresh timeout each);
 * only a PERSISTENT failure across every attempt returns null. This closes the gap where
 * a single API blip false-halted an otherwise-green build at the very last gate.
 */
export async function visualReview(
  shot: RenderResult,
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
  timeoutMs = DEFAULT_VISUAL_REVIEW_TIMEOUT_MS,
  attempts = 3,
): Promise<VisualVerdict | null> {
  if (!shot.ok || (!shot.images?.length && !shot.dataUrl)) return null;
  const images = shot.images?.length ? shot.images : [{ kind: "desktop" as const, screenshotPath: shot.screenshotPath ?? "", dataUrl: shot.dataUrl! }];
  const user = [
    `THESIS: ${spec.thesis}`,
    `USER STORIES (judge each against what is VISIBLE in the screenshot):\n${spec.stories
      .map((s, i) => `  ${i + 1}. ${s}`)
      .join("\n")}`,
    `SCREENSHOTS: ${images.map((img, i) => `${i + 1}. ${img.kind} viewport`).join("  ")}`,
    "The attached images are screenshots of the built UI.",
  ].join("\n\n");
  const total = Math.max(1, attempts);
  for (let attempt = 1; attempt <= total; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await llm.complete({
        model,
        system: VISUAL_JUDGE_SYSTEM,
        user,
        json: true,
        maxTokens: 3500,
        signal: ac.signal,
        images: images.map((img) => ({ dataUrl: img.dataUrl })),
      });
      const parsed = tryParseJson(res.text);
      if (parsed.ok) {
        const checked = VisualVerdictSchema.safeParse(parsed.value);
        if (checked.success) return checked.data; // a real verdict — done
      }
      // parse/schema miss: a transient malformed response — fall through to retry
    } catch {
      // network / 5xx / abort (timeout): transient — fall through to retry
    } finally {
      clearTimeout(timer);
    }
    // brief backoff before re-asking; skip after the final attempt
    if (attempt < total) await new Promise((r) => setTimeout(r, 400 * attempt).unref?.());
  }
  return null;
}

/**
 * PURE: the fixes that must BLOCK ship — the teeth. An unsatisfied story (the UI
 * visibly doesn't deliver what was asked) ALWAYS blocks; that is the clairvoyance
 * catch. High-severity findings block only at 2+ — a lone borderline "high" (a
 * contrast/spacing call the multimodal judge flips run-to-run) is informational,
 * not a reason to force a rebuild of an otherwise-good UI.
 */
export function blockingFixes(v: VisualVerdict): { note: string; fix: string }[] {
  const out: { note: string; fix: string }[] = [];
  const seen = new Set<string>();
  const push = (note: string, fix: string): void => {
    const key = `${note}\n${fix}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ note, fix });
  };
  for (const s of v.storyChecks) {
    if (!s.satisfied) push(`story not visibly delivered: ${s.story}`, s.note || `make the UI visibly deliver: ${s.story}`);
  }
  for (const d of v.dimensions) {
    if (d.score > 3) continue;
    if (!/(hierarchy|ai slop|trust|headline|responsive)/i.test(d.name)) continue;
    push(`core design dimension is failing: ${d.name} (${d.score}/10)`, d.whatMakesIt10 || `raise ${d.name.toLowerCase()} to a credible product bar`);
  }
  const highs = v.findings.filter((f) => f.severity === "high");
  if (highs.length >= 2) {
    for (const f of highs) push(f.note, f.fix || f.note);
  }
  return out;
}

/**
 * A load-bearing defect frozen at the FIRST blocking round. The rebuild loop must
 * CLOSE this exact list; later rounds verify closure of THESE (adversarially) and do
 * NOT get to invent fresh blockers — so a judge that "always finds a flaw" can't loop
 * forever, and the load-bearing defect can't be lost under a pile of new nitpicks.
 */
export interface FrozenDefect {
  id: string;
  note: string;
  fix: string;
}

/**
 * PURE: freeze the fixes that actually blocked ship into a stable, id'd list. Takes
 * the SAME `{note,fix}` list the audit blocked on (blockingFixes / visualAuditSummary)
 * so the frozen list is exactly what blocked — no re-derivation drift.
 */
export function freezeDefects(fixes: { note: string; fix: string }[]): FrozenDefect[] {
  return fixes.map((f, i) => ({ id: `d${i + 1}`, note: f.note, fix: f.fix }));
}

/**
 * PURE: the frozen defects NOT proven fixed. "present" AND "unsure" both count as
 * unresolved (abstention over false-pass), as does any defect the judge omitted or a
 * null closure (the verifier couldn't run → nothing is proven fixed). Ship only when
 * this returns [].
 */
export function unresolvedDefects(frozen: FrozenDefect[], closure: DefectClosure[] | null): FrozenDefect[] {
  if (closure === null) return [...frozen];
  const fixed = new Set(closure.filter((c) => c.status === "fixed").map((c) => c.id));
  return frozen.filter((d) => !fixed.has(d.id));
}

/**
 * The ADVERSARIAL closure check: shows the judge ONLY the frozen defect list + the
 * latest screenshot and asks, per defect, whether it is fixed. Defaults to "present",
 * abstains ("unsure") rather than guessing fixed, and raises no new issues — the fix
 * for the loop that kept polishing while the load-bearing defect survived. Returns []
 * for an empty list, null on persistent failure (caller treats null as "unresolved").
 * Mirrors visualReview's retry/timeout machinery — a transient blip must not read as
 * a real "couldn't verify".
 */
export async function reviewClosure(
  shot: RenderResult,
  frozen: FrozenDefect[],
  llm: LlmClient,
  model: string,
  timeoutMs = DEFAULT_VISUAL_REVIEW_TIMEOUT_MS,
  attempts = 3,
): Promise<DefectClosure[] | null> {
  if (frozen.length === 0) return [];
  if (!shot.ok || (!shot.images?.length && !shot.dataUrl)) return null;
  const images = shot.images?.length
    ? shot.images
    : [{ kind: "desktop" as const, screenshotPath: shot.screenshotPath ?? "", dataUrl: shot.dataUrl! }];
  const user = [
    "PREVIOUSLY-IDENTIFIED DEFECTS (rule on EACH; raise no new ones):",
    frozen.map((d) => `  ${d.id}. ${d.note}${d.fix ? ` — expected fix: ${d.fix}` : ""}`).join("\n"),
    `SCREENSHOTS: ${images.map((img, i) => `${i + 1}. ${img.kind} viewport`).join("  ")}`,
    "The attached images are the LATEST rebuild. For each defect, decide whether the screenshot PROVES it fixed.",
  ].join("\n\n");
  const total = Math.max(1, attempts);
  for (let attempt = 1; attempt <= total; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await llm.complete({
        model,
        system: VISUAL_CLOSURE_SYSTEM,
        user,
        json: true,
        maxTokens: 1500,
        signal: ac.signal,
        images: images.map((img) => ({ dataUrl: img.dataUrl })),
      });
      const parsed = tryParseJson(res.text);
      if (parsed.ok) {
        const checked = DefectClosureListSchema.safeParse(parsed.value);
        if (checked.success) return checked.data.defects;
      }
    } catch {
      // network / 5xx / abort (timeout): transient — fall through to retry
    } finally {
      clearTimeout(timer);
    }
    if (attempt < total) await new Promise((r) => setTimeout(r, 400 * attempt).unref?.());
  }
  return null;
}

/** Non-blocking polish prompts: enough friction to keep searching, capped to stay cheap. */
export function polishFixes(v: VisualVerdict, cap = 3): string[] {
  const blocked = new Set(blockingFixes(v).map((f) => f.fix.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (text: string): void => {
    const value = text.trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (blocked.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const d of [...v.dimensions].sort((a, b) => a.score - b.score)) {
    if (d.score <= 6) push(d.whatMakesIt10 || `improve ${d.name.toLowerCase()}`);
    if (out.length >= cap) return out;
  }
  for (const f of v.findings) {
    if (f.severity === "low") continue;
    push(f.fix || f.note);
    if (out.length >= cap) return out;
  }
  return out;
}

/** Deterministic quality score used for ranking and fallback selection. Higher is better. */
export function qualityScore(v: VisualVerdict): number {
  const dims = v.dimensions.length ? v.dimensions.reduce((sum, d) => sum + d.score, 0) / v.dimensions.length : 0;
  const unsatisfied = v.storyChecks.filter((s) => !s.satisfied).length;
  const penalties = v.findings.reduce((sum, f) => sum + (f.severity === "high" ? 12 : f.severity === "med" ? 5 : 1), 0);
  return Math.round(dims * 10 - penalties - unsatisfied * 25);
}

/** Among feasible candidates, ask a visual selector to choose the best survivor. */
export async function chooseVisualCandidate(
  candidates: VisualCandidate[],
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
  timeoutMs = DEFAULT_VISUAL_REVIEW_TIMEOUT_MS,
): Promise<{ candidate: VisualCandidate; rationale: string; mode: "model" | "score" }> {
  const byScore = [...candidates].sort((a, b) => qualityScore(b.verdict) - qualityScore(a.verdict));
  if (candidates.length === 1) return { candidate: candidates[0]!, rationale: "only feasible candidate", mode: "score" };

  const images = candidates.flatMap((candidate) => {
    const shots = candidate.shot.images?.length ? candidate.shot.images : candidate.shot.dataUrl ? [{ kind: "desktop" as const, dataUrl: candidate.shot.dataUrl }] : [];
    return shots.map((img) => ({ dataUrl: img.dataUrl }));
  });
  const user = [
    `THESIS: ${spec.thesis}`,
    `USER STORIES:\n${spec.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    "CANDIDATES:",
    ...candidates.map((candidate, i) => {
      const labels = (candidate.shot.images?.length ? candidate.shot.images : [{ kind: "desktop" as const }]).map((img) => img.kind).join(", ");
      return `  ${i + 1}. ${candidate.id} (${labels})`;
    }),
    "The attached images are ordered by candidate number, with each candidate's desktop viewport first and mobile viewport second when present.",
  ].join("\n\n");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await llm.complete({
      model,
      system: VISUAL_COMPARISON_SYSTEM,
      user,
      json: true,
      maxTokens: 1200,
      signal: ac.signal,
      images,
    });
    const parsed = tryParseJson(res.text);
    if (!parsed.ok) throw new Error("bad JSON");
    const checked = VisualChoiceSchema.safeParse(parsed.value);
    if (!checked.success) throw new Error("bad schema");
    const idx = checked.data.winner - 1;
    if (idx < 0 || idx >= candidates.length) throw new Error("winner out of range");
    return { candidate: candidates[idx]!, rationale: checked.data.rationale, mode: "model" };
  } catch {
    return { candidate: byScore[0]!, rationale: `highest quality score (${qualityScore(byScore[0]!.verdict)})`, mode: "score" };
  } finally {
    clearTimeout(timer);
  }
}
