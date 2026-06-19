/**
 * `ser` with no flags: a print-based funnel. We do NOT own the screen — output prints to the
 * terminal so native scroll + the on-screen keyboard just work. A rail header marks the layer
 * and the model in use; the conversation, spec, build, audit and ship all flow as normal text.
 * Authoring (idea/spec/audit) runs on the PREMIUM model; the build loop is cheap, in a child.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { makeStyler, colorsEnabled, type Styler } from "../style.js";
import { LAYERS, type Layer, wrapText } from "./paint.js";

type Brief = import("../contract/ingest.js").OutcomesBrief;
interface Session { layer: Layer; prompt: string; brief?: Brief; history?: { user: string; ser: string }[]; specPath?: string; buildDir?: string; pendingChange?: string }
interface Ctx { s: Styler; llm: import("../llm/types.js").LlmClient; premium: string; cheap: string; chainName: string; sess: Session; save: () => void; cwd: string; cost: { total: number } }

function parseKey(b: Buffer): { name: string; ch?: string } {
  const s = b.toString("utf8");
  if (s === "\r" || s === "\n") return { name: "enter" };
  if (s === "\x1b[A") return { name: "up" };
  if (s === "\x1b[B") return { name: "down" };
  if (s === "\x7f" || s === "\b") return { name: "backspace" };
  if (s === "\x03") return { name: "ctrl-c" };
  if (s === "\x1b") return { name: "escape" };
  if (s >= " ") return { name: "char", ch: s };
  return { name: "other" };
}

/** Short, readable model id: "anthropic/claude-opus-4" → "opus-4", "qwen/qwen3-coder" → "qwen3-coder". */
function modelShort(id: string): string { return (id.split("/").pop() ?? id).replace(/^claude-/, ""); }

const cols = (): number => process.stdout.columns || 80;
function out(line = ""): void { process.stdout.write(line + "\n"); }
/** Wrap a ser/body paragraph under a coloured label, hanging-indented. */
function para(label: string, text: string): void {
  const indent = " ".repeat(stripLen(label));
  wrapText(text, cols() - stripLen(label) - 4).forEach((l, i) => out("  " + (i === 0 ? label : indent) + l));
}
// eslint-disable-next-line no-control-regex
const stripLen = (x: string): number => x.replace(/\x1b\[[0-9;]*m/g, "").length;

function layerModel(c: Ctx, layer: Layer): string {
  return layer === "ship" ? "" : layer === "build" ? `${modelShort(c.cheap)}+${modelShort(c.premium)}` : modelShort(c.premium);
}

/** The full funnel rail — printed ONCE when you cross into a new stage (the journey map). */
function railFull(c: Ctx, layer: Layer): void {
  const { s } = c;
  const cells = LAYERS.map((l) => l === layer ? s.cyan(s.bold(l)) : LAYERS.indexOf(l) < LAYERS.indexOf(layer) ? s.gray(l) : s.dim(l));
  out("\n  " + cells.join(s.dim(" › ")) + "\n");
}

/** The pinned status — printed just above EVERY prompt: where you are · model · session spend. */
function status(c: Ctx, layer: Layer): void {
  const { s } = c;
  const model = layerModel(c, layer);
  const spend = c.cost.total > 0 ? ` · $${c.cost.total.toFixed(4)}` : "";
  out(s.dim("  ") + s.cyan(layer) + s.dim((model ? " · " + model : "") + spend));
}

/** One line of input via a fresh readline (created+closed per call), so raw-mode pickers can
 * own the keyboard in between without fighting a persistent interface. */
async function ask(c: Ctx, prompt = "  › "): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(c.s.cyan(prompt))).trim(); }
  finally { rl.close(); }
}

/** A raw-mode arrow picker for the spec forks: ↑↓ to move, ↵ to choose, or pick "type my own".
 * Returns the applyChoice() raw ("" = recommended · "a"/"b"… = alt · custom text), or null to quit. */
