# Castellan

## Cheap and reliable makes loops.

That's the whole thesis. Cheap × reliable is the multiplication that makes
loops possible:

| | what happens to a loop |
|---|---|
| **expensive × reliable** (frontier models) | each iteration costs real money — you ration turns, so you babysit |
| **cheap × unreliable** (raw cheap models, leaky harnesses) | each iteration compounds garbage — loops diverge, so you babysit harder |
| **cheap × reliable** (gated) | iteration is nearly free and every pass verifiably advances or honestly halts — **you can let go of the crank** |

**Loops are the product.** Verification makes cheap models reliable; cheap
models make iteration affordable; together they make loops you can walk away
from — overnight runs, retry ladders, adversarial review swarms, benchmark
sweeps. Incumbent coding agents sell *turns*, and a turn needs you sitting
there. Castellan sells *loops*, and a loop doesn't.

> You bring the inspiration. Your castellan handles the rest — and proves it.

1. **Loop-native** — specs compile to gated loops; git is the memory, tests are the judge
2. **Reliable** — verified execution, receipts attached; the model never grades its own homework
3. **Cheap, open, no lock-in** — frontier results at ~1/20th cost, any model, escalation across vendors only on verified failure

*(Formerly "Cheeky Squire" — the v0.1 experiment name survives in SPEC.md and
internal identifiers. Binary: `ser`.)*

**The mechanism (and the measured claim):** cheap models (Qwen / DeepSeek class)
fail long, multi-step coding tasks not because they can't write the code, but
because of four scaffold-fixable failure modes — context rot, silent failure,
error compounding, and format fragility. Castellan gives each task-node a
*fresh minimal context*, verifies every node with an *objective gate* (a shell
command judged by exit code — never prose), *checkpoints* progress as git
commits, and *escalates* to a frontier model only after verified failure.
Measured: the same cheap model goes **35% → 100%** completion with the harness
(ablation), and matches Opus **20/20** at ~1/25th the cost — see RESULTS.md.

