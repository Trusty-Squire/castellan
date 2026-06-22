# Design Reference — "Obsidian × Linear" dark-first tool aesthetic

A concrete, implementable spec for a small web component library that reads like
**Linear** (issue tracker) and **Obsidian** (notes app). Both are dark-first,
calm, dense-but-readable "professional tool" UIs: low-chroma surfaces, one
saturated accent, hairline borders over heavy shadows, crisp Inter typography,
and a tight 4/8px spacing rhythm.

Companion file: `theme.css` distills every token below into drop-in CSS custom
properties + minimal base styles.

## Sources & confidence

- **Obsidian** values are EXACT — pulled from the official Developer Docs CSS
  variable foundations (publicly documented defaults):
  - Colors / base scale: https://docs.obsidian.md/Reference/CSS+variables/Foundations/Colors
  - Spacing (4px grid): https://docs.obsidian.md/Reference/CSS+variables/Foundations/Spacing
  - Typography: https://docs.obsidian.md/Reference/CSS+variables/Foundations/Typography
  - Radiuses: https://docs.obsidian.md/Reference/CSS+variables/Foundations/Radiuses
  - Obsidian's accent is defined as **HSL(254, 80%, 68%)** (a violet ≈ `#7C6CF5`),
    not a fixed hex — themeable by the user. `--color-red` `#fb464c`,
    `--color-green` `#44cf6e` (dark) are exact.
- **Linear** signature tokens are corroborated from a live-DOM extraction
  (Copycats: bg `#08090A`, fg `#F7F8F8`, muted `#62666D`) plus Linear's brand /
  redesign writeups and Mobbin's brand palette:
  - https://copycats.design/linear-app  •  https://mobbin.com/colors/brand/linear
  - https://linear.app/brand  •  https://linear.app/now/how-we-redesigned-the-linear-ui
  - Linear generates themes in **LCH** from just three inputs (base, accent,
    contrast). The famous brand accent indigo is **`#5E6AD2`** (widely cited /
    brand). `#8FA6FF` seen in the DOM is the lighter link/hover variant.
  - Type: **Inter Variable** (UI) + **Berkeley Mono** (code). Tight spacing,
    small radii (~6–8px).
- Where a value is a reasonable interpolation rather than a documented constant
  (e.g. Linear's elevated-surface and border steps, which LCH-generates per
  theme), it is marked **(approx)**.

---

## 1. Principles

- **Dark-first.** The primary theme is a near-black canvas (Linear `#08090A`,
  Obsidian `#1E1E1E`). Light theme exists but is the secondary target.
- **Low-chroma surfaces, one saturated accent.** Backgrounds, text and borders
  are desaturated grays; the ONLY vivid color is a single indigo/violet accent
  used for focus, primary actions, links and selection. Restraint is the look.
- **Hairline borders over shadows.** Depth comes from 1px borders and small
  steps in surface lightness ("elevation"), not big drop-shadows. Shadows, when
  used, are barely-there.
- **Crisp, dense typography.** Inter for UI, a real monospace for code. 13–15px
  UI text, generous `line-height: 1.5` for reading, `1.3` tight for dense rows.
  Slight NEGATIVE letter-spacing on headings.
- **4/8px spacing rhythm.** Everything snaps to a 4px grid (Obsidian's
  `--size-4-*`); 2px fine-grain only when needed.
- **Small radii, fast & quiet.** 4–8px corners, no flourish, instant hover/focus
  transitions (~80–120ms). The UI should feel like a precise instrument.

---

## 2. Color

### Dark theme (primary)

| Role | Linear | Obsidian | Library token (`theme.css`) |
|---|---|---|---|
| **bg / base** (canvas) | `#08090A` | `#1E1E1E` (`base-00`) | `--bg: #0d0e10` |
| **bg-elevated** (panel/card) | `#101113` (approx) | `#262626` (`base-20`) | `--bg-elevated: #16181c` |
| **bg-overlay** (menu/modal) | `#1C1D20` (approx) | `#2A2A2A` (`base-25`) | `--bg-overlay: #1c1e22` |
| **bg-hover** (row/input hover) | `#16171a` (approx) | `#363636` (`base-30`) | `--bg-hover: #1f2227` |
| **text** (primary) | `#F7F8F8` | `#DADADA` (`base-100`) | `--text: #f2f3f5` |
| **text-secondary** | `#D0D6E0` (approx) | `#BABABA` (`base-70`) | `--text-secondary: #c2c6cc` |
| **text-muted** | `#62666D` | `#999999` (`base-60`) | `--text-muted: #8a8f98` |
| **border** (hairline) | `#23252A` (approx) | `#363636` (`base-30`) | `--border: #26282d` |
| **border-strong** (focused field) | `#3A3D44` (approx) | `#555555` (`base-40`) | `--border-strong: #3a3d44` |
| **accent** | `#5E6AD2` (indigo) | `#7C6CF5` (HSL 254/80/68) | `--accent: #5e6ad2` |
| **accent-hover** | `#6E79DE` (approx) | — | `--accent-hover: #6e79de` |
| **accent-fg** (text on accent) | `#FFFFFF` | `#FFFFFF` | `--accent-fg: #ffffff` |
| **accent-subtle** (selection bg) | `rgba(94,106,210,.18)` | — | `--accent-subtle: rgba(94,106,210,.18)` |
| **success** | `#4CB782` (approx) | `#44CF6E` | `--success: #4cb782` |
| **danger** | `#EB5757` (approx) | `#FB464C` | `--danger: #eb5757` |

