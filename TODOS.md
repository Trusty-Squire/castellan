# TODOS.md — implement next

## 1. Credential-free runtime: Trusty Squire egress grant — DONE (2026-06-13)
ser never holds the real API key. Achieved via a Trusty Squire **egress grant**
(A35), not the originally-specced local proxy: `grant_app_access` mints a
{base_url, token} pair pointing at the vault's hosted egress proxy. The vault
injects the real OpenRouter key host-side and enforces the credential's
allowed-hosts; ser holds only a leashed, revocable, metered token. ser needed
NO code change — it already honors `OPENROUTER_BASE_URL`/`OPENROUTER_API_KEY`.
- [x] credential boundary: real key out of ser's runtime — `~/.config/
      castellan/.env` now holds the grant base_url + leashed token, not the
      raw key. Verified end-to-end: `ser idea "a habit tracker app"` → real
      stories/components, exit 0, key never crossed to ser.
- [x] no-key-present concern moot: ser holds a leashed token in the key slot,
      so the NO_API_KEY check passes unchanged (the grant token IS the secret,
      just scoped/revocable instead of raw).
- [x] vault side (separate repo): egress proxy + `grant_app_access` shipped in
      `@trusty-squire/mcp@0.9.15` (0.9.14 was a broken publish — boot crash
      from a skill-schema dep skew; see session notes). Proxy now passes
      `Content-Encoding` through transparently (gzip/br/deflate decompressed,
      stale header stripped) — the fix that unblocked undici/`ser`.
- [~] ser: surface REAL spend instead of price-table arithmetic — PLANNER DONE
      (A36): the proxy emits no spend headers, but OpenRouter reports actual
      `usage.cost` in the body when asked; OpenRouterClient now opts in
      (`usage:{include:true}`) and `ser talk` compile prints "planner spend:
      $X (actual, provider-reported)", price-table the fallback when unreported.
      ENGINE meter still on A5 price-table — pi-ai computes cost from a (zeroed)
      price config, not OpenRouter's billed cost, and the harness is walled from
      pi. Unblock levers: a proxy spend-header ser reads per call, OR pi-ai
      `usage.include` passthrough. (owner chose planner-first, 2026-06-13)
- [ ] docs: "ser without secrets" setup path — STILL OPEN (the grant recipe in
      A35 is the source; a user-facing doc page is not yet written).
Why it fits the thesis: loops spend money unattended; the credential
boundary and the spend meter belong in the substrate, not the agent
(H4 control-substrate research; budget-meters-are-hard-stops invariant).

## Parked behind it (v0.3 candidates, in thesis order)
- Standing-loop runtime: triggers, queue, recurring missions (the
  centerpiece — loops as the product).
- Leaderboard/referee harness.
