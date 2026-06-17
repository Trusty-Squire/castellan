/**
 * Pure event→line mapping for the live build progress. Kept separate from app.ts so it
 * is testable without a TTY: feed it trace events, get back the exact append-only lines
 * the TUI prints. It NEVER surfaces raw agent chatter (tool_call/tool_result/text/pack/
 * usage) — only milestones (piece started, check running, escalation, piece committed).
 */
import type { Styler } from "../style.js";
import type { TraceEvent } from "../harness/trace.js";

export interface ProgressState {
  seen: string[];            // node ids in first-seen order → stable ordinal labels
  committed: Set<string>;    // nodes that passed → the climbing k
  checking: Set<string>;     // nodes whose check has been announced once
  total: number | null;      // N (derived node count); may arrive late
}

export function newProgressState(total: number | null = null): ProgressState {
  return { seen: [], committed: new Set(), checking: new Set(), total };
}

const short = (id: string): string => (id.split("/").pop() ?? id).replace(/^claude-/, "");

/** Map one trace event to a single progress line (mutating state), or null for "no output". */
export function renderTraceLine(ev: TraceEvent, st: ProgressState, s: Styler): string | null {
  const id = ev.nodeId;
  if (id && /^\(.*\)$/.test(id)) return null; // skip synthetic raw-mode nodes
  const tot = st.total ? "/" + st.total : "";
  const ord = (x: string): number => { const i = st.seen.indexOf(x); return i < 0 ? st.seen.length : i + 1; };
  switch (ev.kind) {
    case "node_start":
      if (id && !st.seen.includes(id)) { st.seen.push(id); return "  " + s.cyan("▸ ") + `piece ${ord(id)}${tot} — ${id}`; }
      return null;
    case "gate":
      if (id && !st.checking.has(id) && !st.committed.has(id)) { st.checking.add(id); return "  " + s.dim(`· checking ${id}`); }
      return null;
    case "escalate": {
      const next = short(String((ev.payload as { nextModel?: string } | null)?.nextModel ?? ""));
      return id ? "  " + s.gray(`↑ piece ${ord(id)} — retrying with ${next || "a stronger model"}`) : null;
    }
    case "node_pass":
      if (id && !st.committed.has(id)) { st.committed.add(id); st.checking.delete(id); return "  " + s.green("✓ ") + `piece ${st.committed.size}${tot} — ${id}`; }
      return null;
    case "budget_stop":
      return "  " + s.yellow("⏸ budget reached — stopping cleanly");
    default:
      return null;
  }
}
