# ASSUMPTIONS.md

Decisions made where SPEC.md is silent. SPEC.md wins on conflict.

## Engine / pi-mono
- A1. The maintained pi packages are `@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core` (the `@mariozechner/*` ones are
  deprecated). We depend on the `@earendil-works` scope. Evidence in
  ENGINE_NOTES.md.
- A2. PiEngine is implemented (Phase 0 decision = feasible). BuiltinEngine
  is NOT built (SPEC §6.3 is a contingency that did not trigger).
- A3. Blast-radius enforcement and all real tool execution live in one
  harness `ToolExecutor`, shared by MockEngine and PiEngine. PiEngine
  also wires pi's `beforeToolCall` block hook so denial happens before
  execution and the run continues with an injected error result.

## Transport / cost
- A4. LLM transport for both the engine and the planner goes through
  OpenRouter via pi-ai's `openai-completions` API (`baseUrl`
  `https://openrouter.ai/api/v1`, key from `OPENROUTER_API_KEY`). Our
  own `LlmClient`/`Engine` interfaces sit above it (SPEC §2, §7).
- A5. Cost in USD is computed by the harness from `chains.yaml` prices
  (per-million in/out), NOT from pi's reported `cost`, because SPEC
  mandates prices be user-maintained config. Cache tokens are billed at
  the input price (v0.1 simplification; pricing table has no cache rate).
- A6. Token estimation for context-pack truncation uses a chars/4
  heuristic (no tokenizer dependency; deterministic, offline). Recorded
  in trace as an estimate.

## Schema / files
- A7. `mission.yaml` and `chains.yaml` are YAML, parsed then
  zod-validated. Engine scripts (MockEngine) and the trace are JSON/JSONL.
- A8. Node ids are unique within a mission; `deps` form a DAG (cycles
  rejected at validation). Execution order is a deterministic topological
  sort (stable by declaration order).
- A9. `workdir` in mission.yaml is resolved relative to the mission file's
  directory. `context_globs`/`blast_radius` are relative to `workdir`.
- A10. A node with no `deps` is a root. Multiple roots allowed. The
  mission completes when all nodes are COMMITTED; it halts on the first
  node that exhausts the ladder (SPEC §5 state machine).

## Git / checkpoint
- A11. The harness operates on a real git repo at `workdir`. The first
  checkpoint ("last green") is the repo HEAD at mission start; each node
  pass commits `node(<id>): pass`. Reset is `git reset --hard <last-green>`
  followed by `git clean -fd` to drop untracked files from a failed
  attempt.
- A12. `setup-fixtures.ts` writes fixture files but does NOT git-init them;
  the experiment harness copies a fixture to a temp dir and runs
  `git init && git add -A && git commit` there (SPEC §12), keeping the
  source tree clean and tests hermetic.

## Reconcile / gates
- A13. Reconcile "writes appear in git diff": every write/edit the engine
  executed must touch a path that shows in `git status --porcelain`
  (staged or unstaged). A write whose content equals existing content
  (no-op) is allowed and not flagged.
- A14. Confabulation detection: if the engine's final message matches a
  test/lint/build claim regex AND no bash tool call running a
  test/lint/build-like command (or the exact done_check) exists in the
  attempt trace, set `confabulation_flag`. It is counted, never fails the
  node (the gate decides) — SPEC §5.5.
- A15. Gate timeout is 5 minutes (SPEC §5.6); stdout/stderr tails capped
  at 4KB each.

## Derive
- A16. `squire derive` uses the chain's `knight` model via `LlmClient`.
  Repo survey = `git ls-files` + README/package.json/Cargo.toml contents
  + detected check commands. Schema-validate; one retry with errors
  appended; second failure exits 1. `{"error": "..."}` from the model
  exits 1 with that message. `--yes` skips the proceed prompt.

## Benchmark fixtures
- A18. Fixture gates use Node's built-in test runner (`node --test`) and
  `node -e`/`node --check`, NOT vitest. This keeps every fixture dependency-free
  and hermetic: the experiment copies a fixture into a temp dir and runs it with
  no `npm install` and no network. SPEC §11 says "real vitest suites"; node:test
  is an equivalent objective gate that satisfies the no-network/no-install
  constraint. Fixtures are committed CommonJS `.js` files.
