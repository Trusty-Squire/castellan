# SPEC-v0.3 — Authoring rearchitecture (design authority)

> Status: design authority for the v0.3 spec-authoring rebuild. Supersedes the
> v0.2 delta-mapper conversation (A28) where they conflict. The build/execution
> layer (SPEC-v0.2 gated loops) is unchanged — it was always right.

## 0. Decision: ser is a STANDALONE product

ser ships as `castellan` and must work with **no external dependency**. Therefore:
- The authoring pipeline (below) lives **in-tree**. ser authors its own specs.
- gstack is the **blueprint** for the adversarial sweep, and an **optional**
  external author — never a runtime dependency.
- The **spec contract** (§3) is the seam: any author (ser's own pipeline,
  gstack, a human, another tool) produces a conforming spec; ser validates it
  and runs its own gate-objectivity membrane on every input. ser never trusts
  that an external author made the gates loopable — that is ser's job.

This makes ser standalone AND composable.

**gstack's form (confirmed by inspection 2026-06-14).** gstack is a Claude-Code
skill monorepo (`~/.claude/skills/gstack`, bun-based), not a callable library —
its `package.json` exposes only `browse`/`make-pdf` bins; the authoring (`/spec`)
and the sweep (`/autoplan` = CEO/design/eng/DX reviews) are SKILLS run inside a
Claude session. So depending on it would mean orchestrating headless `claude -p`
with the gstack skills + a Claude subscription at runtime — heavy for a
cheap-LLM product. Decision: ser implements the lean PATTERN in-tree and accepts
a gstack-authored spec **through the contract** (§3) when present. gstack stays
OPTIONAL; the membrane runs on its output regardless (gate-objectivity is not
gstack's job).

## 1. Why (the evidence)

Measured this build cycle (two-tier eval, subscription Haiku worker):
- ser-talk's specs only **tied or lost** to a same-facts vanilla one-shot.
- Rich products **collapsed**: "ambient AI companion for a 4-year-old" became a
  cloud chatbot that greps for "scary", with a *manufactured* "responses mention
  dinosaurs" requirement, no parental oversight, and the laptop/privacy fact
  violated. The safety essence was **never elicited** — buildable declared in 3
  turns.
- Every re-ask / dropped fact we band-aided (capture pass, reconcile pass,
  answer-capture) was a prosthetic for an agent with **no memory**.

Root cause: **disposable-history (A28) was applied to the wrong half.** Disposable
context is correct for the BUILD (isolation, reproducibility, cheap parallel
loops). It is wrong for the CONVERSATION, whose whole job is to build a stateful
understanding of a fuzzy human intent. And the conversation was the only
**unverified** stage in a verification product.

## 2. Target architecture — two regimes, one membrane

```
  AUTHORING (memory-ful, verified by DIALECTIC)
    memory-ful agent  ──per-turn──▶  diverse-lens dialectic on architectural forks
        │                              (scope-cutter · risk/essence · fact-keeper)
        ▼
  THE SWEEP (adversarial review of the CANON — gstack pattern)
        │   fixed-stance reviewers shred the spec; revise
        ▼
  THE MEMBRANE (ser's soul — GATE OBJECTIVITY)
        │   every requirement → an automatable gate, or flagged; facts preserved
        ▼  ───────────────────── the SPEC CONTRACT (§3) ─────────────────────
  BUILD (disposable, verified by GATES — unchanged)
        fresh agents · spec-as-canon · never conversation history · gated nodes
```

**2.1 Authoring (memory-ful).** A normal agent with the full conversation in
context; the spec file is its working artifact. It remembers what it asked, what
the user stressed, what is still unexplored. This deletes the structural handicap
behind premature buildability and re-asking.

**2.2 Per-turn dialectic.** Each move on an ARCHITECTURAL (costly-to-undo) fork
is the synthesis of diverse-lens subagents — NOT N copies of one model:
- **scope-cutter** — "can this be smaller / is this v2?"
- **risk/essence reviewer** — "what load-bearing fork are we skipping?"
- **fact-keeper** — "did we honor what the user actually said?"
Mechanism: propose → adversarial critique → **COMMIT to one call, log the
dissent**. It must NEVER surface a menu ("X or Y") — that is the hedge that lost
to vanilla. Scoped to architectural forks; config/CSS gets silent defaults.

**2.3 The sweep.** Before hand-off, fixed-stance reviewers (the gstack
autoplan pattern — safety/risk, scope, fact-fidelity, completeness/essence) attack
the synthesized spec and it is revised. This is where "objective-but-wrong"
(objective gates on shallow or manufactured requirements) dies.

**2.4 The membrane (ser's soul).** Every requirement gets an OBJECTIVE,
automatable gate (tier 1-3) a cheap agent runs unattended — or is explicitly
flagged tier-4 with a tier-1 proxy. Facts preserved. No external author
guarantees this; ser owns it. This is the loop-harness contract and ser's
differentiator (measured: it is what beats the one-shot).

**2.5 Build (unchanged).** Fresh agents, spec-as-canon, never conversation
history; gated nodes, commit on pass, reset on fail (SPEC-v0.2). Correct as-is.

## 3. The spec contract (the seam)

The canonical, schema-validated artifact ser compiles (today's `SpecSchema`):

```
thesis: string
stories: string[]
scope_fence: string[]
requirements: [{ id, statement, acceptance: { tier, gate? | artifact? } }]
decisions:    [{ id, statement, rationale, claims: string[] }]
claims:       [{ id, statement, status, evidence }]
open_questions: [{ id, text, blocking }]
```

**Loop-harness obligations ON the contract** (what ser enforces on any input):
- **Objective gates.** Every requirement MUST be tier 1-3 (an automatable gate),
  OR tier-4 WITH a tier-1 proxy. tier-0 (no check) = NOT buildable.
- **Commitment.** Decisions are committed choices, never menus.
- **Fidelity.** Facts the author elicited are recorded as decisions; the spec
  never contradicts a stated fact.
- **Scope.** The story set is the smallest that delivers the core (MVP).

Conformance is mechanical (schema + the membrane). An external author (gstack)
fills the contract for product quality; ser's membrane still runs to enforce
loopability, because that is not the external author's job.

## 4. What this deletes

The delta-mapper, the disposable-history conversation, and its prosthetics —
`captureDecisions`, `reconcile`, the answer-capture/postProcess scaffolding.
They existed only to fake memory. The two-tier eval and the subscription loop
STAY (they are how we prove each layer).

## 5. Sequence — eval-gated layers (not rewrite-on-faith)

Each layer ships only if it beats the prior on the eval:
1. **Memory-ful authoring agent** (replace the delta-mapper). Gate: kid-companion
   stops collapsing; lift holds/rises.
2. **Commit-discipline + explicit gate-objectivity membrane.** Gate: obj stays
   high AND completeness (the new sweep tier) rises.
3. **Per-turn diverse-lens dialectic** on architectural forks. Gate: essence-fork
   capture up.
4. **The spec sweep** over the canon. Gate: blind judge prefers ser; the sweep
   catches "objective-but-wrong".
5. **(Optional) gstack integration** — document how gstack fills the contract for
   toolchain users; ser stays standalone without it.

## 6. Eval change (so we can't game gate-format)

`objectiveRate` alone is gameable (objective gates on shallow requirements — see
the kid-companion cloud-chatbot). Add a **completeness/fidelity tier**: a
sweep-style judge asks "does this spec serve the stated product, honor the
facts, and gate what *matters*?" `objectiveRate` becomes a floor, not the score.

## 7. The funnel (user journey) — and where dogfooding lives

Castellan is an **advisor, not an assistant**: an assistant makes *you* bring the
judgment and supervise every turn (expensive × supervised); an advisor brings the
judgment, makes it concrete as a **quantifiable spec**, and loops against it
unattended (cheap × hands-off). Thesis: **cheap × quantifiable specs enable
loops.** The user's effort is front-loaded (high at idea, where only they hold the
forks), near-zero at build (the advisor + gates carry it), and rises again at
audit (their eyes on the real thing) — always as *direction*, never labor.

Seven stages:
1. **Idea** — distill the 1-line pitch + the core user stories; a light, advisory
   competitive/uniqueness flag (model-knowledge or browser; never blocking);
   surface ONLY the load-bearing forks the user holds (safety, hardware, rules),
   one at a time, each with a recommended default.
2. **Spec (execution)** — decompose into small, maximally-parallel components;
   COMMIT the tech (no menus); surface genuine tensions as economical
   multiple-choice with a recommendation; attach an OBJECTIVE gate to every
   component (the membrane — this is what makes it loopable).
3. **Polish** — design look/feel around the stories + eng realities; design
   becomes *gated* requirements too ("buttons ≥48px" → a grep, not a vibe).
4. **Signoff** — the adversarial SWEEP (gstack-autoplan pattern: safety/scope/
   fidelity/essence reviewers) attacks the spec; the committee synthesizes; the
   user gives one signoff. This is where "objective-but-wrong" dies and the
   advisor's *wisdom* is made legible.
5. **Build** — cheap fresh-agent loops on the gates; the user watches, doesn't
   drive (loop endurance: iterations per intervention). Honest halt on a gate it
   can't meet after retries.
6. **Audit — DOGFOODING LIVES HERE.** Per-component gates being green ≠ the product
   works; the gap (e2e/integration/feel bugs) is found only by *using* the thing.
   Two modes: (a) AUTOMATED dogfooding — an agent drives the real product
   (Playwright) like the target user, hunting bugs — this is **the eval's
   simulated-user agent re-pointed** from "test the spec author" to "test the
   shipped product," and the two-tier eval becomes the audit's scoring; (b) HUMAN
   dogfooding — the user uses it and reacts. Crucially, every bug found becomes a
   **regression gate** — dogfooding *feeds* the quantifiable spec instead of
   bypassing it: it discovers the unanticipated, gates lock it, the loop fixes it,
   the spec stays quantifiable as the product evolves. Refactor/tune happen here,
   made SAFE by the gates (nothing regresses silently). This B↔A loops until right.
7. **Ship.**

The dogfooding resolution (the lesson of the v0.2→v0.3 work): you DOGFOOD a
PRODUCT (a thing you use) and you MEASURE a SPEC (a plan you can't use). Hand-
dogfooding the spec felt unproductive because it was the wrong phase — that work
became the quantified eval (§6). Dogfooding's right home is audit; the eval
harness + simulated user we built for spec-quality graduate into the audit engine.

## 8. Updates since this draft (settled in conversation 2026-06-14)

- **Thesis/positioning:** cheap × quantifiable specs enable loops; advisor-not-
  assistant. NOT "out-opinion Codex" (competes on the wrong axis). Two axes a good
  advisor needs: *rigorous* (quantifiable gates → loopable; the moat) AND *wise*
  (right forks/real product → the sweep; quality control, not the pitch).
- **Engine: build on goose** (spiked + confirmed). Authoring = goose WITH a session
  (recipes + `--sub-recipe` sweep + research MCP); build = goose `--no-session`
  (stateless, gated). Our gates are the spine; the membrane/contract stay ours; no
  Rust. The `SpecSession`/cheap-model authoring layers of §2–§5 are superseded by
  the goose authoring agent (the *behaviors* — memory, dialectic, sweep — carry
  over to the premium runtime; a cheap model proved an incompetent adversary).
  See memory `castellan-product-direction` for the full chain.
