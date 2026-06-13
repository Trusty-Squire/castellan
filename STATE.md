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

## Next
Live gates 2-3 (derive-bench, poker-bench, human/key). Then v0.3 centerpiece
per thesis: the standing-loop runtime (triggers, queue, recurring missions) —
now genuinely unattended, since the credential boundary no longer needs a
human-held key.
