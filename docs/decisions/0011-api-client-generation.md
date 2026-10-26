# ADR-0011: Typed API client via openapi-typescript + openapi-fetch
Status: Accepted · 2026-10-26

**Decision.** `make schema` exports drf-spectacular's schema to `frontend/openapi.json` (committed) and
runs `openapi-typescript` to produce `src/lib/api/schema.d.ts`. Calls use `openapi-fetch` with a
middleware that attaches the in-memory access token and retries once after a refresh. Chosen over orval
for its tiny runtime and no generated hook code to review; TanStack Query hooks are hand-written per
feature. CI fails if the committed schema is out of date.