async function pick(c: Ctx, question: string, why: string, recommended: string, alternatives: string[]): Promise<string | null> {
  const { s } = c;
  out("\n  " + s.bold(question));
  if (why) out(s.gray("  " + why));
  const labels = [recommended, ...alternatives, "type my own…"];
  const n = labels.length;
  let sel = 0;
  // Long options WRAP to several physical rows on a phone. The old redraw moved up
  // a fixed `n` lines and cleared one per option — wrong the moment anything wraps,
  // which left stale highlighted rows ("two selected at once"). So: wrap manually to
  // the real terminal width, blank-line BETWEEN options so boundaries are obvious,
  // and on redraw move up the EXACT physical-row count and clear the whole block.
  let prevRows = 0;
  const draw = (redraw: boolean): void => {
    if (redraw && prevRows) process.stdout.write(`\x1b[${prevRows}A\x1b[0J`); // up over the block + clear to end
    const cols = process.stdout.columns && process.stdout.columns > 24 ? process.stdout.columns : 80;
    const W = Math.max(20, cols - 6); // room for the "  ❯ " gutter + a right margin (avoid terminal auto-wrap)
    let rows = 0;
    for (let i = 0; i < n; i++) {
      const isSel = i === sel;
      const lines = wrapText(labels[i]!, W);
      lines.forEach((ln, j) => {
        const gutter = j === 0 ? (isSel ? s.cyan("❯ ") : "  ") : "  "; // continuation lines align under the text
        // Selected = bold cyan (unmistakable via the accent, not a faint brightness step).
        // Others stay in the readable default foreground — gray (ANSI 90) is near-invisible
        // on phone palettes, so never use it for an option's text.
        process.stdout.write("  " + gutter + (isSel ? s.bold(s.cyan(ln)) : ln) + "\n");
        rows++;
      });
      if (i === 0) { process.stdout.write("     " + s.gray("· recommended") + "\n"); rows++; } // its own line: no overflow
      if (i < n - 1) { process.stdout.write("\n"); rows++; } // a blank line so options never run together
    }
    prevRows = rows;
  };
  out(s.gray("  ↑↓ move · ↵ choose"));
  draw(false);
  process.stdin.setRawMode?.(true); process.stdin.resume();
  const choice = await new Promise<number>((res) => {
    const onData = (b: Buffer): void => {
      const k = parseKey(b);
      if (k.name === "up") { sel = (sel - 1 + n) % n; draw(true); }
      else if (k.name === "down") { sel = (sel + 1) % n; draw(true); }
      else if (k.name === "enter") { off(); res(sel); }
      else if (k.name === "ctrl-c" || k.name === "escape") { off(); res(-1); }
    };
    const off = (): void => { process.stdin.off("data", onData); process.stdin.setRawMode?.(false); };
    process.stdin.on("data", onData);
  });
  if (choice === -1) return null;
  if (choice === n - 1) return (await ask(c, "  your answer › ")) || "";
  if (choice === 0) return "";
  return String.fromCharCode(97 + choice - 1);
}

/** Liveness without cursor tricks: print the label, then APPEND a dot over time (no \r, no
 * clear-line — those broke on terminals that map CR to newline). One clean line, then \n. */
async function spin<T>(c: Ctx, label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write("  " + c.s.gray(label) + c.s.gray(" "));
  const iv = setInterval(() => { process.stdout.write(c.s.dim("·")); }, 650);
  try { return await fn(); } finally { clearInterval(iv); process.stdout.write("\n"); }
}

export async function runTui(resume = false): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('ser needs an interactive terminal. (scripts: ser "<idea>" --to spec)\n');
    return 1;
  }
  const s = makeStyler(colorsEnabled(process.env, true));
  const { makeLlmClient } = await import("../backend.js");
  const baseLlm = await makeLlmClient();
  const cost = { total: 0 };
  const llm: import("../llm/types.js").LlmClient = {
    complete: async (req) => { const r = await baseLlm.complete(req); if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) cost.total += r.costUsd; return r; },
  };
  const { loadChainsForDerive } = await import("../contract/derive.js");
  const { resolveChain } = await import("../contract/schema.js");
  const chain = resolveChain(loadChainsForDerive(process.cwd()), "cheap");
  const stateDir = join(process.cwd(), ".ser"), statePath = join(stateDir, "session.json");
  // Bare `ser` always starts fresh; only `ser --continue` resumes the saved session.
  const sess: Session = resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { layer: "idea", prompt: "" };
  const save = (): void => { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(sess)); };
  const c: Ctx = { s, llm, premium: chain.knight, cheap: chain.executor, chainName: "cheap", sess, save, cwd: process.cwd(), cost };

  out("\n  " + s.bold("ser") + s.dim("  — describe what you want; we'll talk it through, then build it."));
  out(s.dim("  (commands: /spec /build /back /restart /quit · scroll with your terminal)"));
  let code = 0;
  try {
    for (;;) {
      let cont: boolean;
      switch (sess.layer) {
        case "idea": cont = await ideaLayer(c); break;
        case "spec": cont = await specLayer(c); break;
        case "build": cont = await buildLayer(c); break;
        case "audit": cont = await auditLayer(c); break;
        case "ship": cont = await shipLayer(c); break;
      }
      if (!cont) break;
    }
  } catch (e) { code = 1; out(s.red("\n  error: " + (e instanceof Error ? e.message : String(e)))); }
  out(s.dim("\n  saved — `ser --continue` to pick up where you left off.\n"));
  return code;
}

