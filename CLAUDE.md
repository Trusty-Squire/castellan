# CLAUDE.md — Castellan (formerly Cheeky Squire) v0.1.x

> Rebranded 2026-06-12: product=Castellan, binary=`ser` (+`castellan` alias),
> SPEC-v0.2.md is the design authority for the v0.2 planning-layer build;
> npm package=`castellan`. SPEC.md retains the original v0.1 name and binary
> as the historical design authority; internal identifiers (.squire/,
> SquireError) unchanged for now.

## Thesis (north star — positioning and product decisions defer to this)
**Cheap and reliable makes loops.** Loops are the product. Cheap × reliable
is the multiplication that makes them possible: expensive×reliable rations
turns (you babysit); cheap×unreliable compounds garbage (you babysit
harder); cheap×reliable means iteration is nearly free and every pass
verifiably advances or honestly halts — you can let go of the crank.
Verification and cost are the two FACTORS, not the product. Incumbents sell
turns; a turn needs you. Castellan sells loops; a loop doesn't. North-star
metric: loop endurance — unattended iterations per human intervention —
alongside cost per verified iteration.

## Product strategy — v0.3 (recorded 2026-06-14; owner's strategic insights, for posterity across sessions. Design authority: SPEC-v0.3.md)

CENTERPIECE: **cheap model + reliable harness + opinionated product funnel → effective loops.** The three are ONE system; no single piece (the guardrails, the gates, the cheap loop) is "the point" — view them holistically. The funnel supplies the product instinct and tool knowledge the user lacks → that yields an efficient, objectively-gated spec → which lets a cheap+reliable loop reach a finished product with minimum human intervention.

WHAT IT IS: a tool that **raises the quality FLOOR of what the long tail builds**, by removing the need for product instinct + tool/eval-harness knowledge, cheaply and reliably. The hobby dev never has to learn what PMF or an eval harness *is* — Castellan is their instinct and their harness.

THE USER: the **long tail of hobby developers** (no product instinct, no eval-harness knowledge). NOT SV serial entrepreneurs / pros — they have instinct + want control and will use Claude Code/Cursor. Do not design for them.

