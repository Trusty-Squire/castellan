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
import { VisualVerdictSchema, type VisualVerdict } from "./types.js";
import { VISUAL_JUDGE_SYSTEM } from "./prompts.js";

export interface RenderResult {
  ok: boolean;
  screenshotPath?: string;
  /** PNG as a data URL, ready for a multimodal LlmClient call. */
  dataUrl?: string;
  note?: string;
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
export async function renderBuild(
  buildDir: string,
  opts: { entry?: string; width?: number; height?: number } = {},
): Promise<RenderResult> {
  const entry = opts.entry ?? "index.html";
  if (!existsSync(join(buildDir, entry))) {
    return { ok: false, note: `no ${entry} to render (not a visual build)` };
  }
  const chrome = await findChrome();
  if (!chrome) return { ok: false, note: "no Chrome/Chromium found — visual review skipped" };

  const dir = mkdtempSync(join(tmpdir(), "ser-shot-"));
  const shot = join(dir, "shot.png");
  const w = opts.width ?? 1100;
  const h = opts.height ?? 1400;
  let server: { port: number; close: () => void } | null = null;
  try {
    server = await serve(buildDir);
    const url = `http://127.0.0.1:${server.port}/${entry}`;
    await execa(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        `--screenshot=${shot}`,
        `--window-size=${w},${h}`,
        "--virtual-time-budget=4000", // let the page's JS build the DOM before the shot
        url,
      ],
      { timeout: 60_000 },
    );
    if (!existsSync(shot)) return { ok: false, note: "browser produced no screenshot" };
    const dataUrl = `data:image/png;base64,${readFileSync(shot).toString("base64")}`;
    return { ok: true, screenshotPath: shot, dataUrl };
  } catch (err) {
    return { ok: false, note: `render failed: ${(err as Error).message.split("\n")[0]}` };
  } finally {
    server?.close();
  }
}

/** Multimodal judge of a rendered screenshot against the spec stories. null on failure. */
export async function visualReview(
  shot: RenderResult,
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
): Promise<VisualVerdict | null> {
  if (!shot.ok || !shot.dataUrl) return null;
  const user = [
    `THESIS: ${spec.thesis}`,
    `USER STORIES (judge each against what is VISIBLE in the screenshot):\n${spec.stories
      .map((s, i) => `  ${i + 1}. ${s}`)
      .join("\n")}`,
    "The attached image is a screenshot of the built UI.",
  ].join("\n\n");
  let res: { text: string };
  try {
    res = await llm.complete({
      model,
      system: VISUAL_JUDGE_SYSTEM,
      user,
      json: true,
      maxTokens: 3500,
      images: [{ dataUrl: shot.dataUrl }],
    });
  } catch {
    return null;
  }
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return null;
  const checked = VisualVerdictSchema.safeParse(parsed.value);
  return checked.success ? checked.data : null;
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
  for (const s of v.storyChecks) {
    if (!s.satisfied) out.push({ note: `story not visibly delivered: ${s.story}`, fix: s.note || `make the UI visibly deliver: ${s.story}` });
  }
  const highs = v.findings.filter((f) => f.severity === "high");
  if (highs.length >= 2) {
    for (const f of highs) out.push({ note: f.note, fix: f.fix || f.note });
  }
  return out;
}