// ---------------- LAYER 1: idea (premium conversation) ----------------
async function ideaLayer(c: Ctx): Promise<boolean> {
  const { s } = c;
  const { discussIdea, EMPTY_BRIEF } = await import("../contract/ingest.js");
  const history = c.sess.history ?? (c.sess.history = []);
  let brief: Brief = history.length ? (c.sess.brief ?? { ...EMPTY_BRIEF }) : { ...EMPTY_BRIEF };
  let ready = history.length > 0 && !!(brief.intent || brief.outcomes.length);
  railFull(c, "idea");
  if (history.length) history.forEach((h) => { para(s.gray("you  "), h.user); para(s.cyan("ser  "), h.ser); }); // replay on resume
  else out("  " + s.bold("what do you want to build?"));
  for (;;) {
    status(c, "idea");
    const msg = await ask(c);
    if (msg === "/quit") return false;
    if (msg === "/spec" || (msg === "" && ready)) { c.sess.brief = brief; c.sess.layer = "spec"; c.save(); return true; }
    if (msg === "/restart") { c.sess.prompt = ""; delete c.sess.brief; history.length = 0; brief = { ...EMPTY_BRIEF }; ready = false; c.save(); out("\n  " + s.bold("what do you want to build?")); continue; }
    if (msg === "") { out(s.dim("  (keep talking, or /spec when you're ready)")); continue; }
    if (!c.sess.prompt) c.sess.prompt = msg;
    const r = await spin(c, "thinking it through", () => discussIdea(history, msg, brief, c.llm, c.premium));
    brief = r.brief; ready = r.ready; history.push({ user: msg, ser: r.reply }); c.sess.brief = brief; c.save();
    para(s.cyan("ser  "), r.reply);
    if (brief.intent || brief.outcomes.length) wrapText("→ " + briefSummary(brief), cols() - 4).forEach((l) => out(s.dim("  " + l)));
    if (ready) out(s.dim("  (I think I've got it — Enter or /spec to move on, or keep refining)"));
  }
}

function briefSummary(b: Brief): string {
  const bits = [b.intent];
  if (b.outcomes.length) bits.push(`${b.outcomes.length} outcome${b.outcomes.length > 1 ? "s" : ""}`);
  if (b.nonGoals.length) bits.push(`not: ${b.nonGoals.join(", ")}`);
  if (b.constraints.length) bits.push(`limits: ${b.constraints.join(", ")}`);
  return bits.filter(Boolean).join("  ·  ");
}