THE BASELINE (we kept benchmarking the wrong opponent — don't): the normie doing **lossy gradient descent with an assistant** — supplying where-to-go (instinct) and how-to-get-there (tool knowledge) badly, over many costly cycles. NOT a vanilla one-shot, NOT frontier models, NOT experts. Value = the delta for THAT person.

THE METRIC: **churn-to-satisfaction at the final HUMAN gate** — minimize the non-expert's painful feedback cycles to reach a product they're satisfied with. The human IS the final gate by design; the pitch is NOT "autonomous teammate / no human" — it is "needs no expertise and far fewer cycles."

POSITIONING: floor-raiser / churn-reducer for non-experts. NOT "advisor that out-opinions Codex" (wrong axis), NOT "autonomous teammate."

SCOPE OF THE FLOOR: it supplies EXECUTION instinct (scoping, UX best-practice, safety, gateability) + tool knowledge. It does NOT supply VISION (what's worth building, for whom) — that stays the user's; garbage-vision-in → well-built-garbage-out (still a floor-raise on execution).

DECISIVE FALSIFICATION TEST (unproduced — build before more architecture): does a real non-expert reach a satisfying product in fewer/cheaper cycles WITH Castellan than WITH an assistant (Claude Code / Lovable)? Churn-to-satisfaction vs an assistant, real hobby devs.

ENGINE: built on **goose** (spiked + confirmed: recipes + `--sub-recipe` sweep + `--no-session` gated nodes + a custom MCP membrane; no Rust). Authoring = a premium, tool-using agent (a cheap model proved an incompetent advisor — it can't tell load-bearing from cosmetic); the cheap×reliable thesis is the BUILD loop only. The membrane (objective-gate enforcement) + honest-halt + reset are ours and are the defensible core. Funnel = idea → spec → polish → signoff → build → AUDIT (where dogfooding lives) → ship.

## What this is
A verification harness that lets cheap LLMs complete long
multi-step coding tasks reliably. v0.1 is an EXPERIMENT.
The deliverable is the benchmark table from
scripts/experiment.ts. SPEC.md is the design authority;
where SPEC.md and improvisation conflict, SPEC.md wins.
Where SPEC.md is silent, decide, record in ASSUMPTIONS.md,
proceed.

## Success contract — ALL must hold before declaring done
1. `pnpm test` — vitest, zero failures
2. `pnpm typecheck` — `tsc --noEmit`, zero errors
3. `pnpm lint` — eslint, zero errors
4. `node dist/cli.js run examples/demo.yaml --mock`
   — completes a 3-node mission end-to-end via MockEngine,
   exercising pack → run → reconcile → gate → checkpoint
   for real (real git ops in a temp dir), exit 0
4b. `node dist/cli.js run examples/demo.yaml --mock --harness off`
   — ablation (raw, goal-only): one attempt then scores every
   node's done_check, exit 0
5. `pnpm experiment --dry-run` — validates all 20 task
   fixtures + missions AND resolves the three-chain schema
   (cheap-raw, cheap, knight-only), prints the result table
   schema, exit 0
4c. Human-gate demo: vitest covers a tier-4 mission end-to-end
   (approve commits; rejection drives rung-2 with the reason in
   FAILURE CONTEXT; unattended throws) — test/harness/human-gate.test.ts
4d. `pnpm gate-attack --tasks 1..20` — hermetic null-solution attacks
   (vacuous-pass, guard-tamper): zero FAILs
5b. derive-v2 pipeline + ser spec + packs covered by hermetic MockLlm
   tests (poker refusal path included)
6. Zero network calls in tests. `OPENROUTER_API_KEY` must not
   be required for gates 1–5b.
7. LIVE gates (human-run, recorded in RESULTS.md when run):
   `pnpm derive-bench` (planner tax <=10pts), `pnpm poker-bench`
   (>=4/5 caught, <=1 spurious), cross-executor gauntlet.

## Architecture invariants (do not violate)
- ALL model calls behind `LlmClient`; MockLlm in tests.
- ALL agent execution behind `Engine` (src/engine/types.ts);
  harness code never imports pi-mono directly.
- Gates are shell commands judged by exit code. No prose
  evaluation anywhere in this codebase.
- Node pass = git commit. Node fail = git reset to last green
  checkpoint BEFORE the next attempt.
- Blast radius is enforced BEFORE write/edit execution,
  in the harness, not trusted to the engine or the model.
- A node's context = system prompt + brief + packed files.
  Never mission history. Never another node's transcript.
- Budget meters are hard stops, checked after every LLM call.

## Phase 0 obligation (pi-mono)
Before implementing src/engine/pi.ts: install and READ the
pi-mono packages (github.com/badlogic/pi-mono — verify the
actual org/repo and package names via npm; do not guess).
Write ENGINE_NOTES.md per SPEC §6.2. If embedding with tool
interception is not feasible, record evidence and implement
BuiltinEngine per SPEC §6.3 instead. Timebox: one focused
pass. Decide, record, proceed. Do not stall.

## Scope fence (building any of this is drift — stop)
- No full-screen/split-pane TUI yet (scheduled, desktop-focused). A
  colorized line-based REPL IS allowed (src/style.ts; TTY-gated, NO_COLOR
  honored) — approved by the owner 2026-06-13. Still no spinners.
- No `squire watch`, no init wizard, no persona features
- No Goose, no ACP, no MCP
- No model ranking, probes, bandit routing, or voting
- No real-API integration tests; the human runs the real
  experiment

## Behavior policy
- Never ask the human questions. Record assumptions in
  ASSUMPTIONS.md and proceed.
- Retry ladder per error: fix directly → re-read the
  surrounding module → re-read SPEC.md → after 3 failed
  attempts on the SAME error, stop and surface with the
  full error and what was tried.
- Conventional commits, one per module/milestone.
  Suggested order: schema → trace → gates → checkpoint →
  context → reconcile → budget → escalate → engine(mock) →
  runner → cli → demo → engine(pi or builtin) → derive →
  fixtures → experiment.
- Update STATE.md after each commit: done / in-progress /
  blocked / next.
- Tests accompany each module in the same commit, not at
  the end.

## Code standards
- tsconfig strict; no `any` except at validated boundaries
  (zod.parse the outside world, then types flow)
- zod schemas are the single source of truth for all file
  formats (mission.yaml, chains.yaml, engine scripts, trace)
- execa for all shell; never string-concatenate commands
- Errors: throw typed errors with context; the CLI catches
  at the top, prints one clear line + trace path, exits 1
