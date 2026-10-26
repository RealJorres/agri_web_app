# agri-dms

Data management and analytics system for the Provincial Agriculture Office (PAO) of Marinduque.
Farmer-level crop inventories are entered once (office form, Excel template or legacy workbook),
validated by the Municipal Agriculture Office, approved by the province, and every total is computed
from approved records. Cacao (HVCDP) is the first crop; others are added as catalog rows.

- Requirements: [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) · Plan: [`docs/PLAN_PHASE1.md`](docs/PLAN_PHASE1.md)
- How it works: [`docs/architecture.md`](docs/architecture.md) · Tables: [`docs/data-dictionary.md`](docs/data-dictionary.md)
- Decisions: [`docs/decisions/`](docs/decisions/) (ADRs)

> **Personal data (RA 10173).** Source workbooks go in `data/raw/`, the PSGC file in
> `data/reference/`. Both are gitignored and must never be committed; CI rejects tracked
> spreadsheets and scans history for secrets. Tests and demo data are synthetic.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- GNU make. On Windows run `choco install make` and use Git Bash (ADR-0008).
- Node 22 is optional on the host (editor tooling only; everything runs in containers).

## Quick start

```sh
make up          # creates .env from .env.example on first run; starts db, redis, api, worker, frontend
make migrate
make seed        # 6 municipalities + cacao catalog (+ PSGC codes if data/reference/ has the PSA file)
make import-legacy FILE=data/raw/cacao_production_data_as_of_july_2023.xlsx
make superuser   # an admin for Django admin and the app
```

Then open <http://localhost:5173>. Optional: `make seed-demo` creates synthetic data and one user per
role (`*@demo.test`, password = `DEMO_PASSWORD` in `.env`).

| URL | What |
|---|---|
| <http://localhost:5173> | the app (proxies `/api` to the API) |
| <http://localhost:8000/admin/> | Django admin: users, assignments, catalog |
| <http://localhost:8000/api/schema/swagger/> | API docs (dev only) |
| <http://localhost:8000/api/health> | health check (database + Redis) |
| `localhost:5433` | PostgreSQL from the host |

## Commands

| Command | What it does |
|---|---|
| `make test` | backend pytest + frontend Vitest |
| `make coverage` | backend tests and the 85% gate on services/selectors/permissions (DoD) |
| `make lint` | ruff, ruff format check, mypy, ESLint, tsc, Prettier check |
| `make fmt` | auto-format backend and frontend |
| `make schema` | export OpenAPI and regenerate the typed frontend client (commit both) |
| `make docs` | regenerate `docs/data-dictionary.md` from the models |
| `make import-legacy FILE=…` | preview + commit the 2023 workbook, printing the reconciliation |
| `make seed-demo` | synthetic demo users and records (DEBUG only) |
| `make help` | every target |

Single backend test: `docker compose -f infra/docker-compose.yml run --rm api pytest path::name -x`.
Acceptance tests against the real workbook are marked `real_data` and run only when the file is in
`data/raw/`.

## Roles

| Role | Can |
|---|---|
| System admin | everything, including Django admin and data-subject erasure |
| Provincial head | read everything, export personal data |
| Program coordinator | open/close rounds, approve/return/reopen records, merge farmers (own programs) |
| Provincial encoder | create/edit farmers, farms and drafts, submit, run imports |
| MAO validator | validate or return submitted records in their municipality; edit before validating |
| Field encoder | create/edit and submit within assigned barangays |
| Viewer | aggregate figures only (no personal data) |

Users and assignments are managed in Django admin (Users → assignments inline).

## Project layout

```
backend/    Django project (config/, common/, apps/<app>/{models,services,selectors,views,...})
frontend/   React 19 + Vite + TypeScript (src/app, src/features, src/components/ui, src/lib)
infra/      docker-compose.yml
docs/       brief, plan, architecture, data dictionary, ADRs
data/       raw/ and reference/ (gitignored, real files only on PAO machines)
```

Conventions for contributors (and AI assistants) are in [`CLAUDE.md`](CLAUDE.md).
