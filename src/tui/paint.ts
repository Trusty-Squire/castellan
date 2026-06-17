/**
 * The "Quiet" TUI aesthetic: monochrome + one accent (cyan), airy, no boxes.
 * Pure string-builders — no I/O — so frames are testable and printable. The
 * interactive runtime (app.ts) composes these and drives the alt-screen.
 */
import type { Styler } from "../style.js";

export type Layer = "idea" | "spec" | "build" | "audit" | "ship";
export const LAYERS: Layer[] = ["idea", "spec", "build", "audit", "ship"];

const PAD = "  ";

/** strip ANSI to measure true column width */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The funnel rail: done = muted, current = accent, ahead = faint. A ● sits under you.
 * Collapses to a compact dot form (✓ ✓ ● ○ ○  spec 2/5) when the terminal is too narrow. */
export function rail(s: Styler, current: Layer, done: Set<Layer>, cols = 80): string {
  const sep = s.dim(" ──── ");
  const cells = LAYERS.map((l) => (l === current ? s.cyan(s.bold(l)) : done.has(l) ? s.gray(l) : s.dim(l)));
  const line = PAD + cells.join(sep);
  if (plain(line).length + 1 > cols) {
    const marks = LAYERS.map((l) => (l === current ? s.cyan("●") : done.has(l) ? s.gray("✓") : s.dim("○"))).join(" ");
    return PAD + marks + "   " + s.cyan(s.bold(current)) + s.dim(`  ${LAYERS.indexOf(current) + 1}/5`);
  }
  // marker: a ● centered under the current cell
  let col = plain(PAD).length;
  for (const l of LAYERS) {
    if (l === current) break;
    col += l.length + plain(sep).length;
  }
  const marker = " ".repeat(col + Math.floor(current.length / 2)) + s.cyan("●");
  return line + "\n" + marker;
}

/** A line of affordances; the primary one wears the accent. */
export function actions(s: Styler, items: { key: string; label: string; primary?: boolean }[]): string {
  return PAD + items.map((i) => (i.primary ? s.cyan(i.key) : s.gray(i.key)) + " " + s.gray(i.label)).join(s.dim("      "));
}

/** Compose a full Quiet frame: brandmark · rail · body · actions, with air around each. */
export function frame(
  s: Styler,
  opts: { current: Layer; done: Set<Layer>; body: string[]; actions: { key: string; label: string; primary?: boolean }[]; cols?: number },
): string {
  return [
    "",
    s.dim(PAD + "ser"),
    "",
    "",
    rail(s, opts.current, opts.done, opts.cols),
    "",
    "",
    ...opts.body.map((l) => (l === "" ? "" : PAD + l)),
    "",
    "",
    actions(s, opts.actions),
    "",
  ].join("\n");
}

// ---- per-layer bodies ----

export function askBody(s: Styler, question: string, hint: string, typed: string): string[] {
  return [s.bold(question), ...(hint ? [s.gray(hint)] : []), "", s.cyan("› ") + typed + s.cyan("▏")];
}

/** The persistent message line — always on, so you can talk to ser at any layer. */
export function inputLine(s: Styler, typed: string, hint: string): string {
  return s.cyan("› ") + typed + s.cyan("▏") + (typed ? "" : "  " + s.dim(hint));
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = []; let cur = "";
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** Every wrapped line of the transcript (you/ser turns). Caller uses .length to clamp scroll. */
export function convoLines(s: Styler, history: { user: string; ser: string }[], cols: number): string[] {
  const W = Math.max(24, cols - 9);
  const lines: string[] = [];
  for (const h of history) {
    wrapText(h.user, W).forEach((l, i) => lines.push((i === 0 ? s.gray("you  ") : "     ") + l));
    wrapText(h.ser, W).forEach((l, i) => lines.push((i === 0 ? s.cyan("ser  ") : "     ") + l));
    lines.push("");
  }
  return lines;
}

/** A scrolled window of the transcript. scroll = lines hidden below (0 = latest at the bottom). */
export function convoBody(s: Styler, history: { user: string; ser: string }[], scroll: number, cols: number, rows: number): string[] {
  const lines = convoLines(s, history, cols);
  const area = Math.max(4, rows);
  const end = Math.max(area, lines.length - scroll); // never show fewer than `area` from the top
  const start = Math.max(0, end - area);
  const above = start, below = Math.max(0, lines.length - end);
  return [
    above > 0 ? s.dim(`↑ ${above} earlier  ·  PgUp`) : "",
    ...lines.slice(start, end),
    below > 0 ? s.dim(`↓ ${below} newer  ·  PgDn`) : "",
  ];
}

export function storiesBody(s: Styler, lead: string, stories: string[]): string[] {
  return [s.gray(lead), "", ...stories.map((st, i) => "  " + s.cyan(String(i + 1)) + "  " + st)];
}

export function forkBody(s: Styler, question: string, why: string, options: string[], sel: number): string[] {
  return [
    s.bold(question),
    ...(why ? [s.gray(why)] : []),
    "",
    ...options.map((o, i) => (i === sel ? "  " + s.cyan("→  ") + o : "  " + s.dim("   ") + s.gray(o))),
  ];
}

export function notesBody(s: Styler, lead: string, notes: { tag: string; text: string }[]): string[] {
  return [s.gray(lead), "", ...notes.map((n) => "  " + s.cyan(n.tag.padEnd(7)) + s.gray(n.text))];
}

export type GateState = "pass" | "active" | "pending" | "fail";
export function buildBody(s: Styler, lead: string, gates: { state: GateState; label: string }[]): string[] {
  const mark = (g: { state: GateState; label: string }): string => {
    if (g.state === "pass") return s.green("✓") + "  " + s.gray(g.label);
    if (g.state === "active") return s.cyan("⟳") + "  " + g.label;
    if (g.state === "fail") return s.red("✗") + "  " + g.label;
    return s.dim("·") + "  " + s.dim(g.label);
  };
  return [s.gray(lead), "", ...gates.map((g) => "  " + mark(g))];
}

export function shipBody(s: Styler, where: string, gateCount: number, noteCount: number, run: string): string[] {
  return [
    s.green("✓ shipped") + "  " + s.gray("→ " + where),
    s.gray(`  ${gateCount} checks green · ${noteCount} audit note(s)`),
    "",
    s.gray("run it:  ") + run,
  ];
}
