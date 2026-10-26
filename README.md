# agri-dms

Data management and analytics system for the Provincial Agriculture Office (PAO) of Marinduque.
Farmer-level crop inventories are entered once, validated by the MAO, approved by the province, and
every summary is computed from those records. Cacao (HVCDP) is the first commodity.

Requirements: `docs/PROJECT_BRIEF.md` · Plan: `docs/PLAN_PHASE1.md` · Decisions: `docs/decisions/`

> **Personal data (RA 10173).** Source workbooks go in `data/raw/` and the PSGC file in
> `data/reference/`. Both are gitignored and must never be committed.

## Prerequisites
- Docker Desktop (or Docker Engine + Compose v2)
- GNU make. On Windows: `choco install make`, then run commands from Git Bash.
- Node 22 (optional on the host, for editor tooling)

## Quick start
```sh
make up        # creates .env from .env.example on first run, starts all services
make migrate
make seed      # available from M3
```
- API health: http://localhost:8000/api/health
- Frontend: http://localhost:5173 (proxies `/api` to the API)
- API docs (dev only): http://localhost:8000/api/schema/swagger/
- Postgres from the host: `localhost:5433`

## Common commands
| Command | What it does |
|---|---|
| `make test` | backend pytest (with coverage) + frontend Vitest |
| `make lint` | ruff, mypy, ESLint, tsc, Prettier check |
| `make fmt` | auto-format backend and frontend |
| `make schema` | export OpenAPI and regenerate the typed frontend client |
| `make import-legacy FILE=data/raw/<file>.xlsx` | import the 2023 cacao workbook (M6) |
| `make help` | list all targets |

`node_modules` for the frontend container lives in a named volume. After `frontend/package.json`
changes, refresh it with `docker compose -f infra/docker-compose.yml run --rm --no-deps frontend npm ci`
(avoid `down -v`, which also deletes the database volume).
