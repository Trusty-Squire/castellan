# UI primitive palette (available — use it, don't fight it)

A small, pre-built, good-looking UI kit (Obsidian × Linear aesthetic). **These are here to lift
your floor — reach for them instead of styling from scratch.** Nothing forces you to; but using
them gives you a clean, accessible, dark-first UI for free.

## What's here
- **`theme.css`** — drop-in design tokens + base styles for `button`, `input`, `.card`/`.panel`,
  `.list`/`.row`. Serve it as a static file at **`/theme.css`** and `<link>` it. Dark by default;
  `<html data-theme="light">` for light.
- **`components/login.html`** — the login surface. Serve at **`GET /`**. Posts to `POST /login`.
- **`components/dashboard.html`** — the dashboard surface. Serve at **`GET /dashboard`**
  (session-gated; redirect to `/` if not logged in). Inject the user's keys into
  `[data-testid=api-keys-list]` — one `.row` per provider with the provider name and the masked
  key (last 4 chars).

## How to use (typical Express app)
1. Serve `theme.css` and the two HTML files (e.g. `app.use(express.static(...))` or read+send).
2. `GET /` → send `login.html`. `POST /login` → validate via `storage.get_user_keys`, set a
   session cookie, redirect to `/dashboard`.
3. `GET /dashboard` → require the session (else redirect `/`); render `dashboard.html` with the
   user's keys injected into the list. `POST /logout` → clear session, redirect `/`.
4. `GET /api/keys` (HTTP Basic Auth) → return the keys JSON for agents.

## Contract you must keep
The `data-testid` attributes (`login-form`, `email-input`, `password-input`, `login-button`,
`dashboard`, `api-keys-list`, `logout-button`) are part of the UI contract — keep them so the app
is testable. Everything else (layout, copy, extra styling) is yours to change.
