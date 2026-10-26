# Phase 0 + Phase 1 implementation plan

Status: **approved** 2026-10-26 (recommendations for open decisions 1–5 accepted). Each milestone ends with `make lint && make test` green and
one or more conventional commits. Open decisions are listed at the end; they block only the
milestone named.

## Phase 0 — groundwork (done in this session, docs only)
- [x] `docs/PROJECT_BRIEF.md` (verbatim), `CLAUDE.md`, `.gitignore` (data/raw, data/reference, .env,
      media, *.xlsx/*.csv), ADRs 0001–0011, this plan, `git init`.
- [ ] Workbook inspection — **blocked**: `data/raw/cacao_production_data_as_of_july_2023.xlsx` is not
      present. Done as step M6.0 (or earlier, as soon as the file is placed).
- [ ] Prerequisites on the dev machine: start Docker Desktop; `choco install make` (ADR-0008);
      `pip install uv` optional for IDE type-checking.

## M1 — Scaffold
_Done 2026-10-26._
1. `.gitattributes` (LF), `.editorconfig`, root `Makefile`, `.env.example`, `README.md` stub.
2. `backend/pyproject.toml` (uv, Python 3.12 pinned, deps from brief §4; dev group: pytest,
   pytest-django, pytest-cov, factory_boy, ruff, mypy, django-stubs, djangorestframework-stubs).
   `uv.lock` committed.
3. `backend/Dockerfile` (python:3.12-slim + GDAL/GEOS/PROJ libs, uv, non-root user).
4. `config/settings/{base,dev,prod,test}.py` via django-environ; `config/celery.py`; `urls.py` with
   `/api/v1/` router, `/api/health` (checks DB + Redis), `/api/schema/` (+ Swagger UI only when
   `DEBUG`). Custom exception handler → `{code, message, fields}`. Page-number pagination size 50.
5. Migration 0001 in `common` enabling `postgis` and `pg_trgm` extensions.
6. `infra/docker-compose.yml`: `db` (postgis/postgis:16-3.4, healthcheck, named volume), `redis:7`,
   `api` (runserver), `worker` (celery), `frontend` (Vite dev, proxies `/api` — ADR-0002).
7. Frontend scaffold: Vite + React 19 + TS strict + Tailwind v4 + ESLint (flat config) + Prettier +
   Vitest + Testing Library; one smoke test.
8. `.github/workflows/ci.yml`: backend job (postgis service container; ruff check/format --check,
   mypy, pytest) and frontend job (npm ci, eslint, tsc --noEmit, vitest, build). Plus a job that
   fails if any `.xlsx`/`.csv` or `data/` path is tracked.
9. Tests: health endpoint, settings smoke test (prod settings refuse DEBUG / missing SECRET_KEY).
Commits: `chore: scaffold backend`, `chore: scaffold frontend`, `chore(infra): docker compose and makefile`, `ci: add github actions`.

## M2 — Accounts, auth, scoping
_Done 2026-10-26. Note: the `Municipality`, `Barangay` and `Program` models were created here (assignments
need them as FKs); M3 adds their seeds, admin polish and APIs._
1. `common/models.py`: `BaseModel` (UUID pk, created/updated at/by, soft delete; managers — ADR-0006),
   `common/exceptions.py` `DomainError`.
2. `accounts`: custom `User` (email login, Argon2 first in `PASSWORD_HASHERS`), `Role` choices,
   `UserRole` (user may hold several roles), `UserAssignment(user, role, municipality?, program?,
   barangays M2M)`. Admin for users/assignments.
3. `accounts/selectors.py`: `get_scope(user) -> Scope` (dataclass: all_municipalities flag,
   municipality ids, program ids, barangay ids, capabilities). Cached per request.
4. `common/scoping.py`: `ScopedQuerySetMixin` — each viewset declares `scope_barangay_path`
   (e.g. `"home_barangay"`, `"farm__barangay"`, `"crop_stand__farm__barangay"`) and optionally
   `scope_program_path`; mixin filters `…__municipality__in` / `…__in` barangays / program.
   Out-of-scope → 404. `common/permissions.py`: capability-based DRF permission classes.
5. Auth endpoints: login (sets refresh cookie: httpOnly, Secure, SameSite=Lax, path `/api/v1/auth/`,
   returns access token + me), refresh (rotate + blacklist, CSRF double-submit + Origin check), logout
   (blacklist + clear cookie), me. django-axes lockout; login throttle.
6. Tests: cookie attributes, rotation/blacklist reuse detection, CSRF failure, lockout, and the
   **permission-matrix test** harness (parametrized role × endpoint × in/out-of-scope → expected
   status), initially with a dummy scoped model; real endpoints are added to it in M4/M5.
Commits: `feat(common): base model and scoping`, `feat(accounts): users roles assignments`, `feat(accounts): jwt cookie auth`.

## M3 — Locations + catalog
_Done 2026-10-26._
1. `locations`: `Municipality`, `Barangay` (+ `normalized_name`, unique (municipality, normalized_name)),
   PSGC nullable (ADR-0005). `common/text.py` normalizer shared with imports.
2. `catalog`: `Program`, `Commodity` (measure_type, spacing_m, plants_per_ha, attributes_schema
   validated as JSON Schema with `jsonschema`, outlier_multiplier), `GrowthStage` (+ aliases array),
   `Variety` (aliases `ArrayField` + GIN index), `MaterialSource` (aliases), `Unit`.
   `catalog/services.py`: `resolve_alias(model, raw) -> obj | None` (exact on normalized code/name/alias; never fuzzy).
3. Seeds as idempotent management commands: `seed_locations` (6 municipalities), `seed_catalog`
   (HVCDP, CACAO 4.0 m / 625, stages SEEDLING[alias GROWING]/VEGETATIVE/FLOWERING/FRUITING, varieties
   BR25/UF18/W10/K1/CRIOLLO with aliases e.g. "BR 25", "CriolIo", "KI"; sources DA_RFO["DA- RFO"],
   DA, PCA, OWN_PRODUCED["Own Produce"], PURCHASED). `make seed` runs both (+ PSGC when file present).
4. `seed_psgc --province=Marinduque --file=data/reference/...` — format confirmed once the PAO file
   arrives (PSA publishes PSGC as .xlsx); dry-run report of matches/misses.
5. Read-only API: municipalities, barangays?municipality=, programs, commodities, commodities/{id}/stages,
   varieties?commodity=, material-sources. Admin for all catalog models.
6. Tests: alias resolution for every variety/source spelling in brief §3, seeds idempotent, schema validation.
Commits: `feat(locations): ...`, `feat(catalog): ...`, `feat(catalog): seed commands`.

## M4 — Registry + farms
_Done 2026-10-26. Harvest (production app) moved to M5._
1. `registry`: `Farmer` (name parts, `full_name_raw`, `normalized_name` + GIN trigram index, sex,
   birth_year, `rsbsa_no` partial-unique, contact_no, home_barangay, consent_at/by, status),
   `Association` (+ normalized name), `AssociationMember` (partial-unique pair).
2. `farms`: `Farm` (PointField null, `location_raw`), `CropStand` (unique farm+commodity, attributes
   validated against commodity schema in service), `Planting`, `PlantingVariety`.
3. Services: create/update/delete farmer (consent required when contact/RSBSA captured; audited),
   `find_duplicates(name, barangay|municipality)` (ADR-0007), `merge_farmers(source, target, actor)`
   (moves farms, memberships; conflicting crop stands → error listing them; audited; coordinator/admin),
   association + member services, farm/crop-stand/planting services.
4. API per §9 incl. `farmers/duplicates`, `farmers/{id}/merge`, nested routes. Filters via django-filter
   (`q` uses trigram + icontains). Personal-field stripping mixin (ADR-0010). Audit stub ready for M5
   (audit app created here so merges/deletes are logged from day one).
5. Tests: factories (synthetic names), service tests, filters, merge edge cases, permission matrix rows
   incl. **Gasan validator → 404 on Boac farmer**, field_encoder limited to barangays.
Commits: `feat(audit): append-only audit log`, `feat(registry): ...`, `feat(farms): ...`.

## M5 — Surveys, workflow, audit
1. `surveys`: `SurveyRound`, `InventoryRecord` (status, version, actors/timestamps, flags), `StageCount`
   (CheckConstraints ≥ 0; unique pair), `WorkflowComment`.
2. `surveys/rules.py`: pure validation functions returning `Issue(level=error|warning, code, field, msg)`
   — counts integers ≥ 0, at least one stage or remark, farm barangay required, outlier vs municipal
   median (min sample 5, `outlier_multiplier`), likely duplicate farmer.
3. `surveys/services.py`: `save_draft`, `submit`, `validate`, `approve`, `return_record` (comment
   required), `reopen` (comment, version+1), `open_round`/`close_round` (approved → locked). Each checks
   role + scope + current state via a single transition table, uses `select_for_update`, writes a
   workflow comment where relevant and an audit entry in the same transaction.
4. `audit`: `AuditLog` append-only (no update/delete in ORM: model `save` guard + DB trigger raising on
   UPDATE/DELETE), `record(actor, action, obj, before, after, request)` with PII masking (ADR-0006);
   request metadata via middleware context var.
5. Selectors: `round_progress(round)` (expected = crop stands with records in round or prior round per
   municipality vs counts by status), `home_stats(user)` (farmers, farms, trees by stage, area via
   ADR-0004 — latest round with approved records).
6. API: survey-rounds (+progress, close), inventory-records CRUD (draft only; `status` read-only) and
   action endpoints, stats endpoint for home.
7. Tests: full transition matrix (every state × action × role), comment-required cases, edits blocked
   outside draft, outlier/duplicate warnings, audit entries written and immutable, progress numbers.
Commits: `feat(surveys): models and rules`, `feat(surveys): workflow services`, `feat(surveys): api`.

## M6 — Imports
0. **Inspect the real workbook** (read-only, openpyxl `read_only=True, data_only=False` and a second
   pass with `data_only=True`) and report differences from brief §3 without printing personal data
   (counts, column headers, formula strings, row numbers only).
1. `imports/normalizers.py` (pure, typed, 100% unit-tested with every messy example from §3):
   whitespace, barangay ", <Town>" strip, multi-site split, name parsing (honorifics, "Ma.", suffixes
   Jr./Sr./III), year-list parsing (numbers, "2016, 2018,2021 & 2022", "2017& 2019", "and", Excel
   serial dates/datetimes), variety/source splitting + alias mapping (unknown → review), association
   splitting / "None Member", remarks harvest extraction (kilos/kls/kg/sack, "dried", "every other
   month" → recurring note, tree-loss text kept in remarks).
2. `imports/legacy_cacao_2023.py` adapter: per sheet locate header row ("NAME OF FARMER"), map stage
   sub-headers through `GrowthStage` aliases (catalog-driven), detect TOTAL row, capture its formulas +
   cached values, classify rows (above-total, below-total-with-barangay, name-only → review list).
   Also parse SUMMARY sheet values for reconciliation.
3. `imports/pipeline.py`: `build_preview(job)` → normalized rows + issues + decisions (association fuzzy
   matching ≥90 auto / 75–89 review / <75 new, within municipality) + reconciliation (computed vs
   TOTAL row vs SUMMARY per municipality × stage, plus formula anomalies like `=SUM(L28)` and
   `=SUM(J13:J48)`); `commit(job, actor)` → one `transaction.atomic()`; idempotency via
   `import_job.file_sha256` + row identity `(sheet, row_number, normalized name, barangay)` stored on
   an `ImportRowLink` table so re-commit updates nothing and creates nothing.
4. Record status per ADR-0003 (pending decision).
5. Template generator (`GET imports/template.xlsx?commodity=`): one row per crop stand, dropdown data
   validations from catalog/locations on a hidden lists sheet; template importer reuses the same
   validator; error report xlsx = input rows + error column.
6. Celery tasks `preview_import`, `commit_import`; API: upload (extension + MIME + size 10 MB +
   zip-bomb guard + reject macro-enabled), get preview, commit, error-report download (audited).
   `make import-legacy FILE=...` runs preview + commit synchronously via management command.
7. Acceptance tests (`@pytest.mark.real_data`, skipped without the file): 212 named rows, 208 with trees,
   per-municipality stage totals, province 81,712 / 130.74 ha, Santa Cruz reconciliation +940
   (+220/+350/+370), Mogpog flowering formula anomaly, re-import creates 0 rows. A synthetic
   workbook fixture (generated in-test with openpyxl, fake names, same layout quirks) covers the same
   logic in CI where the real file is absent.
Commits: `feat(imports): normalizers`, `feat(imports): legacy adapter`, `feat(imports): pipeline and reconciliation`, `feat(imports): template`, `feat(imports): celery tasks and api`.

## M7 — Frontend
1. `lib/api` generated client (ADR-0011), auth store (access token in memory, silent refresh on load,
   single-flight refresh on 401), `RequireAuth` + role-aware routes; formatters (numbers, dates, ha).
2. `components/ui`: Button, Input/Select/Combobox fields (RHF-wired), DataTable (TanStack Table,
   server-side sort/filter/pagination synced to URL), Modal/Drawer, Badge (status colours meeting AA),
   Toast, EmptyState, Skeleton, ErrorBoundary.
3. Shell: responsive sidebar (collapses to drawer < 768px), header with user/role/scope.
4. Pages per §11: Login, Home stats, Farmers list/detail/form (privacy notice + consent checkbox,
   debounced live duplicate warning), Associations, Survey rounds (progress table, close action),
   Inventory entry (stage inputs from `commodities/{id}/stages`), Review queue (side panel, actions with
   comment), Imports (upload → preview tabs: errors / warnings / decisions / reconciliation → commit → result).
5. Tests: auth flow, DataTable URL state, farmer form validation + duplicate warning, inventory form
   generated from stages, review actions; axe checks (vitest-axe) on key pages.
Commits per feature (`feat(web): ...`).

## M8 — Hardening and docs
1. Security checklist §12 audit: throttles (login, import), CORS allow-list, CSRF, prod settings (HSTS,
   SSL redirect, secure cookies, `SECURE_PROXY_SSL_HEADER`), CSP header for the SPA, upload limits,
   `manage.py check --deploy` clean in CI, `pip-audit` + `npm audit` in CI, gitleaks secret scan.
2. Logging config that never logs request bodies or personal fields.
3. `make seed-demo`: synthetic farmers/associations/farms/records across all 6 municipalities and all
   workflow states + one user per role (passwords from env).
4. README, `docs/architecture.md` (diagrams: components, workflow state machine, scoping),
   `docs/data-dictionary.md` (every table/field, PII marked).
5. Coverage gate ≥ 85% on `services.py`, `selectors.py`, `permissions.py`, `scoping.py` (pytest-cov with
   `--cov-fail-under` on those paths). Clean-clone DoD run.
6. Final report per §14.

## Open decisions (please confirm)
| # | Question | My recommendation | Blocks |
|---|----------|-------------------|--------|
| 1 | Legacy import status vs "totals over approved" (ADR-0003) | Import as approved, lock round | M6 |
| 2 | Municipality PSGC nullable until the PAO file arrives (ADR-0005) | Yes | M3 |
| 3 | Duplicate thresholds 0.85 warn / 0.6 suggest (ADR-0007) | Yes | M4 |
| 4 | Viewer = 403 on record-level endpoints (ADR-0010) | Yes | M2 |
| 5 | Rows below the TOTAL row: count them in totals? The expected 81,712 appears to cover only rows above the total row; I'll confirm against the file | Import as draft/needs_review, excluded from totals | M6 |
| 6 | Place the workbook (and PSGC file if available) in `data/raw/` / `data/reference/` | — | M6 (M3 for PSGC) |
