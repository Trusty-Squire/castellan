import { execa } from "execa";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SquireError } from "../errors.js";
import { extractJsonBlock } from "./claude-cli.js";
import type { LlmClient } from "./types.js";

/**
 * An LlmClient backed by the Codex CLI (`codex exec`), so planning/authoring
 * calls run on the user's Codex SUBSCRIPTION instead of metered OpenRouter
 * tokens (and without the egress-grant flakiness). Like ClaudeCliClient this is
 * "model-as-Codex-agent", not a bare completion: codex wraps its own system
 * prompt and may narrate around requested JSON, so we salvage the object.
 *
 * The OpenRouter model id passed by callers (e.g. "anthropic/claude-opus-4") is
 * IGNORED — codex uses its subscription model. Override with CODEX_MODEL.
 */
export class CodexCliClient implements LlmClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly model?: string;
  private readonly reasoningEffort?: string;

  constructor(opts: { bin?: string; timeoutMs?: number; model?: string; reasoningEffort?: string } = {}) {
    this.bin = opts.bin ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.model = opts.model ?? process.env.CODEX_MODEL;
    this.reasoningEffort = opts.reasoningEffort ?? process.env.CODEX_REASONING_EFFORT ?? "low";
  }

  async complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
    signal?: AbortSignal;
    images?: { dataUrl: string }[];
  }): Promise<{ text: string; inTokens: number; outTokens: number }> {
    // codex exec has no separate system-prompt flag — fold it into one prompt.
    // CRITICAL for speed: codex is an AGENT and will otherwise shell out (ripgrep,
    // file reads) to "investigate" a planning/review prompt — a 10s answer turns
    // into minutes. These calls are reasoning over the text/images already in the
    // prompt, so forbid tool use up front and demand an immediate answer.
    const preamble = req.images?.length
      ? "You are reviewing the attached images and the accompanying text. Answer using ONLY the text and images in this prompt: do NOT run commands, use tools, or read/search files. The read-only sandbox you are running in right now applies ONLY to this reasoning turn. Reason internally and output your final answer immediately."
      : "You are PLANNING software that will be BUILT LATER in a normal, writable development environment — you are not building anything now. Answer using ONLY the text in this prompt: do NOT run commands, use tools, or read/search files (everything you need is below). The read-only sandbox you are running in right now applies ONLY to this reasoning turn; it places NO constraint whatsoever on the product being planned (the product CAN create files, run code, install deps, etc.). Reason internally and output your final answer immediately.";
    const prompt = [
      preamble,
      "",
      req.system,
      "",
      req.user,
      req.json ? "\nRespond with ONLY the JSON object — no prose, no code fences." : "",
    ].join("\n");

    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // A neutral, throwaway cwd: read-only sandbox + an empty dir keeps codex
      // from wandering the real project while it answers a planning prompt.
      const dir = mkdtempSync(join(tmpdir(), "codex-llm-"));
      const msgFile = join(dir, "msg.txt");
      const imagePaths = writeImageDataUrls(req.images ?? [], dir);
      const args = [
        "exec",
        "-s", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color", "never",
        "-C", dir,
        "-o", msgFile,
        ...(this.reasoningEffort ? ["-c", `model_reasoning_effort="${this.reasoningEffort}"`] : []),
        ...imagePaths.flatMap((p) => ["-i", p]),
        ...(this.model ? ["-m", this.model] : []),
      ];
      // Detached + hard-wall race so a hung codex (sandbox grandchildren holding the
      // pipe open) can't stall planning forever — kill the whole group and retry.
      const sub = execa(this.bin, args, {
        timeout: this.timeoutMs,
        input: prompt,
        cancelSignal: req.signal,
        detached: true,
        forceKillAfterDelay: 10_000,
      });
      sub.catch(() => {});
      try {
        await Promise.race([
          sub,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`codex hard-timeout after ${Math.round((this.timeoutMs + 30_000) / 1000)}s`)), this.timeoutMs + 30_000).unref(),
          ),
        ]);
        const raw = readFileSync(msgFile, "utf8").trim();
        const text = req.json ? extractJsonBlock(raw) : raw;
        if (req.json && !text.includes("{")) {
          lastErr = `codex returned no JSON: ${raw.slice(0, 80)}`;
          continue;
        }
        if (!raw) { lastErr = "codex returned an empty message"; continue; }
        return { text, inTokens: 0, outTokens: 0 };
      } catch (err) {
        try { if (sub.pid) process.kill(-sub.pid, "SIGKILL"); } catch { /* group gone */ }
        try { sub.kill("SIGKILL"); } catch { /* already dead */ }
        lastErr = (err as Error).message.split("\n")[0] ?? "codex exec failed";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw new SquireError("LLM_RETRY", `CodexCliClient failed after retries: ${lastErr}`);
  }
}

export function writeImageDataUrls(images: { dataUrl: string }[], dir: string): string[] {
  return images.map((img, i) => {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(img.dataUrl);
    if (!match) throw new SquireError("BAD_IMAGE", "expected image data URL");
    const mime = match[1];
    const data = match[2];
    if (!mime || !data) throw new SquireError("BAD_IMAGE", "expected image data URL");
    const ext = extensionForMime(mime);
    const path = join(dir, `image-${i + 1}.${ext}`);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  });
}

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      throw new SquireError("BAD_IMAGE", `unsupported image mime type: ${mime}`);
  }
}
