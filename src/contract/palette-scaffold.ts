/**
 * UI PALETTE SCAFFOLD — vendor a design-system stylesheet into a web app's `public/` so the cheap
 * model COMPOSES its UI against known style tokens instead of improvising CSS from scratch.
 *
 * We vendor the STYLE SYSTEM (general — tokens + base element styles, an Obsidian/Linear-flavoured
 * dark theme), NOT component HTML (product-specific). The model writes its own markup using the
 * tokens, so the palette generalises across web apps while still lifting the visual floor and making
 * the rendered surface consistent enough for the DOM gate. Greenfield-only; never clobbers a
 * theme.css a node already wrote.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** A compact, self-contained design system: CSS variables + base element styles, dark + modern. */
export const PALETTE_THEME_CSS = `:root {
  --bg: #0d0e10;
  --bg-elevated: #16181c;
  --bg-hover: #1e2024;
  --border: #26282e;
  --text: #e6e7e9;
  --text-secondary: #b4b6ba;
  --text-muted: #80838a;
  --accent: #5e6ad2;
  --accent-hover: #6f7ae0;
  --success: #4cb782;
  --danger: #eb5757;
  --radius: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { letter-spacing: -0.01em; font-weight: 600; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
input, select, textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 9px 12px;
  font: inherit;
  width: 100%;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
button, .btn-primary {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 9px 16px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
button:hover, .btn-primary:hover { background: var(--accent-hover); }
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.btn-ghost:hover { background: var(--bg-hover); color: var(--text); }
.muted { color: var(--text-muted); }
.danger { color: var(--danger); }
.pill {
  display: inline-block;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--text-secondary);
}
`;

/** Brief addendum telling a UI node to use the vendored design system. */
export function paletteNote(): string {
  return (
    "A design-system stylesheet is VENDORED at `public/theme.css` — `<link rel=\"stylesheet\" " +
    'href="/theme.css">` it from your HTML and style the UI with its CSS variables (--bg, --accent, ' +
    "--text, --radius, …) and helper classes (.card, .btn-primary, .btn-ghost, .pill, .muted). " +
    "Build the UI as STATIC HTML/CSS/JS under `public/` (no build step). Do NOT rewrite theme.css."
  );
}

/** Seed public/theme.css into a greenfield workdir. No-op if it already exists. Returns true if seeded. */
export function vendorPalette(workdir: string): boolean {
  const dir = join(workdir, "public");
  const file = join(dir, "theme.css");
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, PALETTE_THEME_CSS);
  return true;
}
