# agri-dms

Data management and analytics system for the Provincial Agriculture Office (PAO) of Marinduque.
Farmer-level crop inventories are entered once (office form, Excel template or an existing workbook),
validated by the Municipal Agriculture Office, approved by the province, and every total is computed
from approved records. Cacao (HVCDP) is the first crop; others are added as catalog rows.

Built with MongoDB, Express, React and Node in an MVC structure, with no Docker (ADR-0019).

- Requirements: [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md)
- How it works: [`docs/architecture.md`](docs/architecture.md) · Collections: [`docs/data-dictionary.md`](docs/data-dictionary.md)
- Going live: [`docs/deployment.md`](docs/deployment.md) · Decisions: [`docs/decisions/`](docs/decisions/)

> **Personal data (RA 10173).** Source workbooks go in `data/raw/`, the PSGC and boundary files in
> `data/reference/`, and uploads land in `private_files/`. All are gitignored and must never be
> committed; CI rejects tracked spreadsheets and scans history for secrets. Tests and demo data are
> synthetic.

## Quick start

You need Node 22. Nothing else: this runs on a temporary local database that is thrown away on exit.

```sh
npm ci
npm run dev:memory
```

Open <http://localhost:5173>. The console prints an administrator's email and a generated password. The
first run downloads a MongoDB binary, so it takes a little longer.

To work against a hosted database instead, copy `.env.example` to `.env`, set `MONGODB_URI`, then:

```sh
npm run create-indexes -w server
npm run seed -w server
npm run create-admin -w server -- you@example.gov.ph
npm run dev
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | server and frontend tests. They never touch the database in `.env` |
| `npm run lint` | ESLint, type checks and the Prettier check |
| `npm run fmt` | format everything |
| `npm run build`, `npm start` | build, then run in production (see `docs/deployment.md`) |
| `npm run seed -w server` | municipalities and the crop catalog, plus PSGC codes if `data/reference/` has the file |
| `npm run seed-boundaries -w server` | load boundaries from a file the PAO supplies (ADR-0016) |
| `npm run import-workbook -w server -- <file>` | preview and commit a workbook, printing the reconciliation |
| `npm run integrity -w server` | check references between documents |
| `npm run gen:api -w frontend` | regenerate API types after changing `frontend/openapi.json` |
| `npm run data-dictionary -w server` | regenerate `docs/data-dictionary.md` after changing a model |

Acceptance tests against the real workbook run only when the file is in `data/raw/`.

## Roles

| Role | Can |
|---|---|
| System admin | everything, including users, crops, report settings and data-subject erasure |
| Provincial head | read everything, export personal data, sign reports |
| Program coordinator | open/close rounds, approve/return/reopen records, merge farmers (own programs) |
| Provincial encoder | create/edit farmers, farms and drafts, submit, run imports |
| MAO validator | validate or return submitted records in their municipality; edit before validating |
| Field encoder | create/edit and submit within assigned barangays |
| Viewer | aggregate figures only (no personal data) |

Users, roles and crops are managed in the app, under **Users** and **Crops** (ADR-0021).

## Project layout

```
server/     Express API (src/models, controllers, routes, services, selectors, ...; scripts; tests)
frontend/   React 19 + Vite + TypeScript (src/app, src/features, src/components/ui, src/lib)
docs/       brief, architecture, deployment, data dictionary, ADRs
data/       raw/ and reference/ (gitignored, real files only on PAO machines)
```

Conventions for contributors (and AI assistants) are in [`CLAUDE.md`](CLAUDE.md).
