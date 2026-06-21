# STATE.md

## v0.1 / v0.1.1 — done
Harness, real engine, 20-task benchmark, ablation (35%→100%), opus parity at
~1/25th cost (RESULTS.md), audit + hardened gates, rebrand to Castellan
(binary `ser`), thesis: cheap and reliable makes loops.

## v0.2 — planning layer BUILT (this session); live measurements pending
Per SPEC-v0.2:
- Gate ladder: schema v2 (gate objects, max_human_checks), executeGate for all
  four tiers — human gates pause/record/escalate (success gate #5 ✅ via
  tests), judge soft-only with judge_flag.
- Gate-pattern library: 10 patterns, each citing the measured failure that
  created it; renders validate against GateSchema.
- derive-v2 herald pipeline: 7 stages, spec-acceptance-wins gate inference,
  adversarial lenses w/ evidence-required refutations, tier-0 refusal w/ 3
  remediations, --judge mode. CLI routed.
- ser spec: spec.yaml schema + SpecSession delta loop (bounded context proven
  by test, git-checkpointed accepts, rejection-escalation), checkSpec gates,
  verifyClaim lenses. CLI: init|check|verify|talk.
- ser do / ser fix mission packs (mechanical, refuse-if-ungated).
- Benches built (not run live): derive-bench (planner tax), poker-bench
  (5 infeasible + 2 controls), gate-attack (hermetic; 0 fails on tasks 1-5,
  1 legit warn on the refactor task).
- Unified interface: `ser talk` — one conversation across all tools; the
  mapper requests harness commands via an `action` field (check/verify/
  derive/run/status/score), the harness executes mechanically and reports (A28).
- Spec-authoring hardening pass (dogfood-driven, A32-A33 + below):
  readiness SCORE the loop drives; autofill authors a thin spec to ready
  ("build it anyway"); the harness OWNS ids/shapes (coerceRawDeltas accepts
  the model's natural op-keyed output — the fix that made autofill work at
  all); diagnostician advises only (mechanical floor blocks); autofill
  fact-checks load-bearing claims with the adversarial lenses and surfaces
  refutations. Validated by LIVE qwen runs, not just mocks.
- 200 hermetic tests; zero network; CI green.

## Live runs DONE
1. Cross-executor gauntlet (glm/kimi/deepseek × 20 tasks, identical prompt):
   ALL THREE 20/20 completed. Cost/mission: glm $0.0224, deepseek $0.0283,
   kimi $0.1990. Strong pillar-3 evidence ("any cheap model" holds for >=3).
   CSV: results/experiment-2026-06-13T04-53-02-721Z.csv.

## Live runs pending (human/key)
2. `pnpm derive-bench --tasks 1..20` — the planner tax (THE v0.2 bet).
3. `pnpm poker-bench` — refusal quality.
4. Cheap autofill plateaus ~45/100 on a RICH product spec (qwen diagnostician
   keeps finding ~3 majors; 85 bar unreachable by cheap alone). Levers:
   knight-escalate the fill/diagnostic last-mile, or tune READY_THRESHOLD.
   Open decision for the human.

## v0.2.x — credential-free runtime DONE (2026-06-13)
TODOS #1 closed via a Trusty Squire EGRESS GRANT (A35), not the originally-
sketched local proxy. `grant_app_access` mints a leashed {base_url, token};
the vault injects the real OpenRouter key host-side. `~/.config/castellan/.env`
now holds `OPENROUTER_BASE_URL=<grant>/api/v1` + the leashed token — the real
key is removed. ser took NO code change. Verified end-to-end: `ser idea
"a habit tracker app"` → real stories/components, exit 0, key never crossed to
ser. Grant minted unlimited (no rate/spend caps) per owner instruction; spend
metered server-side per grant_id. Tooling: `@trusty-squire/mcp@0.9.15` (pin
bumped in ~/.claude.json; 0.9.14 was a broken publish — boot crash from a
skill-schema dep skew). Real-spend follow-up (A36): the proxy emits no spend
header, but OpenRouterClient now opts into OpenRouter's `usage.cost`; the
deriveV2 planner sums it and `ser talk` prints actual provider-reported spend
(price-table fallback when unreported). Engine budget meter stays on A5
price-table (pi-ai computes from a zeroed price config, not billed cost; harness
walled from pi) — needs a proxy spend header or pi `usage.include` passthrough.

## Node sizing — kill the "1-12" count anchor DONE (2026-06-20)
Plan: ~/.claude/plans/node-chunking.md (eng-reviewed + Codex-corrected). The
decompose prompt's "1-12 nodes" range was an ANCHOR (LLM output clusters at an
embedded number; prompt-softening doesn't fix it), so node count tracked the
range, not task size. Shipped steps 1-4 of the 5-step sequence; step 5 (real
split-as-DAG-transform) stays deferred per the plan.
- (1) BOTH count inflators removed. decompose prompt now carries SIZING_RULE +
  an EXECUTOR-ENVELOPE line (no number to anchor on); the spec-mode coverage
  retry was softened — it REASSIGNS uncovered ids to existing nodes instead of
  telling the model to add/split (the second, independent inflator Codex found).
