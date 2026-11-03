# ADR-0019: Move to the MERN stack (MVC) on MongoDB Atlas, without Docker
Status: Accepted · 2026-11-03 · Decided by the product owner, who also approved the design below.

**Context.** The product owner does not want to run or use Docker on this project and wants the
system built with MongoDB, Express, React and Node in an MVC structure, using a hosted MongoDB
database they will provide. Data comes from the raw workbook as provided. Other crops with the same
workbook structure will be added later.

**Decision.** Replace the Django backend with Node 22 + Express 5 + Mongoose in TypeScript. Keep the
React frontend and keep the `/api/v1` contract. Run everything directly on the host with npm scripts.

This supersedes brief §4 and §5 (stack and layout) and the Docker/Makefile parts of §13-14. The brief's
goal, rules, data model, roles, workflow, API, import behaviour and acceptance numbers still apply.

## Consequences that shape the design

| Topic | Django/Postgres today | MERN decision | Why |
|---|---|---|---|
| Layout | apps with services/selectors | `server/src/{models,controllers,routes,services,selectors,middleware,validators}`; React in `frontend/` is the View | Recognisable MVC. Rules stay in services, so controllers stay thin |
| Primary keys | UUID | UUID strings as `_id` | Brief §4, and the frontend treats ids as strings |
| References | Foreign keys | One collection per brief table, except embedded stage counts on the inventory record and variety ids on the planting. Services check references and block deletes in use. An `integrity` script reports orphans | MongoDB has no foreign keys, so the code must enforce them |
| Atomic writes | `transaction.atomic()` | MongoDB transactions, always including the audit entry | Rule 5. Atlas clusters are replica sets, so transactions are available |
| Scoping | Joins through farm to barangay | Copied `barangayId`, `municipalityId`, `programId` on farm-dependent documents, maintained by services in the same transaction (for example on farm move or merge) | Filters cannot join. These are location keys, not totals, so rule 1 holds |
| Soft delete | `deleted_at` + partial unique indexes | `isDeleted` + `deletedAt`, with partial unique indexes on `isDeleted: false` | Same behaviour |
| Totals | Materialized views + refresh | Aggregation pipelines run per request | Never stored, and fast enough at this data size. `analytics/status` changes meaning (see plan) |
| Money, area, quantities | `Decimal` | Integer counts; `decimal.js` with half-up rounding at the edges; `Decimal128` where stored | 130.74 ha and sign-off hashes must not drift |
| Duplicate search | `pg_trgm` | The same trigram similarity in TypeScript, over candidates in the municipality; thresholds unchanged (ADR-0007) | No Atlas Search dependency, and small data |
| Background jobs | Celery + Redis | In-process jobs with status in `import_jobs` | Imports are small; removes Redis. Revisit if files grow |
| Excel | openpyxl | `exceljs`, reading both formulas and cached values, with the existing upload safety limits | Santa Cruz +940 depends on seeing the SUM ranges |
| PDF | WeasyPrint | `pdfkit` with fixed metadata | No browser or native install; a signed report must regenerate identically |
| Auth | simplejwt, axes, argon2 | `jose`, `argon2`, a lockout collection, refresh-token blacklist with TTL index; same cookie and CSRF flow | Brief §9 and §12 unchanged |
| GIS | PostGIS, GDAL | GeoJSON with `2dsphere` indexes, `proj4` and `shapefile` for input, Turf for simplifying. Invalid shapes are reported, not repaired | No GEOS `make_valid`, and MongoDB rejects self-intersecting polygons. ADR-0016 otherwise stands |
| Admin | Django admin | New admin screens in React for users, assignments, catalog, report settings and signatories | Django admin goes away. Adding a crop must not need a developer |
| API types | Generated from drf-spectacular | `frontend/openapi.json` becomes the maintained contract; contract tests check Express responses against it | The frontend's typed client keeps working |
| Tests | pytest, factory_boy | Vitest, supertest, `mongodb-memory-server` | No Docker, and tests never touch Atlas: test setup refuses a `mongodb+srv` URI |

## Adding crops without code
The legacy adapter becomes a **workbook adapter driven by the catalog**. An upload names a commodity;
stage columns are matched from the sub-header row to that commodity's growth stages and their aliases,
and density comes from the commodity. Layout assumptions (municipal sheets, header row, TOTAL row,
SUMMARY sheet) stay as in brief §3. Anything unrecognised goes to the review list; nothing is guessed.
Proof: a synthetic second crop with different stages must import with no code change.

## Personal data on Atlas (RA 10173)
Moving to a hosted database sends real farmer data to a third-party cloud when the workbook is loaded.
The PAO, as the organisation responsible for this data, should know about this and approve it. Minimum settings: a region close to the Philippines,
an IP access list rather than open access, a dedicated least-privilege database user, TLS, and backups
confirmed for the chosen tier. The connection string lives only in `.env`. Development and production use
separate databases. Real data is loaded once, at cutover, from `data/raw/`; nothing is copied from
the old Postgres database.

## Costs accepted
- A rewrite of about 11,000 lines of backend code and its tests, with no new features meanwhile.
- MongoDB no longer guards relationships, so integrity depends on services, tests and the `integrity` script.
- Database access depends on an internet connection, including for development. P2-M6 (offline field
  app) still works for field users through its own device storage, but the office system needs a connection.

## ADRs affected
Superseded: 0008 (make on Windows), 0012 (toolchain pins), 0014 (materialized views).
Amended: 0007 (implementation), 0011 (client generated from the maintained contract), 0015 (PDF library),
0016 (loader). Unchanged in intent: 0002-0006, 0009, 0010, 0013, 0017, 0018.
