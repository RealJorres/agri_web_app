# MERN migration plan

Status: **approved 2026-11-03.** Design decisions: ADR-0019. P2-M6 and P2-M7 wait until this is
finished.

## Approach
- Work on a `mern-migration` branch. `main` keeps the working Django version until cutover.
- Keep the API contract (78 paths in `frontend/openapi.json`) so the frontend changes as little as possible.
- Port behaviour, not code line by line. The current pytest suite is the spec: each milestone ports its tests.
- Nothing needs Docker. Node 22 is already installed.
- Each milestone ends with tests and lint green and a commit.

## What is needed from the product owner
| # | Input | Needed by |
|---|---|---|
| 1 | Atlas connection string, placed in `.env` as `MONGODB_URI` (not in chat or git), with this machine on the IP access list | M0 |
| 2 | Atlas tier and region, and confirmation of backups for that tier | Before M8 |
| 3 | PAO aware of and approving hosting farmer data on Atlas | Before M8 |

## Milestones

### M0 — Scaffold
npm workspaces (`server`, `frontend`), TypeScript strict, Express, Mongoose, env validation, error format
`{code, message, fields}`, security headers, health endpoint, `npm run dev` / `test` / `lint` / `fmt`,
in-memory MongoDB for tests with the guard against Atlas URIs, updated CI.
**Done when:** `npm run dev` starts both sides from a clean clone, and health reports an Atlas connection.

### M1 — Accounts, scoping, audit
Users, roles, capabilities, assignments; login, refresh, logout, me, CSRF, lockout; the scoping helper used
by every record query; append-only audit log with masked personal fields; `create-admin` command;
permission-matrix harness.
**Done when:** a Gasan validator gets 404 on a Boac farmer, and the matrix passes for all 7 roles.

### M2 — Locations and catalog
Municipalities, barangays, programs, commodities, stages with aliases, varieties, sources, units; seeds;
optional PSGC loader that runs only if a file appears in `data/reference/`.
**Done when:** the cacao configuration is seeded and every reference endpoint matches the contract.

### M3 — Registry and farms
Farmers, associations, members, farms, crop stands, plantings, harvests; trigram duplicate detection, merge,
PII erasure; scope keys kept correct when a farm moves or farmers merge; `integrity` script.
**Done when:** ported tests pass, and the integrity script is clean after merges and moves.

### M4 — Surveys and workflow
Rounds, inventory records, comments, transition services, validation rules, progress, official totals.
**Done when:** every transition in brief §8 is tested, including refusals and audit entries.

### M5 — Imports, including other crops
Normalizers (every messy example in brief §3), catalog-driven workbook adapter, reconciliation, idempotent
commit in one transaction, clean template, error report, personal-data exports.
**Done when:**
- the real file, in the in-memory database, gives 212 named rows, 208 with trees, every per-municipality figure
  in brief §3, 81,712 trees, 130.74 ha and Santa Cruz +940;
- a synthetic second crop with different stages imports with no code change.

### M6 — Analytics, reports, map
KPI pipelines, official Excel and PDF reports, sign-off hash, harvest summary, map config, boundaries, farm
points, boundary loader. `analytics/status` reports when official records last changed, instead of a refresh time.
**Done when:** pipelines equal the live totals for every role's scope, and a signed report regenerates with
the same hash.

### M7 — Frontend and admin screens
Point the frontend at Express, fix contract differences, add admin screens (users and assignments, crops and
stages, varieties and sources, report settings and signatories), add a crop picker on import, remove any
leftover cacao-specific wording.
**Done when:** frontend tests pass, a new crop can be set up and imported from the UI, and the main flows
pass a browser check with synthetic data.

### M8 — Cutover
Confirm inputs 2 and 3, create production indexes, load `data/raw/` into Atlas, check the totals there, create the
real admin account. Serve the built frontend from Express with its own CSP and an HTTPS redirect, replacing the old
web server. Give the application's database user a custom role with no update or delete right on `audit_logs`, which
replaces the old Postgres trigger that kept the audit log append-only. Remove `backend/`, `infra/` and the `Makefile`; update `CLAUDE.md`, `README`, `architecture.md`,
the data dictionary, `.env.example` and CI; merge to `main`.
**Done when:** the clean-clone instructions work without Docker, and Atlas shows 81,712.

After M8, the Docker volume holding the old database (real personal data) should be deleted. That is a separate
decision for the product owner, and it needs Docker one last time.

## Main risks
| Risk | Mitigation |
|---|---|
| Relationships or scope keys drift without foreign keys | Services own all writes; `integrity` script; tests around merges and moves |
| Small differences from Postgres or Python behaviour (rounding, name matching, Excel parsing) | Brief §3 figures as acceptance tests; ported tests; review-list counts compared with the existing real-data tests |
| A query forgets scoping | One scoped query helper, permission matrix, a test that every route has a matrix row |
| Real data reaches Atlas before approval | Real data is loaded only at M8; tests cannot connect to Atlas |
