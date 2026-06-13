/**
 * Minimal, dependency-free ANSI styling for the talk REPL. Colors are emitted
 * only to an interactive TTY (and never when NO_COLOR is set), so piped output,
 * logs, and tests stay plain. A full split-pane TUI is a separate later effort.
 */
export interface Styler {
  enabled: boolean;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

export function makeStyler(enabled: boolean): Styler {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    enabled,
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    gray: wrap("90"),
    bold: wrap("1"),
    dim: wrap("2"),
  };
}

/**
 * Decide whether to emit color. Precedence: NO_COLOR (any value) disables;
 * FORCE_COLOR / CLICOLOR_FORCE force on (for terminals where isTTY detection is
 * unreliable — tmux/SSH/phone clients); otherwise follow the TTY. An explicit
 * `override` (from a --color/--no-color flag) wins over everything but NO_COLOR.
 */
export function colorsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY),
  override?: boolean,
): boolean {
  if (env.NO_COLOR != null) return false;
  if (override !== undefined) return override;
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true" || env.CLICOLOR_FORCE === "1") return true;
  return isTty;
}

/** Color the per-turn delta summary: + adds green, - removes red, ~ modifies yellow. */
/**
 * What just got LOCKED IN, in plain words — terse but complete. The structural
 * token form (styleDeltaSummary) said "+decisions:D2"; this says "decided:
 * storage=SQLite". Reads the delta VALUE so the user can veto a bad call
 * without asking "what did you just record?".
 */
export function styleLockedIn(
  deltas: { op: string; section: string; id?: string; value?: unknown; drift?: boolean }[],
  s: Styler,
): string {
  const clip = (t: string | undefined): string => (t && t.length > 56 ? t.slice(0, 55) + "…" : (t ?? ""));
  const phrase = (d: { op: string; section: string; id?: string; value?: unknown }): string | null => {
    const v = (d.value && typeof d.value === "object" ? d.value : {}) as { statement?: string };
    if (d.section === "thesis" && d.op === "modify") return "thesis set";
    if (d.section === "requirements" && d.op === "add") return `+req: ${clip(v.statement)}`;
    if (d.section === "decisions" && (d.op === "add" || d.op === "modify")) return `decided: ${clip(v.statement)}`;
    if (d.section === "open_questions" && d.op === "resolve") return "resolved ✓";
    if (d.section === "claims" && d.op === "add") return "+claim";
    if (d.op === "remove") return `−${d.section}${d.id ? " " + d.id : ""}`;
    return null;
  };
  const parts = deltas.map(phrase).filter((p): p is string => p !== null);
  const drift = deltas.some((d) => d.drift);
  const body = parts.length > 0 ? parts.join(" · ") : "noted";
  return s.dim(body) + (drift ? " " + s.bold(s.red("⚠drift")) : "");
}

export function styleDeltaSummary(
  deltas: { op: string; section: string; id?: string; drift?: boolean }[],
  s: Styler,
): string {
  return deltas
    .map((d) => {
      const sign = d.op === "add" ? "+" : d.op === "remove" ? "-" : "~";
      const color = d.op === "add" ? s.green : d.op === "remove" ? s.red : s.yellow;
      const token = `${sign}${d.section}${d.id ? ":" + d.id : ""}`;
      return color(token) + (d.drift ? s.bold(s.red("⚠drift")) : "");
    })
    .join(" ");
}