> The library tokens sit deliberately between the two: Linear's exact near-black
> canvas (`#08090A`) tinted a hair lighter to `#0d0e10` so 1px borders read,
> Linear's `#F7F8F8`/`#62666D` text relationship, and Linear's brand `#5E6AD2`
> accent. Each surface step is ~+3–6 in lightness — the "elevation by lightness"
> trick both apps use.

### Light theme (secondary)

| Role | Value | Notes |
|---|---|---|
| `--bg` | `#FFFFFF` | Obsidian `base-00` light = `#FFFFFF`; Linear light bg `#FFFFFF` |
| `--bg-elevated` | `#F9F9FB` | Obsidian `base-05/10` ≈ `#FCFCFC`/`#FAFAFA` |
| `--bg-overlay` | `#FFFFFF` | with border + soft shadow |
| `--bg-hover` | `#F1F2F4` | Obsidian `base-20` `#F6F6F6` |
| `--text` | `#1A1B1E` | Obsidian `base-100` light `#222222` |
| `--text-secondary` | `#44494D` | Linear light secondary (`#44494D` per brand themes) |
| `--text-muted` | `#6B7077` | Obsidian `base-50/60` ≈ `#ABABAB`/`#707070` |
| `--border` | `#E5E5E6` | Linear light border (extracted) |
| `--border-strong` | `#D0D2D6` | |
| `--accent` | `#5E6AD2` | same indigo, holds on light |
| `--accent-hover` | `#4E5ACb` | |
| `--success` | `#3FA46A` | |
| `--danger` | `#D93C3C` | |

---

## 3. Typography

**Font stacks**

