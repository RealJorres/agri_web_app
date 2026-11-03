# Architecture

agri-dms is an Express API and a React single-page app, on MongoDB Atlas, in an MVC structure with no
Docker (ADR-0019). Decisions and their reasons are in `docs/decisions/` (ADRs); this page explains how the
pieces fit.

## Components

```
Browser (React SPA) ──/api──▶ Vite dev proxy (dev)  ──▶ Express API ──▶ MongoDB Atlas
                              Netlify proxy (prod)        │               (all records, audit log, logo)
                                                          └──▶ private disk (uploads, error reports)
```

- **Same origin** in dev and prod (ADR-0002): the SPA calls `/api/...`; nothing cross-site. In production
  Netlify hosts the built frontend and forwards `/api` to the API on Render (ADR-0023).
- **Private file storage** (ADR-0009) for uploaded workbooks and error reports, never publicly served;
  files of finished imports are purged after 30 days by a timer in the server.
- **Background work** (import previews and commits) runs in the same process. If the server restarts
  mid-job, the job is marked failed at the next start (ADR-0020).

## Server layout

`server/src` is MVC, with reads and writes kept apart:

| Folder | Holds |
|---|---|
| `models/` | Mongoose schemas (the M). No business rules |
| `controllers/` | thin: parse with a validator → call a service or selector → shape the response (the C). React is the V |
| `routes/` | route tables, where every route states who may call it |
| `services/` | all writes and business rules |
| `selectors/` | all reads, always scoped |
| `validators/` | zod shapes for request bodies and queries |
| `middleware/` | auth, CSRF, throttling, security headers, serving the app, errors |
| `lib/` | scoping, roles, decimals, transactions, fuzzy matching, private files |

| Area | Models, services and selectors |
|---|---|
| Accounts | users (email login), role assignments, JWT cookie auth, `getScope()`; admin screens |
| Locations | municipalities and barangays (PSGC loader, ADR-0005), boundaries (ADR-0016) |
| Catalog | programs, commodities, growth stages, varieties, sources, units (aliases); admin screens |
| Registry | farmers, associations, memberships; duplicate detection, merge, erasure |
| Farms | farms, crop stands, plantings |
| Surveys | survey rounds, inventory records, stage counts, workflow, validation rules, totals |
| Production | harvests |
| Imports | uploads, the workbook adapter, clean template, reconciliation, exports |
| Analytics and reports | dashboards, official reports, sign-off, map |
| Audit | append-only log (ADR-0022) |

**Commodity-agnostic.** Stages, varieties, sources, density (plants/ha) and the attribute JSON Schema are
catalog rows, kept in the app under **Crops** (ADR-0021). The frontend builds the inventory form from
`commodities/{id}/stages`. Adding coffee means adding rows, not code. A workbook in the same layout imports
for any tree crop, with stage columns matched by name and alias.

**No foreign keys.** MongoDB does not enforce references. Services own every write, and copy location and
program keys (`barangayId`, `municipalityId`, `programId`) onto records so that scoping needs no joins.
`lockForWrite(parent)` makes "the parent still exists" and "it has no children" checks conflict in
concurrent transactions. `npm run integrity -w server` checks all of it.

## Access control

```
request ─▶ JWT auth ─▶ capability on the route (role → capability, lib/roles.ts)
                    ─▶ selector filters by the user's grants (lib/scoping.ts) ─▶ response
service ─▶ requireReach(scope, capability, barangay/municipality/program)  (writes)
```

- A **grant** is one assignment: role + municipality (null = all) + program (null = all) + optional
  barangays (field encoders). A row is visible when *any* grant with the needed capability covers it.
- Rows outside the scope do not exist for the user, so they get **404**.
- Viewers only hold `view_aggregates`: record-level endpoints answer 403 (ADR-0010). Responses also drop
  personal fields for any role without `view_personal_data`.
- `server/tests/permissionMatrix.test.ts` checks every record-level endpoint × role × in/out of scope, and
  fails if a route has neither a row nor a stated exemption.

## Inventory workflow