- A node may now carry SEVERAL requirement ids (comma-separated, `nodeRequirementIds`).
  Coverage counts the union. Gate inference AGGREGATES per node (the parent-gate
  principle: a multi-requirement node is a verification loophole unless its gate
  covers all of them) — any tier-4 → human dominates; all tier-1/2 → AND the
  concrete commands; mixed → infer one gate then AND the concrete commands on.
- (2) Envelope WIRED. Optional `node_context_budget` on ChainSchema (default
  40000, back-compat); CLI threads chain.executor + chain.node_context_budget
  into deriveV2 (envelope targets the EXECUTOR, not the knight that plans); it's
  copied into every derived node's max_context_tokens. Per-node USD now goes
  through `allocateNodeBudgets` (floor 0.05 + 20% escalation reserve over the
  planner's weights) so a small-but-hard node keeps escalation headroom.
- (3) Derive-time overflow filter (`overflowingNodes`): a node whose EXISTING
  context_globs already pack over the envelope → refuse (re-derive). Weak by
  design (blind to files future nodes create); a cheap first filter.
- (4) Runtime `pack.truncated` → HONEST HALT with a diagnostic naming the dropped
  files + glob set (not inline DAG surgery — that stays out of scope). This is the
  real safety net; the funnel re-derives from last green.
- Calibration (PREREQUISITE, plan step 0): `pnpm calibrate-envelope` sweeps a
  synthetic needle-in-context node by size, finds the first-try knee = the
  envelope. chains.yaml `cheap.node_context_budget` set PROVISIONAL 24000 pending
  the live run. derive-bench extended with a count-vs-size SIZING report
  (Spearman ρ + derived-count spread; near-zero spread = the anchor's fingerprint).
- Tests: +9 hermetic (schema back-compat, envelope→max_context_tokens, multi-
  requirement coverage+aggregate gate, derive-time overflow refusal, budget
  floor/reserve, runtime truncation halt). Full suite 281→ green; typecheck +
  lint clean; demo + ablation + experiment --dry-run exit 0.
- LIVE pending: `pnpm calibrate-envelope` (set the real envelope), then
  `pnpm derive-bench` to confirm count-vs-size ρ>0 and the tax stays <=10.

## Frontend-gate thread (2026-06-21) — DONE 1+2 of 3
Empirical finding (4 live `--to spec` runs): the cheap planner will NOT select a
browser/DOM gate for UI nodes — it anchors on curl/grep/vitest. So the harness DOES,
it doesn't coax.
- (#1, commit 0007efe) Harness-ATTACH a deterministic DOM gate. derive2.ts:
  extractDomHooks + looksLikeUi + deriveUiGate → a dom-behavior gate asserting each
  pinned [data-*] hook RENDERS (served via npm start), attached to the LAST UI node,
  overriding the planner's stub grep. Live-confirmed: holdem's lobby-ui node now gets
  `node .squire/dom-gate.mjs … assert [data-bot-selection]/[data-start-game]/[data-card]`.
  +5 hermetic tests.
- (#2, commit d4d82ab) Adversarial CLOSURE judge for the rebuild loop. The loop
  re-judged holistically each round → fresh nitpicks while the load-bearing defect
  survived (the empty-chart case the old "more polished?" ratchet shipped). Now:
  freezeDefects (freeze what blocked at round 1) → reviewClosure (VISUAL_CLOSURE_SYSTEM:
  adversarial default-present, ABSTAIN unsure, no new blockers) → unresolvedDefects
  (only 'fixed' clears; present/unsure/omitted/null stay open). Ship ⟺ list empty;
  converges or honest-halts. Validated on the real screenshots (rubric-demo/
  closure-check.mjs): empty chart held `present` both rounds, abstained on unprovable,
  confirmed a real fix. +7 hermetic tests. 308/308; typecheck+lint+build clean.
- Also added EXPERIMENTS.md (index of this session's scattered ad-hoc runs).
- (#3, NEXT) render backstop: flag a node that renders content but got no visual/dom
  gate. (#4, deferred) web-search spec enrichment via Exa, only if component-knowledge
  proves too stale.

## Trusty Squire build probe (2026-06-21) — serve-gate shipped; contract-coherence is the next target
Full cheap funnel built the owner's flagship vault against mock providers (3 runs).
bot-client + secure-storage PASS real gates; auth-api honest-HALTS every run (jidoka
held — never false-shipped). Peeled a stack of greenfield gaps:
- serve-gate (src/harness/serve-gate.ts) — boots the built server for HTTP gates the
  planner won't (boot/wait-port/check/teardown + start-inference; src/ scan). SHIPPED.
- deps provisioned (owner chose provision over stdlib-nudge).
- THE REAL WALL (unfixed, deliberate): CONTRACT/GATE INCOHERENCE. The shared contract
  pins `export createApp(): Express` (testable factory, no listen()), but the harness
  HTTP gate needs a LIVE server on :8000 — `node src/auth-api.js` exits without
  listening → "server never came up". NEXT FIX: when a node's gate is a live serve-gate,
  the contract must require a runnable entrypoint that listens on the gate's port
  (reconcile factory-export ↔ live server). Even opus halts on this — harness vs itself.

## Next
Contract-coherence fix above (highest-leverage — it's what blocks any full-stack server
build). Then live gates 2-3 (derive-bench, poker-bench, human/key). Then v0.3 centerpiece
per thesis: the standing-loop runtime (triggers, queue, recurring missions) —
now genuinely unattended, since the credential boundary no longer needs a
human-held key.
