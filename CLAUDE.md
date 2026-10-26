# CLAUDE.md — agri-dms

Marinduque Agri Data Management & Analytics System for the Provincial Agriculture Office (PAO).
Full requirements: `docs/PROJECT_BRIEF.md` (source of truth — re-read it at the start of a milestone).
Decisions: `docs/decisions/` (ADRs). Phase 1 plan: `docs/PLAN_PHASE1.md`.

## What it is
One commodity-agnostic system replacing Excel crop inventories. Farmer-level records are entered once
(office form, field app, or Excel import) → validated by the MAO → approved by the province. Every
summary/report is computed from approved records. Cacao (HVCDP) first; other crops are catalog rows,
not new code.

## Non-negotiable rules
1. **Never store totals.** Summaries are queries/views over approved records. (Derived values such as
   area-from-tree-count are computed, not stored — ADR-0004.)
2. **Personal data is protected (RA 10173).** Never commit `data/raw/`, `data/reference/`, `.env`,
   uploaded files, or any real personal data. Tests, fixtures, seeds and demo data use SYNTHETIC
   names only. Never print real farmer data in logs, test output, commit messages or chat.
3. **Server-side scoping on every query** by role + assignment (municipality/program/barangay),
   via `common.scoping.ScopedQuerySetMixin`. The frontend is never an access-control layer.
   Out-of-scope objects return **404**, not 403.
4. **Business rules live in `services.py`** (writes) and `selectors.py` (reads) — never in views,
   serializers, model `save()`, or signals. Views are thin: parse → call service → serialize.
   (Only mechanical derived columns such as `normalized_name` may be set in `save()`.)
5. **Audit log** every state change, approval, delete, merge and personal-data export
   (`apps.audit.services.record(...)`, called from services, inside the same transaction).
6. **No secrets in code.** Settings read env vars via django-environ; keep `.env.example` current.
7. **Small conventional commits** (`feat(registry): ...`, `fix(imports): ...`, `test:`, `docs:`,
   `chore:`). Tests + lint must pass before every commit.

## Tech stack
- Backend: Python 3.12, Django 5.2 LTS, DRF, drf-spectacular, django-filter, simplejwt, django-axes,
  argon2-cffi, django-environ, django-cors-headers, psycopg 3, Celery 5 + Redis 7, openpyxl + pandas,
  rapidfuzz. Deps via **uv** + `backend/pyproject.toml`.
- DB: PostgreSQL 16 + PostGIS (GeoDjango), `pg_trgm`. UUID primary keys everywhere.
- Frontend: React 19, Vite, TypeScript strict, Tailwind v4, React Router, TanStack Query v5 +
  Table v8, React Hook Form + Zod, API client generated from OpenAPI (`openapi-typescript` +
  `openapi-fetch`). Node 22, npm.
- Tooling: Docker Compose, Makefile, ruff, mypy, ESLint + Prettier, pytest + pytest-django +
  factory_boy, Vitest + Testing Library, GitHub Actions.

## Folder layout
The repo root is this directory (the brief's `agri-dms/`).
```
backend/
  config/settings/{base,dev,prod,test}.py, urls.py, celery.py, wsgi.py
  common/        BaseModel (UUID, timestamps, created_by/updated_by, soft delete), scoping,
                 permissions, pagination, exception handler
  apps/{accounts,locations,catalog,registry,farms,surveys,production,imports,audit}/
       models.py serializers.py views.py urls.py filters.py permissions.py
       services.py selectors.py admin.py tests/
  tests/         cross-app tests (permission matrix, acceptance import tests)
frontend/src/{app,features,components/ui,lib}
infra/           docker-compose.yml, scripts/
docs/            PROJECT_BRIEF.md, architecture.md, data-dictionary.md, decisions/
data/raw/        (gitignored) source workbooks — READ-ONLY, never modify
data/reference/  (gitignored) PSGC file from the PAO
```

## Commands
All dev runs through Docker (GeoDjango needs GDAL/GEOS; do not try to run Django on the Windows host).
`make` is required (Windows: `choco install make`, run from Git Bash) — see ADR-0008.
```
make up / make down            start / stop db, redis, api, worker, frontend
make migrate                   apply migrations
make seed                      municipalities + catalog (cacao) [+ PSGC if data/reference/ present]
make seed-demo                 synthetic demo data
make import-legacy FILE=data/raw/cacao_production_data_as_of_july_2023.xlsx
make test                      backend pytest (+ coverage) and frontend vitest
make lint                      ruff check, ruff format --check, mypy, eslint, tsc --noEmit
make fmt                       ruff format + ruff check --fix, prettier --write
make schema                    export OpenAPI → regenerate frontend/src/lib/api/schema.d.ts
```
Backend only: `docker compose -f infra/docker-compose.yml run --rm api uv run pytest path::test -x`
Tests needing the real workbook are marked `@pytest.mark.real_data` and auto-skip when
`data/raw/` is absent.

## Coding conventions
- Python: ruff (line 100), full type hints in `services.py`/`selectors.py` (mypy strict there).
  Services take keyword-only args and an explicit `actor: User`; wrap writes in
  `transaction.atomic()`; raise `common.exceptions.DomainError(code, message, fields)` for rule
  violations (rendered as `{code, message, fields}`).
- Workflow state changes only via `apps.surveys.services` transition functions — status is
  read-only in serializers; no generic PATCH of `status`.
- Every record-level viewset inherits `ScopedQuerySetMixin` (set `scope_barangay_path` /
  `scope_municipality_path` / `scope_program_path`) and uses `common.permissions.HasCapability`
  (capabilities in `apps/accounts/roles.py`, never role-name checks). Every new endpoint gets an
  `Endpoint` row in `backend/tests/test_permission_matrix.py`.
- Soft-deleted rows are excluded by the default manager; uniqueness constraints are partial
  (`condition=Q(deleted_at__isnull=True)`).
- Catalog-driven, not crop-specific: never hard-code "cacao", stage codes or 625 outside seeds,
  the legacy-import adapter, and tests.
- Factories (`factory_boy`) use Faker with fixed seeds and obviously synthetic data.
- Frontend: feature folders own their pages/components/hooks/api; shared UI in `components/ui`;
  server state only in TanStack Query; forms with RHF + Zod; no `any`; access token in memory only.
- Write an ADR (`docs/decisions/NNNN-title.md`) for any significant or brief-deviating decision.