v0.1 is an **experiment**, not a product. The deliverable is the benchmark table
from `pnpm experiment`: for each task × chain it reports completion, escalations
by rung, confabulation flags, retries, wall-clock, and dollars — cheap chain vs
frontier-only chain on the *same* tasks. The harness, not a planner, is what's
being measured, so the ten benchmark tasks ship as hand-written missions with
ungameable gates (test files sit outside each node's blast radius, with
`git diff` guards as backup, so a node can't pass by deleting its own test).

Every model call sits behind an `LlmClient`; every agent run behind an `Engine`
(the real one, `PiEngine`, embeds [`@earendil-works/pi-agent-core`] and intercepts
each tool call against the node's blast radius *before* it touches disk). Tests are
fully hermetic: zero network calls, and `OPENROUTER_API_KEY` is never required to
build, typecheck, lint, run the mock demo, or dry-run the experiment. The real
benchmark — the one that needs an API key and real models — is run by you.

[`@earendil-works/pi-agent-core`]: https://github.com/earendil-works/pi

## How it works (the node lifecycle)

```
PENDING → PACKED → RUNNING → RECONCILING → GATING
                                              ├─ pass → COMMITTED   (git commit "node(<id>): pass")
                                              └─ fail → RESET       (git reset --hard last-green)
                                                         ├─ attempts < ladder → RUNNING (next rung)
                                                         └─ ladder exhausted → MISSION_HALTED
```

Each node gets only its brief + the files matched by `context_globs` — never
mission history or another node's transcript. Writes are checked against
`blast_radius` before execution. Reconcile (deterministic, no LLM) confirms every
claimed write shows up in the diff, nothing changed outside the radius, and flags
*confabulation* when the model claims a check ran with no matching command. The
gate is the node's `done_check`, judged purely by exit code. A pass commits; a
fail resets and climbs the escalation ladder: executor → executor+failure-context
→ fallback → knight (frontier). Budgets are hard stops, checked after every call.

## Install

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm build        # compiles src → dist (needed for the `ser` binary)
pnpm test         # 74 tests, hermetic, no network
```

## The commands that matter

Castellan's public CLI is intentionally small:

```bash
ser start "Build a secure API key vault with Slack support"
ser status
ser continue
ser review "Build a secure API key vault with Slack support"
ser ship "Build a secure API key vault with Slack support"
ser stop
```

`ser start` begins a verified delegation session. With no argument it opens the
interactive TUI; with a goal or `--spec <file>` it runs the product funnel
non-interactively. `ser continue` resumes the last interactive session.
`ser review` runs through build audit and stops before shipping. `ser ship`
verifies the gates are green and hands over the finished build. `ser status`
summarizes the latest run at the product level.

Common options:

```bash
ser start "..." --yes --workdir ./app --chain cheap
ser start --spec spec.yaml --to build
ser ship "..." --mock
```

The older low-level verbs still exist for internal harness work and CI, but they
are advanced commands now:

```bash
ser dev run examples/demo.yaml --mock
ser dev validate examples/demo.yaml
ser dev trace .squire/trace-example.jsonl
ser dev experiment --dry-run
```

Legacy aliases such as `ser run`, `ser derive`, `ser validate`, and `ser trace`
remain available during the transition.

### `pnpm experiment` — the benchmark (the whole point)

```bash
pnpm experiment --dry-run                      # validate all 20 fixtures + 3-chain schema (no API key)
pnpm experiment --mock                         # self-run tasks x {cheap,knight-only} offline (proves the suite)
pnpm experiment --tasks 1..20                  # the real run, full matrix (needs OPENROUTER_API_KEY)
```

20 tasks (01–10 graded, 11–20 designed to hurt) × three chains
(`cheap-raw`, `cheap`, `knight-only`) each run in a fresh fixture copy under a
temp git repo. Output is a printed table, `results/experiment-<ts>.csv` (with the
per-run trace archive under `results/<runId>/`), and a verdict that **leads with
the ablation delta** and reports cost per *completed* mission:

```
                       cheap-raw       cheap          knight-only
                       (harness OFF)   (cheap+harness) (frontier)
missions completed     ___ / 20        ___ / 20       ___ / 20
nodes completed        ___ %           ___ %          ___ %
recovered by ladder    n/a             ___            n/a
cost / completed       $___            $___           $___
```
(placeholder — fill from your live run; the harness lift is `cheap` minus `cheap-raw`.)

`ser dev run examples/demo.yaml --harness off` runs the same ablation on one
mission. `ser derive "<goal>"` is a convenience planner; the benchmark uses
hand-written missions. `pnpm calibrate --tasks 11..20 --chain cheap` (live,
human-run) reports per-task node completion and flags any task ≥90% complete as
needing hardening.

### Ablation methodology

The thesis is that the *harness*, not the model, closes the gap — so the
experiment compares three chains on identical tasks. **`cheap-raw`** is the
control: the same cheap model with the harness OFF — one raw attempt given only
the mission goal and a repo file listing (no node briefs, since decomposition is
itself part of the harness under test), the four tools, and the global budget
cap; no fresh-context nodes, no per-node gates mid-run, no checkpoints, no
blast-radius, no escalation. When it stops, every node's `done_check` is scored.
**`cheap`** is that same model *with* the scaffolding. **`knight-only`** is a
frontier model with the harness. The number that matters is `cheap − cheap-raw`:
how many more nodes/missions the cheap model completes purely from the harness,
and at what cost per completed mission versus the frontier baseline. Tasks 11–20
are built to separate the chains (long-horizon convention drift, poisoned
dependencies caught early, migrations across many call sites), with anti-gaming
guards (varied-input gates, fail-against-stub, mutation guards, compile/perf
gates) so a node can't be passed vacuously — see `AUDIT.md`.

## Pinning real model slugs

`chains.yaml` is **user-maintained config, not code.** It ships with placeholder
slugs and prices; pin real OpenRouter slugs and per-million-token prices before a
real run:

```yaml
chains:
  cheap:
    executor: "qwen/qwen3-coder"        # ← replace with the real slug you want
    fallback: "deepseek/deepseek-chat"  # ← second cheap model
    knight:   "anthropic/claude-opus-4" # ← frontier escalation target
  knight-only:
    executor: "anthropic/claude-opus-4"
    fallback: "anthropic/claude-opus-4"
    knight:   "anthropic/claude-opus-4"
prices:   # per MILLION tokens — drives budget.ts and the cost column
  "qwen/qwen3-coder":        { in: 0.20, out: 0.80 }
  "deepseek/deepseek-chat":  { in: 0.14, out: 0.28 }
  "anthropic/claude-opus-4": { in: 15.0, out: 75.0 }
```

The harness never invents a price: a slug missing from `prices` simply costs $0 in
the meter. Set `OPENROUTER_API_KEY` in your environment for real runs
(`OPENROUTER_BASE_URL` optional). The `cheap` vs `knight-only` chains are what the
verdict compares.

## Layout

`src/contract` (zod schemas + derive) · `src/engine` (Engine interface, PiEngine,
MockEngine, the ToolExecutor that owns every write) · `src/harness` (runner,
context pack, gates, checkpoint, reconcile, budget, escalate, trace) ·
`src/llm` (LlmClient + OpenRouter) · `tasks/01..10` (the benchmark) ·
`scripts/experiment.ts` (the table). See `SPEC.md` for the design authority,
`ENGINE_NOTES.md` for the pi-mono audit, and `ASSUMPTIONS.md` for decisions made
where the spec was silent.
