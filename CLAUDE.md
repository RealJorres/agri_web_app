# CLAUDE.md — agri-dms

Marinduque Agri Data Management & Analytics System for the Provincial Agriculture Office (PAO).
Full requirements: `docs/PROJECT_BRIEF.md` (source of truth for what it does; ADR-0019 supersedes its
stack and layout sections). Decisions: `docs/decisions/` (ADRs). How it fits together:
`docs/architecture.md`. Going live: `docs/deployment.md`.

## What it is
One commodity-agnostic system replacing Excel crop inventories. Farmer-level records are entered once
(office form, field app, or Excel import) → validated by the MAO → approved by the province. Every
summary/report is computed from approved records. Cacao (HVCDP) first; other crops are catalog rows,
not new code.

## Non-negotiable rules
1. **Never store totals.** Summaries are queries over approved records. (Derived values such as
   area-from-tree-count are computed, not stored — ADR-0004.)
2. **Personal data is protected (RA 10173).** Never commit `data/raw/`, `data/reference/`, `.env`,
   `private_files/`, uploaded files, or any real personal data. Tests, fixtures, seeds and demo data use
   SYNTHETIC names only. Never print real farmer data in logs, test output, commit messages or chat.
3. **Server-side scoping on every query** by role + assignment (municipality/program/barangay), through
   `lib/scoping.ts`. Combine filters with `within(scope, ...conditions)`, never by spreading a scope
   filter. The frontend is never an access-control layer. Out-of-scope objects return **404**, not 403.
4. **Business rules live in `services/`** (writes) and `selectors/` (reads) — never in controllers,
   validators, routes or model hooks. Controllers are thin: parse → call service → shape the response.
5. **Audit log** every state change, approval, delete, merge and personal-data export
   (`services/audit.service.ts`, called from services, inside the same transaction).
6. **No secrets in code.** Settings come from env vars through `config/env.ts`; keep `.env.example`
   current. The connection string belongs in `.env`, never in chat or git.
7. **Small conventional commits** (`feat(registry): ...`, `fix(imports): ...`, `test:`, `docs:`,
   `chore:`). Tests + lint must pass before every commit.

## Tech stack (ADR-0019)
- Server: Node 22, Express 5, Mongoose 9, TypeScript strict (NodeNext ESM, `.js` import suffixes), zod,
  argon2, jsonwebtoken, multer, helmet, exceljs, pdfkit, proj4, shapefile, decimal.js.
- Database: MongoDB Atlas. UUID strings as `_id`. Transactions need a replica set.
- Frontend: React 19, Vite, TypeScript strict, Tailwind v4, React Router, TanStack Query v5 + Table v8,
  React Hook Form + Zod, API client generated from `frontend/openapi.json` (`openapi-typescript` +
  `openapi-fetch`).
- Tooling: npm workspaces, ESLint + Prettier, Vitest + supertest + `mongodb-memory-server`, Testing
  Library, GitHub Actions. **No Docker.**

## Folder layout (MVC)
```
server/src/   models/ controllers/ routes/ services/ selectors/ middleware/ validators/ lib/ config/
server/scripts/   seed, seed-psgc, seed-boundaries, import-workbook, create-admin, create-indexes,
                  db-role, integrity, data-dictionary, dev-memory
server/tests/     Vitest; tests/support/ has factories, the contract check and the synthetic workbook
frontend/src/     app, features/<feature>, components/ui, lib
frontend/openapi.json   the maintained API contract; server tests check responses against it
docs/             PROJECT_BRIEF.md, architecture.md, deployment.md, data-dictionary.md, decisions/
data/raw/         (gitignored) source workbooks — READ-ONLY, never modify
data/reference/   (gitignored) PSGC and boundary files from the PAO
private_files/    (gitignored) uploads and error reports; they hold personal data
```

## Commands (from the repo root)
```
npm ci                          install
npm run dev:memory              app on a throwaway local database, with a generated admin password
npm run dev                     app on the database in .env (that is Atlas: mind what you run)
npm test                        server and frontend tests (never touch Atlas)
npm run lint                    ESLint, tsc and the Prettier check, on both workspaces
npm run fmt                     Prettier on both workspaces
npm run build                   server and frontend (deployed to Render and Netlify, ADR-0023)
npm run gen:api -w frontend     regenerate schema.d.ts after changing frontend/openapi.json
npm run data-dictionary -w server   regenerate docs/data-dictionary.md after changing a model
npm run seed -w server          municipalities and catalog [+ PSGC if data/reference/ has it]
npm run import-workbook -w server -- <file>   preview and commit a workbook
npm run integrity -w server     check references between documents
npm run seed-demo -w server     rebuild the synthetic agri_demo database (needs MONGODB_DB=agri_demo)
```
Single test: `cd server && npx vitest run tests/farms.test.ts -t "name"`. Tests needing the real
workbook skip themselves when `data/raw/` is absent.

**`.env` points at Atlas.** `npm run dev`, `seed` and `import-workbook` act on it. Use `dev:memory` for
trying things. Real data goes to Atlas only as `docs/deployment.md` describes, after PAO approval.

## Coding conventions
- TypeScript: Prettier (line 100), no `any`. Services take a keyword-style input object with an actor,
  wrap writes in `inTransaction`, and throw `DomainError(code, message, fields, status)`, rendered as
  `{code, message, fields}`.
- Load documents inside the transaction callback, because the driver may retry it. `inTransaction` joins
  an outer transaction. Call `lockForWrite(parent)` before inserting a child, since MongoDB has no foreign
  keys. Transactions abort at 60 s, so bulk-write large commits (ADR-0020).
- Workflow state changes only through `services/surveyWorkflow.ts`. Status is not writable through a
  generic update.
- Every route is declared in a route table with who may call it (`routes/registry.ts`), using capabilities
  from `lib/roles.ts`, never role names. Every new route gets a row or a stated exemption in
  `server/tests/permissionMatrix.test.ts`, and an entry in `frontend/openapi.json`.
- A new collection must also be added to the Atlas role (ADR-0022): `npm run db-role -w server` shows it.
- Soft-deleted documents are hidden by the `softDelete` plugin. Aggregations must match
  `isDeleted: false` themselves. Unique indexes use `uniqueAmongAlive`.
- Public catalog routes never expose aliases; those are on admin routes only.
- Catalog-driven, not crop-specific: never hard-code "cacao", stage codes or 625 outside seeds, the
  legacy-workbook adapter, and tests.
- Factories use obviously synthetic data (surnames "Sample<n>"). The synthetic workbook in
  `tests/support/workbookFixture.ts` mirrors every defect in brief §3.
- Look and feel (ADR-0024): use the tokens in `index.css`, `surface-card`, and `components/ui`. Text on dark green
  surfaces is `brand-200` or lighter, to keep WCAG AA.
- Frontend: feature folders own their pages/components/hooks/api; shared UI in `components/ui`; server
  state only in TanStack Query; forms with RHF + Zod; no `any`; access token in memory only.
- Write an ADR (`docs/decisions/NNNN-title.md`) for any significant or brief-deviating decision.
- Windows: to stop a dev server you started, find it by port and verify its command line. Awaiting a
  supertest request runs it, so add `.attach` before awaiting `signedIn(...)`.
