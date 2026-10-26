# ADR-0002: Same-origin API in dev via Vite proxy
Status: Accepted · 2026-10-26

**Context.** The refresh token lives in an httpOnly `Secure; SameSite=Lax` cookie scoped to
`/api/v1/auth/`. With the SPA on :5173 and the API on :8000, cookie, CORS and CSRF behaviour differs
between dev and prod — a common source of "works locally, breaks in prod" bugs.

**Decision.** The Vite dev server proxies `/api` to the `api` container, so the browser always talks to
one origin (as Nginx will in prod). CORS stays configured (allow-list from env) but is not relied on in
dev. CSRF on refresh/logout uses a double-submit token (`csrftoken` cookie readable by JS, echoed in
`X-CSRFToken`) plus an Origin check. `Secure` cookies work on `http://localhost` in modern browsers.

**Consequences.** Identical cookie semantics in dev and prod; smaller CORS surface.