```
            submit (encoder)          validate (MAO validator)      approve (program coordinator)
   draft ─────────────────▶ submitted ─────────────────▶ validated ─────────────────▶ approved
     ▲  ◀──── return* (validator) ───┘                      │                          │
     │  ◀──────────────────── return* (coordinator) ────────┘           close round ──▶ locked
     └──────────────────────────── reopen* (coordinator, version + 1) ◀───────────────────┘
                                                                        * comment required
```

- One transition table in `services/surveyWorkflow.ts`; every transition is transactional, scope-checked,
  audited and may add a workflow comment. Status is never writable through an update.
- Submitting runs `services/surveyRules.ts`: **errors block** (negative counts, empty record without a
  remark, missing farm barangay); **warnings are stored** in `flags` (outlier above the crop's multiplier
  times the municipal median, with at least 5 peers; likely duplicate farmer).
- The API returns `allowed_actions` per record so the UI only shows buttons the user may press; the server
  re-checks everything.

## Official numbers

Totals are **never stored** (brief rule 2.1). They are aggregated at query time over `approved` + `locked`
records, within the caller's scope (`selectors/analytics.selectors.ts`, `selectors/survey.selectors.ts`).
Area is derived as trees ÷ plants per hectare (ADR-0004), with exact decimal arithmetic. Reports are built
from the same figures, and a sign-off stores a hash of the report's content, so it shows as superseded if
the content changes (ADR-0015).

## Imports

```
upload ─▶ checkUpload (ext, 10 MB, zip bomb, no macros, SHA-256) ─▶ ImportJob(uploaded)
       ─▶ background preview: read → normalize → plan → reconcile ─▶ job.summary (status ready)
user reviews preview (counts, errors, review list, decisions, reconciliation) ─▶ commit
       ─▶ background commit: ImportRowLink per source row (idempotent) ─▶ committed
```

- **Existing workbooks** (ADR-0003, ADR-0013, ADR-0020): headers and stages located by content; the TOTAL
  rows' `SUM()` formulas are evaluated by us, so we can show exactly which rows a broken range skips. Rows
  above TOTAL become approved historical records; rows below TOTAL become drafts; name-only rows go to the
  review list. Spellings match the catalog exactly and are never guessed.
- **Clean template**: generated from the catalog with dropdowns; imported through the regular services, so
  it obeys every rule. Records arrive as `submitted`.
- **Exports** reuse the list filters, need `export_personal_data` and are audited (filters + row count
  only).

## Authentication

- Access token (15 min) in the SPA's memory only. Refresh token (7 days) in an httpOnly, Secure,
  SameSite=Lax cookie with path `/api/v1/auth/`. Login/refresh/logout require the CSRF token (double
  submit) and a same-origin `Origin`.
- Refresh tokens are single-use: reusing a rotated token revokes all of the user's sessions (theft
  detection). The SPA serializes refreshes across tabs with the Web Locks API so legitimate concurrency
  never looks like theft.
- An email + address pair locks after 5 failures for 15 minutes, and sign-in and uploads are throttled.

## Audit and privacy

- `audit_logs` is append-only, enforced by the application account's database role (ADR-0022). Users with
  history are deactivated, never deleted.
- Personal values never enter the log: changed personal fields appear as `[personal]` (ADR-0006).
- An RA 10173 erasure request is served by a service that blanks personal data and keeps anonymous
  inventory history. It has no screen yet, pending the PAO's decision.

## Frontend

`src/app` (router, shell, guards), `src/features/*` (pages, hooks, per-feature API calls),
`src/components/ui` (accessible primitives: fields with aria wiring, native `<dialog>` modal and drawer,
server-side DataTable), `src/lib` (generated API client, auth, formatting). Server state lives in TanStack
Query; table state lives in the URL. Types are generated from `frontend/openapi.json`, which is maintained
by hand. Server tests check real responses against it, and CI fails if the generated types drift.

## Tests

`npm test` needs no database or `.env`: the server's tests run on an in-memory replica set, and refuse any
non-local address. Acceptance tests run the real workbook when it is present, and skip otherwise.