// ---------------- LAYER 2: spec (premium breakdown) ----------------
async function specLayer(c: Ctx): Promise<boolean> {
  const { s } = c;
  const { extractIdea, briefToText, converseIdea } = await import("../contract/ingest.js");
  const { ideaToSpec, applyChoice } = await import("../contract/brief.js");
  const { reviewSpec } = await import("../contract/review.js");
  const { withFrontendFloorStories } = await import("../review/frontend-floor.js");
  const { stringify } = await import("yaml");
  railFull(c, "spec");
  const input = c.sess.brief && (c.sess.brief.intent || c.sess.brief.outcomes.length) ? briefToText(c.sess.brief) : c.sess.prompt;
  let idea = (c as Ctx & { idea?: Awaited<ReturnType<typeof extractIdea>> }).idea ?? (await spin(c, "turning your outcomes into a gated spec", () => extractIdea(input, c.llm, c.premium)));
  delete (c as Ctx & { idea?: unknown }).idea;
  // A change carried in from a halted build (or anywhere) reshapes the idea BEFORE we
  // re-derive — so the rebuild actually reflects the fix instead of repeating the spec.
  if (c.sess.pendingChange) {
    const change = c.sess.pendingChange; delete c.sess.pendingChange; c.save();
    const r = await spin(c, "folding in the fix from the build", () => converseIdea(c.sess.prompt, idea, [], change, c.llm, c.premium));
    idea = r.idea;
    para(s.cyan("ser  "), r.reply);
  }
  // resolve only the forks that genuinely need you — ARROW-PICK, no typing required
  const resolutions = [];
  for (const d of idea.decisions) {
    if (d.bucket !== 1) { resolutions.push(applyChoice(d, "")); continue; }
    const raw = await pick(c, d.question, d.why.split(/[.;]/)[0]!.trim(), d.recommendation, d.alternatives);
    if (raw === null) return false;
    resolutions.push(applyChoice(d, raw));
  }
  const spec = withFrontendFloorStories(ideaToSpec(c.sess.prompt, idea, resolutions));
  const review = await spin(c, "running the eng + design review", () => reviewSpec(spec, c.llm, c.premium));
  // ser closes obvious gaps himself — each becomes a new gated requirement.
  let rn = spec.requirements.length;
  for (const p of review.patches) {
    spec.requirements.push({ id: `R${++rn}`, statement: p.statement, acceptance: { tier: 1, gate: p.gate } });
  }
  if (review.patches.length) {
    out("\n  " + s.green(`i closed ${review.patches.length} obvious gap${review.patches.length > 1 ? "s" : ""} myself`) + s.gray(" (each is now a check):"));
    review.patches.forEach((p) => para(s.gray("    + "), p.statement));
  }
  // The genuine judgment calls are YOURS — so ASK them here (don't bury them as a
  // passive note above the build button). Each answer is recorded as a decision
  // before anything is built; pressing Enter on a pick takes the recommendation.
  let dn = spec.decisions.length, qn = spec.open_questions.length;
  for (const q of review.open_questions) {
    if (q.options.length) {
      const raw = await pick(c, q.text, "this one's genuinely yours to call", q.options[0]!, q.options.slice(1));
      if (raw === null) return false;
      const decided = raw === "" ? q.options[0]! : /^[a-z]$/.test(raw) ? (q.options[raw.charCodeAt(0) - 96] ?? raw) : raw;
      spec.decisions.push({ id: `D${++dn}`, statement: `${q.text} → ${decided}`, rationale: "decided by you at spec review", claims: [] });
    } else {
      const ans = (await ask(c, "\n  " + s.cyan("? ") + q.text + "\n  your call › ")).trim();
      if (ans === "/quit") return false;
      if (ans) spec.decisions.push({ id: `D${++dn}`, statement: `${q.text} → ${ans}`, rationale: "decided by you at spec review", claims: [] });
      else spec.open_questions.push({ id: `Q${++qn}`, text: q.text, blocking: q.blocking });
    }
  }
  const specPath = join(c.cwd, ".ser", "spec.yaml");
  mkdirSync(join(c.cwd, ".ser"), { recursive: true });
  writeFileSync(specPath, stringify(spec)); c.sess.specPath = specPath; c.save();
  out("\n  " + s.green(`spec ready — ${spec.requirements.length} checks i can verify.`));
  out("\n  " + s.cyan("→ ") + "press Enter to build it, or tell me what to change.");
  for (;;) {
    status(c, "spec");
    const msg = await ask(c, "  ↵ build · type a change · /back › ");
    if (msg === "/quit") return false;
    if (msg === "/back") { c.sess.layer = "idea"; c.save(); return true; }
    if (msg === "/build" || msg === "") { c.sess.layer = "build"; c.save(); return true; }
    const r = await spin(c, "thinking it through", () => converseIdea(c.sess.prompt, idea, [], msg, c.llm, c.premium));
    idea = r.idea; (c as Ctx & { idea?: unknown }).idea = r.idea;
    para(s.cyan("ser  "), r.reply);
    out("\n  " + s.cyan("→ ") + "press Enter to build with this, or keep refining.");
    return true; // re-enter spec to re-derive from the revised idea
  }
}

