# ADR-0012: Toolchain version pins
Status: Accepted · 2026-10-26

**Context.** At scaffold time the newest TypeScript is 7.x, but `typescript-eslint` 8.72 accepts
`<6.1` and `openapi-typescript` 7.13 accepts `^5`.

**Decision.** Pin `typescript@~5.9` until both tools support a newer major. Pin uv to `0.13.5` in the
Dockerfile and CI so lockfile behaviour is identical everywhere. Python dependencies are locked in
`backend/uv.lock` (Django 5.2.x LTS), npm dependencies in `frontend/package-lock.json`.

**Consequences.** Revisit when typescript-eslint and openapi-typescript announce TS 6/7 support.
