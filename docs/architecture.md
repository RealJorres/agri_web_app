# Architecture

agri-dms is a Django REST API, a React single-page app and a Celery worker, backed by PostgreSQL/PostGIS
and Redis. Decisions and their reasons are in `docs/decisions/` (ADRs); this page explains how the
pieces fit.

## Components

```
Browser (React SPA) ──/api──▶ Vite dev proxy / Nginx (prod) ──▶ Django + DRF (api)
                                                                 │  │
                                     PostgreSQL 16 + PostGIS ◀───┘  └──▶ Redis ◀── Celery worker (+beat)
                                     (all records, audit log)           (broker, throttles)  imports, file purge
```

- **Same origin** in dev and prod (ADR-0002): the SPA calls `/api/...`; nothing cross-site.
- **Private file storage** (ADR-0009) for uploaded workbooks and error reports, never publicly served;
  files of finished imports are purged after 30 days by a Celery beat task.

## Backend layout and rules

Each app has `models.py`, `services.py` (all writes and business rules), `selectors.py` (reads),
`serializers.py` (shape only), `views.py` (thin: parse → service → serialize), `tests/`.

| App | Holds |
|---|---|
| `accounts` | users (email login), role assignments, JWT cookie auth, `get_scope()` |
| `locations` | municipalities and barangays (PSGC loader, ADR-0005) |
| `catalog` | programs, commodities, growth stages, varieties, sources, units (aliases) |
| `registry` | farmers, associations, memberships; duplicate detection, merge, erasure |
| `farms` | farms, crop stands, plantings (+ varieties) |
| `surveys` | survey rounds, inventory records, stage counts, workflow, validation rules, totals |
| `production` | harvests (API only in Phase 1) |
| `imports` | uploads, legacy 2023 adapter, clean template, reconciliation, exports, Celery tasks |
| `audit` | append-only audit log (ORM guard + database trigger) |
| `common` | BaseModel (UUID, soft delete), scoping, permissions, error contract, schema tweaks |

**Commodity-agnostic.** Stages, varieties, sources, density (plants/ha) and the attribute JSON Schema
are catalog rows. The frontend builds the inventory form from `commodities/{id}/stages`. Adding coffee
means adding catalog rows (admin or `seed_data.py`), not code. The only cacao-specific module is the
reader for the 2023 legacy workbook.

## Access control

```
request ─▶ JWT auth ─▶ HasCapability (role → capability, apps/accounts/roles.py)
                    ─▶ ScopedQuerySetMixin (rows filtered by the user's grants) ─▶ view
service ─▶ require_reach(scope, capability, barangay/municipality/program)  (writes)
```

- A **grant** is one assignment: role + municipality (NULL = all) + program (NULL = all) + optional
  barangays (field encoders). A row is visible when *any* grant with the needed capability covers it.
- Location is always resolved through the barangay (`home_barangay`, `farm__barangay`, …); program
  through the commodity. Rows outside the scope do not exist for the user, so they get **404**.
- Viewers only hold `view_aggregates`: record-level endpoints answer 403 (ADR-0010). Serializers also
  drop personal fields for any role without `view_personal_data`.
- `backend/tests/test_permission_matrix.py` checks every record-level endpoint × role × in/out of scope.

## Inventory workflow

```
            submit (encoder)          validate (MAO validator)      approve (program coordinator)
   draft ─────────────────▶ submitted ─────────────────▶ validated ─────────────────▶ approved
     ▲  ◀──── return* (validator) ───┘                      │                          │
     │  ◀──────────────────── return* (coordinator) ────────┘           close round ──▶ locked
     └──────────────────────────── reopen* (coordinator, version + 1) ◀───────────────────┘
                                                                        * comment required
```

- One transition table in `apps/surveys/services.py`; every transition is row-locked, scope-checked,
  audited and may add a workflow comment. Status is never writable through PATCH.
- Submitting runs `apps/surveys/rules.py`: **errors block** (negative counts, empty record without a
  remark, missing farm barangay); **warnings are stored** in `flags` (outlier above 5× the municipal
  median with at least 5 peers; likely duplicate farmer).
- The API returns `allowed_actions` per record so the UI only shows buttons the user may press; the
  server re-checks everything.

## Official numbers

Totals are **never stored** (brief rule 2.1). `apps/surveys/selectors.py::stage_totals` aggregates
`stage_count` over `approved` + `locked` records at query time, within the caller's scope. Area is
derived as trees ÷ plants per hectare (625 for cacao at 4 × 4 m, ADR-0004).

## Imports

```
upload ─▶ check_upload (ext, 10 MB, zip bomb, no macros, SHA-256) ─▶ ImportJob(uploaded)
       ─▶ Celery preview: read → normalize → plan → reconcile ─▶ job.summary (status ready)
user reviews preview (counts, errors, review list, decisions, reconciliation) ─▶ commit
       ─▶ Celery commit: one transaction, ImportRowLink per source row (idempotent) ─▶ committed
```

- **Legacy 2023 workbook** (ADR-0003, ADR-0013): headers and stages located by content; the TOTAL
  rows' `SUM()` formulas are evaluated by us, so we can show exactly which rows a broken range skips
  (Santa Cruz +940, Mogpog `=SUM(L28)`). Rows above TOTAL become approved historical records; rows
  below TOTAL become drafts (`needs_review`); name-only rows go to the review list.
- **Clean template**: generated from the catalog with dropdowns; imported through the regular services
  (`create_farmer`, `create_record`, `submit`), so it obeys every rule. Records arrive as `submitted`.
- **Exports** (`exports/farmers.xlsx`, `exports/inventory.xlsx`) reuse the list filters, need
  `export_personal_data` and are audited (filters + row count only).

## Authentication

- Access token (15 min) in the SPA's memory only. Refresh token (7 days) in an httpOnly, Secure,
  SameSite=Lax cookie with path `/api/v1/auth/`. Login/refresh/logout require the CSRF token
  (double submit) and a same-origin `Origin`.
- Refresh tokens are single-use: reusing a rotated token revokes all of the user's sessions (theft
  detection). The SPA serializes refreshes across tabs with the Web Locks API so legitimate
  concurrency never looks like theft.
- django-axes locks an email + IP pair after 5 failures for 15 minutes; DRF throttles login and uploads.

## Audit and privacy

- `audit_auditlog` is append-only: the ORM refuses updates/deletes and a PostgreSQL trigger blocks
  them too. Users with history are deactivated, never deleted.
- Personal values never enter the log: changed personal fields appear as `[personal]` (ADR-0006).
- An RA 10173 erasure request is served by `erase_farmer_personal_data` (system admin only), which
  blanks PII and keeps anonymous inventory history.

## Frontend

`src/app` (router, shell, guards), `src/features/*` (pages, hooks, per-feature API calls),
`src/components/ui` (accessible primitives: fields with aria wiring, native `<dialog>` modal and
drawer, server-side DataTable), `src/lib` (generated API client, auth, formatting). Server state lives
in TanStack Query; table state lives in the URL. Types come from the OpenAPI schema (ADR-0011) and
CI fails if the committed schema drifts.

## Ready for later phases

- **Analytics** (Phase 2): `stage_totals` is the query a materialized view per round × barangay × stage
  would replace; KPI endpoints can reuse `scope_q`.
- **GIS**: `municipality.boundary`, `barangay.boundary` (MultiPolygon) and `farm.location` (Point) exist.
- **Reports / PDF**: the reconciliation and totals selectors already produce the official tables.
- **Offline field app**: services are the single write path, so a sync endpoint can reuse them.