```
--font-sans: "Inter var", "Inter", -apple-system, BlinkMacSystemFont,
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: "Berkeley Mono", "JetBrains Mono", ui-monospace,
             SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

Linear uses **Inter Variable + Berkeley Mono**. Obsidian defaults to the system
UI font but the Inter/system stack matches the shared aesthetic.

**Type scale** (sizes from Obsidian's documented UI scale 12/13/15/20 + a 16px
reading body + 24/30 display steps; weights/line-heights below):

| Token | Size | Weight | Line-height | Letter-spacing | Use |
|---|---|---|---|---|---|
| `--text-h1` | 30px | 600 | 1.25 | -0.02em | page title |
| `--text-h2` | 24px | 600 | 1.3 | -0.018em | section |
| `--text-h3` | 20px | 600 | 1.3 | -0.014em | subsection (Obsidian `ui-large`) |
| `--text-body` | 15px | 400 | 1.5 | -0.006em | UI body (Obsidian `ui-medium`) |
| `--text-reading` | 16px | 400 | 1.5 | normal | long-form note text (`font-text-size`) |
| `--text-small` | 13px | 400 | 1.4 | normal | labels, meta (Obsidian `ui-small`) |
| `--text-xs` | 12px | 500 | 1.35 | 0.01em | badges, captions (`ui-smaller`) |
| `--text-mono` | 13px | 400 | 1.5 | normal | code |

**Weights** (Obsidian's documented ladder): normal `400`, medium `500`,
semibold `600`, bold `700`. Headings are `600` (semibold), not `700` — both apps
favor semibold + tight tracking over heavy bold. Body is `400`.

---

## 4. Spacing & radius

**Spacing scale** — Obsidian's 4px grid (`--size-4-*`), 2px fine-grain sparingly:

| Token | px | Obsidian source |
|---|---|---|
| `--space-0` | 2px | `size-2-1` |
| `--space-1` | 4px | `size-4-1` |
| `--space-2` | 8px | `size-4-2` |
| `--space-3` | 12px | `size-4-3` |
| `--space-4` | 16px | `size-4-4` |
| `--space-6` | 24px | `size-4-6` |
| `--space-8` | 32px | `size-4-8` |
| `--space-12` | 48px | `size-4-12` |
| `--space-16` | 64px | `size-4-16` |

**Border radius** — Obsidian's documented ladder; Linear lives at the small end
(buttons/inputs ~6–8px):

| Token | px | source |
|---|---|---|
| `--radius-s` | 4px | Obsidian `radius-s` |
| `--radius-m` | 6px | Linear button/input (small radii) |
| `--radius-l` | 8px | Obsidian `radius-m` — cards/panels |
| `--radius-xl` | 12px | Obsidian `radius-l` — modals |
| `--radius-full` | 9999px | pills/avatars |

**Border widths** — `--border-width: 1px` is the workhorse (hairline). Focus
rings use a 2px accent outline + offset; no element needs >1px borders.

---

## 5. Elevation

Both apps build depth with **surface lightness + a 1px border**, NOT drop
shadows. The ladder: `--bg` (canvas) → `--bg-elevated` (card/panel, +1 border) →
`--bg-overlay` (menu/modal). Each step is a few points lighter.

Shadows are reserved for genuinely floating layers (menus, modals, tooltips) and
stay subtle:

```
--shadow-sm: 0 1px 2px rgba(0,0,0,.24);
--shadow-md: 0 4px 12px rgba(0,0,0,.32);          /* dropdowns */
--shadow-lg: 0 8px 32px rgba(0,0,0,.40);          /* modals */
```

In **light** theme, shadows do more work (borders are subtler): same offsets at
~`.06–.16` opacity. A panel on dark = `bg-elevated` + 1px `border`, no shadow.

---

## 6. Components

Padding/spacing reference the scale above. Transitions: `120ms ease` on
background/border/color; never animate layout.

### Button

- **Height** 32px, **padding** 0 `--space-3` (12px), **radius** `--radius-m`
  (6px), **font** `--text-small`/13px **weight 500**, `--border-width` border.
- **Primary**: `background: --accent`, `color: --accent-fg`, no border.
  Hover → `--accent-hover`. Active → slightly darker.
- **Secondary / default**: `background: --bg-elevated`, `color: --text`,
  `border: 1px --border`. Hover → `background: --bg-hover`,
  `border-color: --border-strong`.
- **Ghost**: transparent, `color: --text-secondary`; hover → `--bg-hover`.
- **Focus** (all): remove default outline, apply the shared focus ring (below).
- **Disabled**: `opacity: .5`, `cursor: not-allowed`.

### Text input

- **Height** 32px, **padding** 0 `--space-3`, **radius** `--radius-m` (6px),
  `background: --bg` (sits darker than its panel), `border: 1px --border`,
  `color: --text`, `font: --text-body`.
- **Placeholder**: `--text-muted`.
- **Hover**: `border-color: --border-strong`.
- **Focus**: `border-color: --accent` + the accent focus ring; no glow.

### Card / Panel

- `background: --bg-elevated`, `border: 1px --border`, `radius: --radius-l`
  (8px), `padding: --space-4` (16px). No shadow on dark (border carries it);
  on light, optional `--shadow-sm`.
- Panel header: `--text-small` `--text-muted`, uppercase optional with
  `letter-spacing: .04em`. Internal dividers use `--border`.

### List / Row

The signature Linear/Obsidian element: a tight, dense, full-bleed row.

- `.list` is a flush container (the card's border frames it); rows separated by
  1px `--border` between (`border-bottom`, last row none).
- `.row`: `padding: --space-2 --space-3` (8/12px), `min-height: 36px`, flex,
  `gap: --space-2`, `font: --text-small`/13px, `color: --text-secondary`.
- **Hover**: `background: --bg-hover` (whole row), `color: --text`,
  `cursor: pointer`; instant feel.
- **Selected**: `background: --accent-subtle`, optional 2px `--accent` left
  border (inset) as the active marker.
- **Focus** (keyboard nav): focus ring inset, or `--accent-subtle` + ring.

### Focus ring (shared, accessible)

A crisp, always-visible accent ring — the one place the accent shows on
interaction:

```
--ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
/* applied via box-shadow on :focus-visible, with outline:none */
```

The inner `--bg` ring creates a 2px gap so the accent ring reads cleanly against
any surface. Inputs additionally turn `border-color: --accent`. Always use
`:focus-visible` so the ring shows for keyboard, not mouse.

---

## Accessibility notes

- Dark `--text #f2f3f5` on `--bg #0d0e10` ≈ 15:1 contrast (AAA). `--text-muted
  #8a8f98` on `--bg` ≈ 5.3:1 (AA for normal text). `--accent-fg #fff` on
  `--accent #5e6ad2` ≈ 4.6:1 (AA).
- Focus is conveyed by a 2px accent ring (not color alone) and is always
  visible via `:focus-visible`.
- Light theme keeps the same accent; muted text darkened to `#6B7077` to hold AA
  on white.
