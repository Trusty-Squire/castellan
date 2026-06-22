/**
 * PRODUCT ARCHETYPE — classify an idea so the funnel can pick the stack + scaffold + gate shape
 * the cheap loop can most reliably BUILD and the harness can most reliably GATE.
 *
 * The lever isn't "one stack for everything" — it's: per archetype, vendor the known-contract
 * plumbing so the cheap worker doesn't improvise it, and use the gate shape that archetype affords.
 * Most archetypes are already cheap-buildable on the existing test floor (a library is unit tests,
 * a CLI is stdout/exit on fixtures). The WEB APP is the outlier — free-form server+UI is where
 * improvisation breaks — so it gets the heavy scaffold (server plumbing + a static UI palette) and
 * the planner is steered to the Node+static stack the harness can guarantee. The CREATIVE archetype
 * is the hard edge: its quality is un-gateable, so stack choice doesn't save it (visual judge +
 * human gate). Classification is cheap RECALL, not load-bearing judgment, so a cheap model does it;
 * an unrecognized reply defaults to "other" (no steering — status quo).
 */
import type { LlmClient } from "../llm/types.js";

export const ARCHETYPES = ["web-app", "cli", "library", "pipeline", "bot", "creative", "other"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

const CLASSIFY_SYSTEM =
  "Classify a software product idea into EXACTLY ONE build archetype. Reply with ONLY the archetype word, nothing else.\n" +
  "- web-app: has a browser UI and/or an HTTP server/API (dashboards, CRUD apps, web tools, REST APIs, anything served over http and opened in a browser or called over http)\n" +
  "- cli: a command-line tool run in a terminal (args in, stdout/exit out)\n" +
  "- library: importable code/SDK with NO UI and NO server (parsers, algorithms, data structures, utilities)\n" +
  "- pipeline: batch data processing / ETL / a script that reads input and writes output files\n" +
  "- bot: an automation/integration whose job is talking to an EXTERNAL service or API (chat bots, scrapers, webhook handlers, sync jobs)\n" +
  "- creative: a game, generative art, or an experience whose quality is subjective/visual\n" +
  "- other: none of the above";

/** Classify the product idea. Cheap model; defaults to "other" (no steering) on an unknown reply. */
export async function classifyArchetype(llm: LlmClient, model: string, idea: string): Promise<Archetype> {
  try {
    const r = await llm.complete({ model, system: CLASSIFY_SYSTEM, user: `IDEA:\n${idea}`, maxTokens: 12 });
    return parseArchetype(r.text);
  } catch {
    return "other";
  }
}

/** Extract a known archetype from a model reply, tolerant of punctuation/casing/extra words. */
export function parseArchetype(text: string): Archetype {
  const t = text.toLowerCase();
  // longest-token-first so "web-app" wins over a stray "app"; whole-word/substring match.
  for (const a of ARCHETYPES) if (a !== "other" && (t.includes(a) || t.includes(a.replace("-", " ")))) return a;
  return "other";
}

/**
 * Steering appended to the decompose prompt for a WEB APP: author the stack the harness can
 * SCAFFOLD + GATE for a cheap executor, not a maximal full-stack architecture. Forces Node+Express
 * + a static UI + a JSON store + a SMALL plan, so the server-plumbing scaffold fires and the cheap
 * loop fills handlers / composes the UI instead of improvising a React+Flask+Playwright app.
 */
export const WEB_APP_STACK_RULE =
  "STACK CONSTRAINT (this is a WEB APP — author it as the harness can reliably SCAFFOLD and GATE for a CHEAP executor, NOT as a maximal architecture): build it as a SINGLE Node.js + Express service that serves a STATIC frontend (plain HTML/CSS/JS) from a `public/` directory and persists to a JSON file. NO database, NO Python/Flask, NO React/Vue/Svelte or any build-step SPA, NO separate frontend dev server. Keep the plan SMALL: ideally ONE service node — the Express server in `server.js`, verified by a LIVE HTTP serve-gate that curls its endpoints — plus AT MOST one static-UI node (files under `public/`, verified by the DOM gate). The server listens on process.env.PORT. Do NOT split the backend into many micro-modules (e.g. separate storage / logic / api nodes) — a small app is ONE service that owns its data. The harness will VENDOR the server boot/port/JSON-store plumbing and a `public/theme.css` design system; your nodes only fill the route handlers and compose the static UI against those.";

/**
 * Steering for the INFER-GATES stage on a web app: gate the HTTP server node by curling its LIVE
 * endpoints (a serve-gate the harness boots), NOT by importing the app (supertest / `require()` /
 * `node -e` on the module). The vendored skeleton self-LISTENS — it does not export an app — so an
 * import-based gate is incoherent (and the planner reliably writes brittle/invalid `node -e`
 * one-liners for it). A live curl gate is what the skeleton supports and what fires the scaffold.
 */
export const WEB_APP_GATE_RULE =
  "WEB APP — gate the HTTP SERVER node by CURLING ITS LIVE ENDPOINTS over http://localhost:3000 as a `freeform` gate (the harness boots the server with `npm start`, waits for the port, runs your curls, and tears it down). Example shape: `curl -fsS -X POST http://localhost:3000/api/<thing> -H 'content-type: application/json' -d '{...}' | grep -q <expected>` chained with `&&` across the endpoints the brief requires, asserting status/redirect/body. Do NOT use supertest, do NOT `require('./server.js')` or `node -e` importing the app, do NOT a project-wide e2e suite — the server SELF-LISTENS and is verified LIVE over HTTP on a fixed port (use 3000).";