// ---------------- LAYER 3: build (cheap loop in a child; clean status) ----------------
async function buildLayer(c: Ctx): Promise<boolean> {
  const { s } = c;
  const buildDir = c.sess.buildDir ?? join(c.cwd, "build");
  c.sess.buildDir = buildDir; c.save();
  railFull(c, "build");
  const self = fileURLToPath(new URL("../cli.js", import.meta.url));
  const captured: string[] = [];
  out(s.gray("  building — each piece commits only when its check passes…\n"));

  const { followTrace } = await import("./trace-follow.js");
  const { readHaltFacts, investigateHalt, failingNodeContext, missionNodeCount } = await import("./diagnose.js");
  const { newProgressState, renderTraceLine } = await import("./progress.js");
  const squireDir = join(buildDir, ".squire");

  // Live, append-only progress driven by the build's structured trace. We show the
  // pieces landing, the cheap→premium ladder when ser escalates, and the check running
  // — never raw agent chatter. N is the derived node count (NOT spec.requirements).
  const prog = newProgressState(missionNodeCount(buildDir));
  let pinnedTrace: string | null = null;
  const startedAt = Date.now();
  let lastOutputAt = startedAt;

  // `startedAt` fences off any leftover trace from a PRIOR run: the follower only
  // surfaces a trace this build actually wrote, so we never replay a dead run's ladder.
  const follower = followTrace(squireDir, (ev) => {
    if (prog.total === null) prog.total = missionNodeCount(buildDir);
    const line = renderTraceLine(ev, prog, s);
    if (line !== null) { out(line); lastOutputAt = Date.now(); }
  }, startedAt);
  // A heartbeat when no VISIBLE milestone has printed for a while. Time the visible
  // output, NOT trace activity: an attempt in progress streams plenty of hidden
  // tool-call events, so gating on those would keep the heartbeat silent mid-work.
  const heartbeat = setInterval(() => {
    if (Date.now() - lastOutputAt > 20_000) { out(s.dim("  …still working — the fleet is on it")); lastOutputAt = Date.now(); }
  }, 5_000);

  const code = await new Promise<number | null>((res) => {
    const child = spawn(process.execPath, [self, "--spec", c.sess.specPath!, "--to", "build", "--yes", "--workdir", buildDir], { stdio: ["ignore", "pipe", "pipe"] });
    const grab = (b: Buffer): void => {
      for (const l of b.toString().split("\n")) {
        const t = l.replace(/\x1b\[[0-9;]*m/g, "").trim(); // eslint-disable-line no-control-regex
        if (!t) continue;
        captured.push(t);
        const m = t.match(/^trace:\s*(.+\.jsonl)$/);
        if (m && !pinnedTrace) { pinnedTrace = m[1]!; follower.pin(pinnedTrace); }
      }
    };
    child.stdout?.on("data", grab); child.stderr?.on("data", grab);
    child.on("exit", res);
  });
  clearInterval(heartbeat);
  follower.stop();
  const tracePath = pinnedTrace ?? follower.resolvedPath();

  // the build runs in a child, so its spend isn't on our wrapped client — pull it from the output.
  const costs = captured.join("\n").match(/\$(\d+\.\d{2,})/g);
  if (costs?.length) { const v = parseFloat(costs[costs.length - 1]!.slice(1)); if (Number.isFinite(v)) c.cost.total += v; }
  if (code === 0) { out("\n  " + s.green("✓ built — every check passed") + s.gray(`   → ${buildDir}`)); c.sess.layer = "audit"; c.save(); return true; }

  // ---- honest halt: say plainly what happened, then offer a real (non-bricking) path ----
  out("\n  " + s.yellow("a check couldn't pass, so the build stopped — nothing unverified ships."));
  const facts = tracePath ? readHaltFacts(tracePath, captured) : null;
  if (facts?.failingNodeId) {
    para(s.gray("  piece  "), facts.failingNodeId);
    if (facts.gateCommand) para(s.gray("  check  "), facts.gateCommand + (facts.timedOut ? "  (timed out)" : ""));
    if (facts.stderrTail) para(s.gray("  error  "), facts.stderrTail.split("\n").map((x) => x.trim()).filter(Boolean).slice(-4).join("  ").slice(0, 240) || "(no error text)");
    if (facts.reconcileViolations.length) para(s.gray("  drift  "), facts.reconcileViolations.join("; "));
  }
  const nodeCtx = facts ? failingNodeContext(buildDir, facts.failingNodeId) : null;
  const dx = facts
    ? await spin(c, "working out what happened", () => investigateHalt(facts, nodeCtx?.brief ?? "", nodeCtx?.gate ?? facts.gateCommand ?? "", c.llm, c.premium))
    : null;
  if (dx?.explanation) para(s.cyan("ser  "), dx.explanation);
  if (dx?.check_verdict) para(s.gray("  check  "), dx.check_verdict);
  if (dx?.remedy) para(s.green("  fix    "), dx.remedy);

  const serOwns = dx?.owner === "ser";
  out("");
  out("  " + s.cyan("→ ") + (serOwns
    ? "this one's mine — press Enter and i'll fold my fix into the spec, then rebuild."
    : "this needs a call from you — a change, not a retry (the build already used its strongest model)."));
  out(s.dim("  ↵ revise with the fix · type your own change · /retry the same build · /quit"));
  for (;;) {
    const msg = await ask(c);
    if (msg === "/quit") return false;
    if (msg === "/retry") return true; // re-run the same build (clearly the "same again" path)
    if (msg === "/back" || msg === "") {
      const fix = serOwns
        ? (dx?.corrected_check ? `the check for "${facts?.failingNodeId}" was wrong — use this check instead: ${dx.corrected_check}` : dx?.remedy)
        : (dx?.spec_change || dx?.remedy);
      c.sess.pendingChange = fix || "the build halted on a check it couldn't pass — adjust the spec so it's buildable";
      c.sess.layer = "spec"; c.save(); return true;
    }
    // the user described their own change → carry it into the spec revision
    c.sess.pendingChange = msg;
    c.sess.layer = "spec"; c.save(); return true;
  }
}

// ---------------- LAYER 4: audit ----------------
async function auditLayer(c: Ctx): Promise<boolean> {
  const { s } = c;
  const { auditBuild } = await import("../contract/review.js");
  const { parseSpec } = await import("../contract/spec.js");
  const { withFrontendFloorStories } = await import("../review/frontend-floor.js");
  railFull(c, "audit");
  const spec = withFrontendFloorStories(parseSpec(readFileSync(c.sess.specPath!, "utf8"), c.sess.specPath!));
  const audit = await spin(c, "fresh eyes on the finished build", () => auditBuild(collect(c.sess.buildDir!), { thesis: spec.thesis, stories: spec.stories }, c.llm, c.premium));
  const rank: Record<string, number> = { high: 0, med: 1, low: 2 };
  const recs = audit.recommendations.sort((a, b) => rank[a.severity]! - rank[b.severity]!);
  if (!recs.length) out("  " + s.green("clean — nothing worth polishing."));
  recs.forEach((r) => out("  " + (r.severity === "high" ? s.yellow("[high]") : r.severity === "med" ? "[med] " : s.gray("[low] ")) + " " + s.gray(r.lens.padEnd(7)) + r.note));

  // Live visual review with teeth: render the UI, judge the screenshot, and if a
  // story isn't visibly delivered (or a high-severity design finding), fold the
  // fix into the spec and rebuild — the same honest-halt loop the build uses.
  const { makeVisualClient } = await import("../backend.js");
  const { renderBuild, visualReview, blockingFixes } = await import("../review/visual.js");
  const shot = await spin(c, "rendering the build for a visual review", () => renderBuild(c.sess.buildDir!));
  if (!shot.ok) {
    if (/not a visual build/i.test(shot.note ?? "")) out(s.dim(`  visual review skipped — ${shot.note}`));
    else {
      out("\n  " + s.yellow(`visual review unavailable — ${shot.note}`));
      out(s.dim("  /ship anyway · /quit"));
      for (;;) {
        const msg = await ask(c);
        if (msg === "/quit") return false;
        if (msg === "/ship") break;
      }
    }
  } else {
    const vc = await makeVisualClient();
    if (!vc) {
      out("\n  " + s.yellow("visual review unavailable — no multimodal reviewer is configured for a rendered UI."));
      out(s.dim("  /ship anyway · /quit"));
      for (;;) {
        const msg = await ask(c);
        if (msg === "/quit") return false;
        if (msg === "/ship") break;
      }
    } else {
      const verdict = await spin(c, "design review — fresh eyes on the screen", () => visualReview(shot, { thesis: spec.thesis, stories: spec.stories }, vc.llm, vc.model));
      if (!verdict) {
        out("\n  " + s.yellow("visual review failed to produce a verdict for this rendered UI."));
        out(s.dim("  /ship anyway · /quit"));
        for (;;) {
          const msg = await ask(c);
          if (msg === "/quit") return false;
          if (msg === "/ship") break;
        }
      } else {
        verdict.dimensions.filter((d) => d.score <= 5).sort((a, b) => a.score - b.score)
          .forEach((d) => out("  " + s.yellow(`${d.score}/10`) + " " + s.gray("design ") + d.name));
        const fixes = blockingFixes(verdict);
        if (fixes.length > 0) {
          out("\n  " + s.yellow("the built UI doesn't deliver the spec yet — i won't ship it:"));
          fixes.forEach((f) => para(s.yellow("  ✗ "), f.fix));
          out("\n  " + s.cyan("→ ") + "press Enter and i'll fold these design fixes into the spec, then rebuild.");
          out(s.dim("  ↵ revise with the fixes · /ship anyway · /quit"));
          for (;;) {
            const msg = await ask(c);
            if (msg === "/quit") return false;
            if (msg === "/ship") break; // user overrides the block
            if (msg === "" || msg === "/back") {
              c.sess.pendingChange = "the built UI failed its visual design review. Apply these fixes: " + fixes.map((f) => f.fix).join("; ");
              c.sess.layer = "spec"; c.save(); return true;
            }
          }
        } else out("  " + s.green("visual review: the screen delivers every story."));
      }
    }
  }
  for (;;) {
    status(c, "audit");
    const msg = await ask(c);
    if (msg === "/quit") return false;
    if (msg === "/back") { c.sess.layer = "build"; c.save(); return true; }
    if (msg === "" || msg === "/ship") { c.sess.layer = "ship"; c.save(); return true; }
    out(s.dim("  (Enter to ship · /back to build · audit fixes are coming)"));
  }
}

// ---------------- LAYER 5: ship ----------------
async function shipLayer(c: Ctx): Promise<boolean> {
  const { s } = c;
  const { parseSpec } = await import("../contract/spec.js");
  const spec = parseSpec(readFileSync(c.sess.specPath!, "utf8"), c.sess.specPath!);
  railFull(c, "ship");
  out("\n  " + s.green("✓ shipped") + s.gray("  → " + c.sess.buildDir));
  out(s.gray(`  ${spec.requirements.length} checks green · run it:  ls ${c.sess.buildDir}`));
  const msg = await ask(c, "\n  new build? type the idea, or /quit:  ");
  if (msg === "/quit" || msg === "") return false;
  rmSync(join(c.cwd, ".ser", "session.json"), { force: true });
  c.sess.layer = "idea"; c.sess.prompt = msg; delete c.sess.brief; c.sess.history = []; delete c.sess.specPath; delete c.sess.buildDir;
  c.save();
  return true;
}

function collect(dir: string): { path: string; src: string }[] {
  const out2: { path: string; src: string }[] = [];
  const ok = /\.(js|jsx|ts|tsx|mjs|cjs|html|css|json|py|go|rs)$/;
  const walk = (d: string, base: string): void => {
    for (const f of readdirSync(d)) {
      if ([".git", "node_modules", ".ser", ".squire"].includes(f) || f === "mission.yaml" || f.endsWith(".spec.yaml")) continue;
      const p = join(d, f), rel = base ? `${base}/${f}` : f;
      if (statSync(p).isDirectory()) walk(p, rel);
      else if (ok.test(f) && out2.length < 40) out2.push({ path: rel, src: readFileSync(p, "utf8") });
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out2;
}
