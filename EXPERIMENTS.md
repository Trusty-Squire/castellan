# EXPERIMENTS.md — ad-hoc experiment log

Index of experiments run against ser (beyond the formal `scripts/experiment.ts`
benchmark in RESULTS.md). One row per experiment: the question, the finding, and
where the raw data/scripts live. **Conclusions** that matter long-term also go to
the cross-session memory (`…/memory/`) and to commit messages; this file is the
*index* so a run can be revisited, not re-derived from memory.

Data dirs live under `/home/lunchbox/` (demo artifacts, deliberately NOT in the repo
to avoid bloat). If a dir is cleaned up, its row's finding still stands via memory.

| date | experiment | question | finding (1-line) | data / scripts |
|---|---|---|---|---|
| 2026-06-20 | **gypsy full funnel** (codex backend) | does ser build a real app e2e from a vague, ambition-laden prompt? | built a working, audit-clean app — but the visual judge **false-passed** themed text as "immersive"; kicked off the whole judge investigation | `gypsy-build/` |
| 2026-06-20 | **arcade probe** (20 one-shot games + eval) | strip popular games so the model can't rote-implement — does it then fail? | cheap model one-shots *plausible* versions of even obscure games; binding constraint is **verification, not capability/memorization**; the judge is the bottleneck (3rd time) | `arcade-probe/` (`eval-results.json`) |
| 2026-06-20 | **spec-probe** (unstrip: constrained vs unconstrained extractIdea) | does the model under-build, or does the harness strip it? | model proposes **2–3.5× richer** shape unconstrained; ser's "recommend the smaller build" prompt strips it to a gateable skeleton → drove the **unstrip** commit | `spec-probe/` (`*.json`, `before/`) |
| 2026-06-20 | **holdem `--to spec` ×7** (dom-behavior selection) | will the planner SELECT a browser/DOM gate for UI? | **no, 4×** — anchored on curl/grep/vitest; found + fixed a footgun (browser absent from `detectAvailableTools`); resolved by **harness-attaching** the gate (commit `0007efe`) | `holdem-spec2…7/` (`mission.yaml`) |
| 2026-06-20 | **arcade iteration** (gated loop, VLM judge) | does a cheap loop lift the floor? | **8 wins** (broken→playable) but the noisy VLM gate caused **2 regressions + 2 stalls**; gate reliability bounds loop quality | `arcade-iterated/` (`iterate-results.json`) |
| 2026-06-20 | **rubric build-loop** (habit tracker, deterministic checks) | web rubric → component contract → deterministic dom-gate, no VLM? | cheap model **one-shot 6/6** components against the contract; verified by dom-gate, **zero VLM calls** | `rubric-demo/` (`result.json`, `build-loop.mjs`) |
| 2026-06-20 | **rubric VLM polish loop** (opus, then gpt-5.5/codex) | does the VLM add value the presence-check can't see? | **yes** — it caught an **empty chart that passed the presence check** (present≠complete); adversarial+pairwise held **cross-model**; but a holistic "more polished?" ratchet **won't force a specific defect closed**, and the cheap builder hit a **ceiling** (couldn't fix the chart in 3 tries) | `rubric-demo/` (`build-loop-vlm.mjs`, `vlm_*.png`, `vlm-*.log`) |
| 2026-06-21 | **closure-judge replay** (empty-chart screenshots vs `reviewClosure`) | does the adversarial closure judge refuse the false-pass the holistic ratchet gave? | **yes** — held the empty chart `present` across BOTH before/after shots (old loop said "✓ polished, kept" ×3 and would have shipped it), abstained `unsure` when it couldn't prove a fix, and confirmed a genuine tile fix — frozen-list + per-defect + abstain all working on the real case | `rubric-demo/closure-check.mjs` (shots: `vlm_FINAL_*.png`) |
| 2026-06-20 | **deep-research ×2** (ambiguity; LLM-as-judge) | how to detect under-determination / build a trustworthy judge? | divergence>self-confidence; gateability as the resolution axis; judge must abstain; VLM judges fail at perception, decompose + adversarial + reference-anchor | memory: `castellan-ambiguity-research`, `castellan-judge-design` |

## Standing practice
When you run an experiment worth remembering: add a row here (question + 1-line
finding + data path), and if the conclusion is durable, also write/update a memory
file. Don't move the raw data into the repo — index it.