- A19. Ungameable gates: nodes that must not touch their own checks have the
  test file OUTSIDE their blast_radius, plus a `git diff --quiet HEAD -- <test>`
  guard as defense-in-depth (and `node --check`/`grep` guards for test-writing
  nodes). Verified: a cheating agent that rewrites a test is blast-denied and the
  node still fails (test/experiment/experiment.test.ts).
- A20. The experiment supports `--mock` (MockEngine + per-node engine-scripts in
  each task's engine-scripts/) for offline, network-free self-verification of the
  whole benchmark. The real measurement (`pnpm experiment` with a real chain) is
  run by the human with OPENROUTER_API_KEY (SPEC §12). `--dry-run` validates all
  fixtures+missions and prints the table schema (gate 5).

## Anti-gaming (v0.1.1)
- A21. Three reusable gate primitives keep done_checks ungameable:
  (1) behavior gates assert ≥2 varied input/output pairs so a constant or
  small-branch hardcode fails; (2) tests-first nodes require the suite to FAIL
  against the stub (`! node --test …`) so a vacuous test can't let a later node
  ship a stub; (3) write-test-after-impl nodes use `fixture/checks/mutation-guard.sh`
  — the new test must pass against the real module and FAIL against a planted
  mutant in `fixture/checks/<mod>.mutant.js`. Mutants and the guard live in
  `checks/` (outside every blast_radius) so no node can tamper with them.
- A22. experiment.ts archives each run's trace to
  `results/<runId>/<task>-<chain>.jsonl` before the temp workdir is reaped
  (results/ is gitignored; archiving is the audit trail).

## v0.2 build decisions
- A23. Raw-mode (harness off) scoring treats human gates as not-passed with a
  note: unattended scoring cannot adjudicate. Judge gates score soft.
- A24. `ser do` quick mode defaults to an OPEN blast radius ("**") — single
  supervised goal with the user present; tighten with --radius. Gate is
  inferred mechanically from repo check commands; no detectable gate = refusal
  (never an ungated node).
- A25. `ser fix` repro gates demand an assertion-failure signature
  (AssertionError|expected|FAIL) and reject ENOENT — the dogfood
  poisoned-fixture lesson applied to bug repros.
- A26. Spec drift flags are proposer-marked only in v0.2; a mechanical
  NLI-style thesis-contradiction check is v0.3.
- A27. v0.2's working definition of a "verified" ledger claim is
  adversarial-survival: it survived the feasibility-arithmetic and prior-art
  refutation lenses, with the lens trail recorded as evidence. No live web
  retrieval ships in v0.2 core; lenses run on model knowledge + arithmetic
  (sufficient for the poker class; insufficient for fast-moving facts — known
  limitation).

- A28. The unified interface (`ser talk`) routes through the EXISTING
  delta-mapper call — one new `action` field (check|verify|derive|run|status),
  not a second router model. The mapper may only REQUEST a command; the
  harness executes it mechanically and prints its own report (gate verdicts,
  costs, commits) — the model never performs work and never reports results.
  `run` re-derives when the spec is newer than the compiled mission (mtime)
  and requires one y/N spend confirmation; unconfirmed or non-TTY = cancelled.
  The mission compiles to `<name>.mission.yaml` next to the spec. Dogfood
  origin: "build it, report when done" — the sentence should work, mechanically.

## CLI
- A34. Pipeline (idea→brief) — `ser idea "<p>"` runs the IDEA phase
  (src/contract/ingest.ts): stories → components → decisions bucketed by the
  3-test (bucketOf, code-owned). `ser plan "<p>" [out.spec.yaml]` adds the
  DECISION BRIEF (src/contract/brief.ts): resolveBrief presents bucket-1 ASKs
  (applyChoice: enter=accept, a/b/c=pick, s=skip, else=type) and AUTO-ACCEPTS
  bucket-2 defaults but PRINTS them so a mis-bucket is catchable — the brief is
  the backstop for imperfect auto-bucketing (the boundary is judgment-laden;
  the human arbitrates). ideaToSpec compiles stories + components (→
  requirements, gates normalized) + resolutions (→ decisions) into a ready
  spec; stories are a first-class optional SpecSchema field. The driver takes
  an injected BriefIO (hermetically testable). readChunk resolves empty on
  sticky stdin EOF so piped/non-interactive briefs never deadlock.
- A33. Autonomous spec authoring (src/contract/autofill.ts): when the user
  insists on building below the readiness score ("build it anyway" → mapper
  emits action=run, action_arg="auto"), ser stops asking and closes the gaps
  itself — each round it diagnoses, generates deltas that fill what it can,
  applies (via normalizeDeltas + applyDeltasLenient), and re-scores, until
  build-ready or no progress (maxRounds 6; stop after 2 gainless rounds or a
  round that produces/lands nothing). Genuine forks (needsUser) are filled
  with a sensible DEFAULT recorded as a "ser default:" decision the user sees
  and can undo; the spend confirmation is the human checkpoint. If autofill
  cannot reach ready, the remaining needsUser decisions are surfaced and the
  build stops. Without "auto", run still surfaces the gaps (A32).
- A32. Spec READINESS is structural gate coverage, NOT a score threshold
  (src/contract/spec-score.ts). A spec is buildable when every requirement has
  an eval gate (tier >=1), no decision rests on a REFUTED claim, and no open
  question is blocking — i.e. ZERO blocking gaps. That is the only readiness
  bar (gates judge at run time; the spec needn't be perfect, only verifiable).
  The polish SCORE (0-100, weights blocking 40 / major 15 / minor 5) is a
  secondary display signal; the LLM diagnostician's major/minor suggestions
  (decomposition, gate strength, missing capabilities, unverified claims)
  lower polish but NEVER block readiness — the model advises, only the
  mechanical floor blocks (clamped in code; honors "model never grades its own
  homework"). Rationale (user, 2026-06-13): "shouldn't the spec be complete if
  there are eval gates to every component?" — yes; LLM perfectionism never
  converges, gate coverage does. `ser talk` run surfaces blockers (or autofills
  on "build it anyway"); `ser spec score <file>` is the standalone readout.
- A30. ser runs anywhere with no config: chains resolve via one
  resolveChains() — explicit --chains, cwd, workdir, global
  ~/.config/castellan/chains.yaml, then BUILT-IN defaults (src/contract/
  default-chains.ts, same pinned slugs/prices as the repo chains.yaml).
  Only a missing explicit --chains path errors. `ser talk` prints a banner
  when defaults are in play.
- A31. A talk-run ALWAYS sandboxes (forces --sandbox): the spec dir is a
  thinking space, often nested in a larger repo, and the harness does
  `git reset --hard` on failed nodes — it must never mutate the user's
  working tree. The mission executes in an isolated temp copy; the printed
  workdir is where artifacts land. (Direct `ser run` is unchanged: in-place
  for a clean repo, sandbox only when not a repo or --sandbox given.)
- A29. The API key lives in ONE place: `~/.config/castellan/.env`
  (override via $CASTELLAN_HOME or $XDG_CONFIG_HOME). `ser login` writes it
  there (mode 600), preferring a key already in the environment so a scattered
  project `.env.local` can be consolidated in one command. Env loading reads a
  FIXED set — `<cwd>/.env.local`, `<cwd>/.env`, then the global file — and
  NEVER walks up the directory tree (the old walk-up made the effective key
  depend on cwd and on stray ancestor `.env` files; that footgun is gone). The
  real process environment always wins over every file.
- A35. Credential-free runtime uses a Trusty Squire EGRESS GRANT, not the
  local proxy TODOS #1 originally sketched. `grant_app_access` (service
  "Openrouter.ai") mints `{base_url, token}`; the vault injects the real
  OpenRouter key host-side and enforces allowed-hosts, so ser holds only a
  leashed/revocable/metered token. Wiring (in `~/.config/castellan/.env`,
  the A29 single home): `OPENROUTER_API_KEY=<grant token>` (real key removed)
  and `OPENROUTER_BASE_URL=<grant base_url>/api/v1`. The `/api/v1` suffix is
  REQUIRED and non-obvious: the egress proxy forwards the path after the grant
  id verbatim to `openrouter.ai`, so the base must mirror the
  `openrouter.ai/api/v1` shape for ser's `${baseUrl}/chat/completions` to land
  on the real API (omitting it hits the marketing host → a large HTML page the
  proxy rejects with `response_too_large`/502). Use `https://` even though the
  grant returns `http://` — the token is a bearer secret. ser needs NO code
  change. Grants default to UNLIMITED (no rate/spend caps) unless args are
  passed; minted via the MCP server in `@trusty-squire/mcp@0.9.15` (0.9.14 was
  a broken publish). Verified end-to-end 2026-06-13: `ser idea` returns real
  output, key never crossed to ser. Spend is metered server-side per grant_id
  (vault UI); ser still reports cost via the A5 price table (proxy-spend-header
  surfacing is the one open TODOS #1 item). Known dependency: the proxy must
  pass `Content-Encoding` through transparently — an earlier proxy build
  UTF-8-decoded gzip bodies and re-gzipped them, corrupting responses
  (fixed upstream before this was declared done).
- A36. Real reported spend, not just price-table estimation. The egress proxy
  exposes NO per-call spend header (verified), but OpenRouter returns ACTUAL
  billed USD in the response body's `usage.cost` when the request opts in.
  `OpenRouterClient` now sends `usage:{include:true}` and surfaces a finite,
  non-negative `usage.cost` as `complete().costUsd` (undefined otherwise, so
  callers fall back to A5 price-table). The deriveV2 planner sums per-call
  reported cost into `DeriveSuccess.costUsd` (present iff ≥1 stage reported);
  `ser talk` compile prints "planner spend: $X (actual, provider-reported)".
  Scope: PLANNER path only. The ENGINE budget meter (`BudgetMeter`/`runner`)
  stays on the price table — it is fed by pi-ai, whose `Usage.cost` is computed
  from the model's price config (ser zeroes it), NOT OpenRouter's billed cost,
  and the harness never imports pi (invariant). Surfacing real engine spend
  needs an out-of-repo lever: a proxy spend header, or pi-ai `usage.include`
  passthrough. Owner chose planner-first (2026-06-13). Extends A5 and A35.
- A37. `ser talk` was uncommunicative and re-asked answered questions. Three
  fixes (2026-06-13): (1) PRESENT THE PLAN — `renderPlan` lists every
  requirement with its gate + stories + decisions + open forks; "show/present
  the architecture/plan/stories" routes to action:status mechanically
  (SHOW_PLAN_RE), and the plan prints on the flip to buildable, before inviting
  "build it". (2) TERSE ≠ UNCOMMUNICATIVE — `styleLockedIn` reports what was
  recorded in words ("decided: storage=SQLite", "resolved ✓", "+req: …")
  instead of the cryptic token form. (3) GUARANTEE CAPTURE — the conversation
  is disposable; the spec is the only memory (spec-session.ts:528 feeds the
  model only SPEC + MESSAGE, no history), so an answer survives only if written
  to the spec. The mapper now emits `asking` (the surfaced open_question id);
  when the user answers it next turn and the model forgets the resolve, the
  harness force-resolves it + records the answer as a decision — but ONLY when
  the asked question is unambiguous (model-flagged `asking`, or exactly one open
  fork) and the message is answer-shaped (not a meta/command, META_RE), because
  force-resolving the wrong question would corrupt the spec. (4) RECONCILE —
  the dominant live failure is the model SPONTANEOUSLY RE-ADDING a question a
  decision already answers ("what's her age?" while a decision records
  "4-year-old"), a SEMANTIC duplicate lexical rules miss. `SpecSession.reconcile`
  (run by the REPL after each accepted turn, only when ≥1 decision and ≥1
  blocking question coexist) makes ONE narrow cheap-model call — "which open
  questions does a decision already answer?" — and the harness validates the
  ids and applies the resolves. The model only IDENTIFIES; the harness ACTS
  (A28 pattern). Best-effort: bad JSON / network resolves nothing, never throws.
  Owner chose the LLM-reconcile approach over lexical/prompt-only (2026-06-13).
  (5) COHERENCE — the model also re-asks a settled fork in REPLY PROSE with no
  open_question backing it ("laptop locked but asking anyway" while a decision
  records the hardware, spec already buildable). reconcile can't catch it (no
  question to resolve), so the REPL strips a trailing question from the reply
  whenever NO blocking question remains (`stripTrailingQuestion`) — the model's
  own rule ("nothing open → don't ask") enforced mechanically. (6) LEGIBILITY —
  `renderPlan` now leads with "components — what gets built" in plain language,
  each "proven by:" a plain gate label (not a raw shell command); decisions are
  framed "yours to veto". Dogfood: "I have no idea what the components are."
  (7) FUNNEL — the idea→build→polish pipeline existed in code but was invisible,
  so `ser talk` prints a per-turn stage line `✓ idea ▸ ● BUILD ▸ polish  next:
  …` (funnelStage/funnelNext/renderFunnel). Stage = idea until buildable, build
  once it compiles, polish after the first run (`built` flag). Owner's mapping
  (2026-06-13): IDEA shapes + VERIFIES load-bearing claims; BUILD compiles/runs
  gated + hardens gates + fixes what they flag; POLISH = a designer's-eye review
  of the product, modeled on gstack's plan-design-review/design-review. The
  stage line + next-hint ship now; the POLISH design-review pass itself is the
  next build (not yet implemented).
- A38. `ser talk` quality is measured, not eyeballed (owner call 2026-06-13:
  hand-dogfooding a stochastic conversation engine is whack-a-mole and violates
  the project's own gate-not-prose / loop-endurance thesis). `pnpm talk-eval`
  (scripts/talk-eval.ts + src/eval/talk-eval.ts) runs simulated-user agents
  against the REAL SpecSession across product scenarios and scores each
  transcript by a MOSTLY-MECHANICAL rubric — facts-recorded (keyword presence
  in decisions), re-asks (token-Jaccard between asked questions), incoherent
  asks (question posed with 0 blocking questions), turns-to-buildable, and
  present-on-request — all deterministic from spec state, no gameable prose
  judging. `scoreTranscript` + helpers are PURE and hermetically tested; the
  runner is LIVE (network) and runs ONLY from the script (zero-network test
  invariant preserved, like derive-bench/poker-bench). RL/fine-tuning is
  deferred until this eval shows mechanics+prompt can't carry the cheap model.
  TWO TIERS (owner design 2026-06-13): TIER 1 = process quality — the mechanical
  rubric PLUS a funnel-aware judge (judgeProcess) scoring extraction on forks/
  captured/defaulted/coherence (0-5 each), blended 60/40 (processScore). TIER 2
  = output vs a SAME-FACTS vanilla one-shot spec (generateVanillaSpec) — the
  headline ablation: does the whole conversation beat a plain LLM handed the
  same facts? Scored mechanically (specQuality: gate coverage, fact coverage,
  decomposition) AND by a blind, order-randomized comparative judge
  (blindAssign + judgeSpecPair). The money number is the LIFT (ser − vanilla).
  PURE pieces (specQuality, blindAssign, processScore, scoreTranscript) are
  hermetically tested; judges/vanilla are LIVE/script-only. FIRST LIVE READING
  (recipe-box, n=1, 2026-06-13): ser 80 vs vanilla 100, lift −20, vanilla won
  the blind judge, ser captured 50% of facts vs vanilla's 100%. i.e. as built,
  the conversation UNDERPERFORMS a same-facts one-shot — the instrument now
  exists to drive that lift positive (needs full multi-scenario runs to confirm).
- A39. The conversation engine is improved by a GATED SELF-IMPROVEMENT LOOP, not
  hand-dogfooding (owner direction 2026-06-13): the smart agent (Claude main)
  is the optimizer; the two-tier eval (A38) is the gate; git is the memory.
  One iteration = read results/talk-eval JSON → pick the worst metric (baseline
  n=3: mean Tier-2 lift ≈ −24, root cause = fact-capture, judge forks 2/5) →
  one targeted edit to the ser engine (mapper prompt or a mechanic) → `pnpm
  test` must stay green (guardrail) → `pnpm talk-eval` (fitness) → commit if
  lift rose, `git reset` if not. Exactly ser's own attempt→gate→commit/reset
  node loop, applied reflexively to ser. WORKER = Claude Haiku via the user's
  SUBSCRIPTION, not metered OpenRouter — bridged through `ClaudeCliClient`
  (src/llm/claude-cli.ts), an LlmClient that shells to `claude -p --model
  <m> --output-format json` (Haiku = engine under test; a stronger Claude =
  judges + simulated user). `pnpm talk-eval` defaults to `--worker claude`;
  `--worker openrouter` falls back to the grant. Caveat: `claude -p` wraps the
  prompt in Claude Code's own system prompt (Haiku-as-CC-agent, not a bare
  model) — fine for optimizing against the eval, not a substitute for the live
  cross-executor gauntlet. Anti-overfit: expand scenarios (Haiku-generated,
  spot-checked) + a held-out set before trusting a lift gain.
- A40. First gated iteration of the A39 loop (2026-06-13): the eval's headline
  finding was that ser-talk crystallized ~0 decisions while a same-facts vanilla
  one-shot produced ~5 — so it LOST the ablation. Fix: `SpecSession.captureDecisions`,
  reconcile's sibling — each turn the model EXTRACTS the concrete constraints the
  user stated (platform, storage, scope) and the harness records them as
  decisions (deduped via wordOverlap; best-effort; runs in the REPL and the eval
  runner). Gated on the full 3-scenario eval: mean Tier-2 lift −24 → −9, blind
  judge wins 1/3 → 2/3, habit-tracker facts 0% → 100% (lift −40 → +0). Lift rose
  ⇒ committed (the loop's own rule). Not yet at positive lift — recipe/kid still
  leak facts (50%/33%); next iterations continue. Instrument note: `claude -p`
  ~3-5s/call makes the full judged set >10min; gate detached, and a fast
  mechanical-only fitness mode is the next loop-hardening step.
  ITERATION 2 (capture-on-seed): the seed/idea path skipped captureDecisions, so
  facts in the OPENING line ("…on a laptop") never became decisions — fixed in
  the REPL + eval runner. Committed as a CORRECTNESS gap-fix, NOT a gated win:
  the run that gated it was dominated by instrument noise (parallel `claude -p`
  contention broke a conversation to composite 0; the vanilla baseline swung
  20–100 across runs), so no trustworthy lift delta. KEY FINDING: the eval is
  too noisy to gate AMBIGUOUS tuning changes — it needs SEED-AVERAGING (N runs
  per scenario, averaged) and CONCURRENCY CONTROL before driving further edits.
  DONE: talk-eval now takes `--seeds N` (averages, reports lift μ±σ) and
  `--concurrency K` (a task pool — concurrency 2 fixed the contention that broke
  runs). Stable re-baseline (3 scenarios × 3 seeds, mechanical): MEAN LIFT
  −2.7 ±26 (SE ≈ ±8.7) — the capture iterations took ser-talk from −24 (clearly
  losing) to ~parity with vanilla, winning 2/3 scenarios, facts 44–83% (was ~0).
  σ is still large: a future edit must move the mean by ≳2·SE (~17) to gate as
  real; tiny tweaks need more seeds. Laggard = kid-companion (−25, facts 44%).
- A17. Commands: `run <mission> [--mock] [--chain <name>]`,
  `derive "<goal>" [--yes] [--chain <name>]`, `trace <file>`,
  `experiment` (delegated to scripts/experiment.ts via pnpm). Top-level
  catch prints one line + trace path, exits 1.
