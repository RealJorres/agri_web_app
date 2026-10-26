# PROJECT BRIEF: Marinduque Agri Data Management & Analytics System (working name: agri-dms)

You are the lead engineer building a production-grade web system for the Provincial Agriculture Office (PAO) of Marinduque, Philippines. Think like a senior engineer: secure by default, clean architecture, simple over clever, tested, documented.

FIRST ACTIONS (before writing any code):
1. Save this entire brief verbatim to docs/PROJECT_BRIEF.md so later sessions can re-read it.
2. Inspect data/raw/cacao_production_data_as_of_july_2023.xlsx (read-only) and confirm it matches the "Source data" section below. Report any differences.
3. Create CLAUDE.md with: project summary, tech stack, folder layout, run/test/lint commands, coding conventions, and the non-negotiable rules from this brief.
4. Produce a step-by-step implementation plan for Phase 0 + Phase 1 (milestones M1-M8 below) and wait for my approval.
If anything in this brief is ambiguous or conflicts with best practice, say so and propose an alternative. Record each significant decision as a short ADR in docs/decisions/.

## 1. Goal
Replace the PAO's Excel-based crop inventories with one commodity-agnostic system. Farmer-level records are entered once (office form, mobile field app, or Excel import), validated by the Municipal Agriculture Office (MAO), approved by the province, and every summary, dashboard and official report is computed from those records. Cacao (High Value Crops Development Program, HVCDP) is the first crop. Coffee, coconut, banana, rice, corn and vegetables must be addable later as CONFIGURATION (catalog rows), not new code.

## 2. Non-negotiable rules
- Never store totals. All summaries are queries/views over approved records.
- Personal data (farmer names, contact numbers, birth year, RSBSA numbers, locations) is protected under the Philippine Data Privacy Act (RA 10173). Never commit data/raw/ or any real personal data. Tests, fixtures and seed/demo data use SYNTHETIC names only. Add data/raw/, data/reference/ and .env to .gitignore immediately.
- Every query is scoped server-side by the user's role and assignments (municipality/program). Never rely on the frontend for access control.
- Business rules live in service functions, not in views, serializers or signals.
- Every state change, approval, delete and personal-data export is written to the audit log.
- No secrets in code. Use environment variables with a committed .env.example.
- Small, reviewable commits (conventional commit messages). Tests must pass before each commit.

## 3. Source data (the sample workbook)
Workbook sheets: BOAC, BUENAVISTA, MOGPOG, GASAN, SANTA CRUZ, TORRIJOS (one per municipality), plus SUMMARY.
Municipal sheet layout:
- Rows 1-10: letterhead/titles (merged cells). Row 9 = "INITIAL CACAO POPULATION DATA IN THE MUNICIPALITY OF <NAME>", row 10 = "as of July, 2023".
- Row 11: headers. Row 12: stage sub-headers under "STATUS/NO. OF CACAO PLANTED". Data starts at row 13.
- Columns A-N: NO. | NAME OF FARMER | BARANGAY | FARM LOCATION | NAME OF ASSOCIATION | CONTACT NO. | VARIETY | DATE PLANTED | SOURCE OF PLANTING MATERIALS | SEEDLING | VEGETATIVE | FLOWERING | FRUITING | REMARKS. (MOGPOG has an extra empty column O.)
- A TOTAL row with SUM formulas in J-M ends each list. Some rows appear BELOW the total row.
SUMMARY sheet: per-municipality number of farmers, area by stage (ha) = trees / 625 (note: "625 cacao trees/hectare with 4x4 planting distance"), plant population by stage, and Prepared by / Submitted by / Noted signatory blocks. It labels the first stage "GROWING" while municipal sheets say "SEEDLING".

Known data-quality issues the system must handle:
- SANTA CRUZ totals are wrong: SUM ranges stop at row 48 for J, K, L (=SUM(J13:J48)), skipping 3 rows. Workbook province total = 80,772; true total from farmer rows = 81,712 (+940: seedling +220, vegetative +350, flowering +370).
- MOGPOG flowering total is =SUM(L28) (a single cell).
- DATE PLANTED: text in 93 cells, a number in 83; 39 rows hold several years in one cell, e.g. "2016, 2018,2021 & 2022", "2017& 2019".
- VARIETY: 18 raw spellings, e.g. "UF18 & BR25", "BR25&UF18", "BR 25", "BR25 ", "CriolIo", "KI & K18", "W10 &  Criollo"; blank in about 68% of rows.
- SOURCE: 13 raw spellings, e.g. "DA-RFO", "DA- RFO", "DA", "DA/PCA/Own Produced", "Own Produce", "PCA", "PS".
- REMARKS sometimes hold harvests in mixed units: "8 kilos harvest", "3 kls.", "1 sack", "6 kilos dried", "1 kilo every other month"; one notes tree losses (325 in May 2023, 80 now).
- ASSOCIATION: inconsistent ("Mat. Gasan FA", "None Member", "Tambangan FA, SAGANA" = two in one cell).
- BARANGAY sometimes contains the town ("Lamesa, Mogpog"); FARM LOCATION differs from BARANGAY in 23 rows; some list two sites ("Pulong Parang/Masalukot").
- CONTACT NO. present in only about 30% of rows. No RSBSA number, sex or age columns.
- Outlier: one Santa Cruz row has 10,500 vegetative trees.
- 3 farmer names appear twice (same person with two farms, or two people).

Expected import results (use as acceptance tests; tests that need the real file must be marked and SKIPPED when data/raw/ is absent):
- 212 named farmer rows above the total rows; 208 have at least one tree counted.
- True stage totals per municipality (seedling / vegetative / flowering / fruiting):
  Boac 30 / 3,205 / 1,365 / 2,475
  Buenavista 7,085 / 4,175 / 615 / 3,244
  Mogpog 1,053 / 1,332 / 600 / 988
  Gasan 2,750 / 5,650 / 1,915 / 3,520
  Santa Cruz 1,483 / 14,655 / 6,205 / 9,334
  Torrijos 1,230 / 3,800 / 3,333 / 1,670
  Province 13,631 / 32,817 / 14,033 / 21,231 = 81,712 trees (130.74 ha at 625/ha)

## 4. Tech stack
- Backend: Python 3.12, Django 5.2 LTS, Django REST Framework, drf-spectacular (OpenAPI 3), django-filter, djangorestframework-simplejwt, django-axes, argon2-cffi, django-environ, django-cors-headers, psycopg 3, Celery 5 + Redis 7, openpyxl + pandas (Excel), rapidfuzz (fuzzy matching). Dependency management with uv + pyproject.toml.
- Database: PostgreSQL 16 + PostGIS (GeoDjango) with pg_trgm enabled. UUID primary keys.
- Frontend: React 19 + Vite + TypeScript (strict) + Tailwind CSS v4, React Router, TanStack Query v5, TanStack Table v8 (server-side pagination/sort/filter), React Hook Form + Zod, typed API client generated from the OpenAPI schema (openapi-typescript or orval). Node 22 LTS, npm.
- Tooling: Docker Compose for local dev, Makefile, ruff (lint + format), mypy (backend, at least services/), ESLint + Prettier, pytest + pytest-django + factory_boy, Vitest + Testing Library, GitHub Actions CI.
- Later phases (do not build yet): Apache ECharts, MapLibre GL or Leaflet, WeasyPrint, Workbox + Dexie (PWA offline).

## 5. Folder structure
agri-dms/
  backend/
    config/            settings/{base,dev,prod,test}.py, urls.py, celery.py, wsgi.py
    common/            base models (UUID, timestamps, created_by/updated_by, soft delete), scoping mixins, permissions, pagination, error handler
    apps/
      accounts/        users, roles, assignments, auth endpoints
      locations/       municipality, barangay (PSGC)
      catalog/         program, commodity, growth_stage, variety (+aliases), material_source (+aliases), unit
      registry/        farmer, association, association_member
      farms/           farm, crop_stand, planting, planting_variety
      surveys/         survey_round, inventory_record, stage_count, workflow services, validation rules
      production/      harvest (model + API only in Phase 1)
      imports/         templates, legacy workbook adapter, parsers, normalizers, import jobs, reconciliation
      audit/           audit_log
    tests/
    pyproject.toml
  frontend/
    src/
      app/             router, providers, layout, auth guard
      features/        auth, farmers, associations, farms, surveys, review, imports (pages, components, hooks, api)
      components/ui/   shared table, form fields, modal, badge, toast, empty states
      lib/             generated API client, auth, formatters
  infra/               docker-compose.yml, nginx/ (later), scripts/
  docs/                PROJECT_BRIEF.md, architecture.md, data-dictionary.md, decisions/
  data/raw/            (gitignored) source workbooks
  data/reference/      (gitignored) PSGC file supplied by the PAO
  .github/workflows/
Inside each Django app: models.py, serializers.py, views.py, urls.py, filters.py, permissions.py, services.py (writes + rules), selectors.py (reads), admin.py, tests/.

## 6. Data model
- municipality(psgc_code unique, name, boundary MultiPolygon null)
- barangay(psgc_code unique null, name, municipality FK, boundary null, is_verified bool). Unique (municipality, normalized name).
- program(code, name). Seed: HVCDP.
- commodity(program FK, code, name, measure_type enum[trees, area], spacing_m decimal null, plants_per_ha int null, attributes_schema JSON (JSON Schema), outlier_multiplier default 5). Seed: CACAO, trees, spacing 4.0, 625/ha.
- growth_stage(commodity FK, code, label, sort_order, is_bearing). Seed cacao: SEEDLING ("Seedling", alias "Growing"), VEGETATIVE, FLOWERING, FRUITING (is_bearing=true).
- variety(commodity FK, code, name, aliases text[]). Seed cacao: BR25, UF18, W10, K1, CRIOLLO with known misspellings as aliases. Unknown codes (e.g. K18, K19) go to the import review list. Never guess.
- material_source(code, name, aliases text[]). Seed: DA_RFO, DA, PCA, OWN_PRODUCED, PURCHASED. Unknown ("PS") goes to review.
- farmer(first_name, middle_name, last_name, suffix, full_name_raw, sex enum null, birth_year null, rsbsa_no unique null, contact_no null, home_barangay FK, consent_at null, consent_by FK null, status enum[active, inactive, needs_review]). GIN trigram index on normalized full name.
- association(name, short_name, type enum[farmers_association, cooperative, irrigators_association, other], municipality FK, registration_body null, registration_no null)
- association_member(farmer FK, association FK, role null, since null). Unique pair.
- farm(farmer FK, barangay FK, sitio null, location Point null, declared_area_ha null, tenure enum null, location_raw text null)
- crop_stand(farm FK, commodity FK, spacing_m null, attributes JSONB validated against commodity.attributes_schema). Unique (farm, commodity).
- planting(crop_stand FK, year_planted int null, source FK null, qty_planted int null, notes) + planting_variety(planting FK, variety FK)
- survey_round(commodity FK, name, as_of_date, deadline null, status enum[open, closed], is_historical bool)
- inventory_record(survey_round FK, crop_stand FK, status enum[draft, submitted, validated, approved, locked], version int, encoded_by, submitted_at, validated_by/at, approved_by/at, remarks, flags JSONB). Unique (survey_round, crop_stand).
- stage_count(inventory_record FK, growth_stage FK, count int null >= 0, area_ha decimal null >= 0). Unique pair.
- harvest(crop_stand FK, harvest_date null, date_estimated bool, quantity decimal, unit enum[kg, sack, other], product_form enum[wet_beans, dried_beans, pods, unknown], price_per_unit null, buyer null, raw_text null)
- workflow_comment(inventory_record FK, author, action, body, created_at)
- audit_log(actor, action, object_type, object_id, before JSONB, after JSONB, ip, user_agent, created_at). Append-only.
- import_job(uploaded_by, file, kind enum[template, legacy_cacao_2023], status enum[uploaded, validating, ready, committed, failed], summary JSONB, error_report file null)
Inventory counts belong to the crop stand (not the planting batch), because farmers know how many trees are fruiting, not which batch they came from.

## 7. Roles and scoping
Roles: system_admin, provincial_head, program_coordinator, provincial_encoder, mao_validator, field_encoder, viewer.
user_assignment(user, municipality null = all, program null = all, barangays M2M optional for field_encoder).
- system_admin: everything, including Django admin.
- provincial_head: read all; final sign-off on reports later.
- program_coordinator: own programs, all municipalities. Opens/closes rounds, approves or returns validated records.
- provincial_encoder: create/edit drafts and run imports within assignments; submit.
- mao_validator: own municipality only. Validates or returns submitted records; may edit before validating.
- field_encoder: assigned barangays only. Create/edit drafts, submit.
- viewer: aggregated endpoints only, no personal fields.
Implement one ScopedQuerySetMixin used by every viewset (municipality resolved through barangay). Serializers drop personal fields for viewer. Write a permission-matrix test that proves a Gasan validator gets 404 on a Boac farmer.

## 8. Workflow (service layer; no state edits through generic PATCH)
- draft -> submitted: encoder within scope. Run validation rules: blocking errors stop the submit; warnings are saved in flags.
- submitted -> validated: mao_validator of that municipality.
- submitted -> draft (return): mao_validator, comment required.
- validated -> approved: program_coordinator for the commodity's program.
- validated -> draft (return): program_coordinator, comment required.
- approved -> locked: when the coordinator closes the round.
- approved/locked -> draft (reopen): program_coordinator only, comment required, version + 1, fully audited.
- Edits allowed only in draft (and by mao_validator while submitted).
Validation rules: stage counts are integers >= 0; at least one stage filled or an explicit remark; farm barangay required; warning when the stand total exceeds commodity.outlier_multiplier x the municipal median for that round (min sample 5); warning on likely duplicate farmer (trigram similarity >= 0.85 within the municipality, or same rsbsa_no).

## 9. API (/api/v1, JSON, page-number pagination of 50, errors as {code, message, fields})
- auth: POST login, refresh, logout; GET me (roles + assignments). Access token 15 min, kept in memory on the client. Refresh token 7 days, rotating with blacklist, in an httpOnly Secure SameSite=Lax cookie scoped to /api/v1/auth/, with a CSRF check on refresh/logout.
- municipalities, barangays?municipality=, programs, commodities, commodities/{id}/stages, varieties?commodity=, material-sources
- farmers (CRUD; ?q=&municipality=&barangay=&association=&status=), farmers/duplicates?name=&barangay=, POST farmers/{id}/merge (admin/coordinator, audited)
- associations, associations/{id}/members
- farms, farms/{id}/crop-stands, crop-stands/{id}/plantings, crop-stands/{id}/harvests
- survey-rounds, survey-rounds/{id}/progress (expected vs submitted/validated/approved per municipality), POST survey-rounds/{id}/close
- inventory-records (CRUD in draft), POST inventory-records/{id}/submit|validate|approve|return|reopen
- imports: POST (upload), GET {id} (preview: row errors, warnings, normalization decisions, reconciliation), POST {id}/commit, GET {id}/error-report
- exports: GET farmers.xlsx / inventory.xlsx with current filters (personal-data exports require permission and are audited)
- health: GET /api/health
OpenAPI at /api/schema/ with Swagger UI in dev only.

## 10. Import pipeline (Phase 1 core deliverable)
A. Legacy adapter for the cacao 2023 workbook:
 1. Each municipal sheet = one municipality (sheet name -> municipality). Find the header row by locating "NAME OF FARMER"; read stage columns from the sub-header row; stop at the TOTAL/SUM row.
 2. Rows below the total row that have a barangay become incomplete records (status needs_review). Rows with only a name go to the review list and are not imported automatically (they may be signatories or notes).
 3. Normalize: trim and collapse spaces; strip ", <Municipality>" from barangays; parse names best-effort into parts, keeping full_name_raw; split multi-year cells on [,&/] and "and" into one planting per year (qty_planted null); split variety/source strings on [,&/] and map through aliases (unknown -> review list); association "None Member"/blank -> none; "A, B" -> two memberships; fuzzy-match associations within the municipality (rapidfuzz, score >= 90 auto, 75-89 review, < 75 new); farm barangay = FARM LOCATION if it matches a barangay in that municipality, else home barangay, with the raw text kept in farm.location_raw.
 4. REMARKS: extract harvests with patterns for kilos/kls/kg/sack, plus "dried" -> dried_beans; harvest_date null with date_estimated=true; keep raw_text. Anything unparsed stays in remarks.
 5. Create survey_round "Cacao inventory - July 2023" (as_of 2023-07-31, is_historical=true). Records are imported as validated with flags for missing fields.
 6. Barangays: load the official PSGC list from data/reference/ via a management command (seed_psgc --province=Marinduque) when the file is present; otherwise create barangays from the import with is_verified=false. Do not invent PSGC codes.
 7. Reconciliation report: computed totals per municipality and stage vs the workbook's own TOTAL rows and SUMMARY sheet, listing every difference (Santa Cruz must show +940). Saved in import_job.summary and shown in the UI.
 8. Idempotent: re-running the same file must not duplicate data (match on file hash + row identity).
B. Clean ongoing template: one row per crop stand, data-validation dropdowns (municipality, barangay, variety, source), generated by the system from the catalog, imported through the same validator with a downloadable error file.
Imports run as Celery tasks: preview first, commit only after user confirmation, all inside one transaction.

## 11. Frontend (Phase 1 scope)
Modern, clean, accessible (WCAG AA contrast, keyboard navigable), responsive down to 360px.
- Login page; app shell with role-aware sidebar; header showing user, role and scope.
- Home: simple counts (farmers, farms, trees by stage for the latest approved round), computed by the API.
- Farmers: server-side table (search, filters, pagination, column sort), detail page (profile, memberships, farms -> crop stands -> plantings, inventory history, audit trail), create/edit form with a live duplicate warning.
- Associations: list, detail, members.
- Survey rounds: list, detail with progress per municipality, open/close (coordinator).
- Inventory entry: form per crop stand; stage inputs generated from the commodity's stages; inline validation and warnings; save draft and submit.
- Review queue: role-filtered list of submitted/validated records; side panel with record, flags and comments; validate/approve/return with comment.
- Imports: upload -> preview (errors, warnings, normalization decisions, reconciliation table) -> commit -> result.
Users, assignments and catalog are managed in Django admin for Phase 1.

## 12. Security checklist (implement in Phase 1)
Argon2 hashing; django-axes lockout; DRF throttling (stricter on login and import); CORS restricted to the frontend origin; CSRF for cookie endpoints; secure cookies and HSTS/SSL settings in prod settings; upload limits (.xlsx/.csv only, 10 MB, openpyxl read-only, no macros); ORM only, no raw SQL with user input; Zod and DRF validation on both sides; DEBUG off in prod; audit log for workflow actions, deletes, merges and personal-data exports; a privacy-notice text and consent_at capture on the farmer form.

## 13. Phase 1 milestones (commit and run tests at the end of each)
M1 Scaffold: monorepo, Docker Compose (postgis/postgis:16 image, redis:7, api, worker, frontend dev server), Makefile (up, down, migrate, seed, test, lint, fmt, import-legacy FILE=..., schema), settings split, .env.example, health endpoint, CI (ruff, mypy, pytest, ESLint, tsc, Vitest, build).
M2 Accounts: custom user, roles, assignments, JWT cookie flow, ScopedQuerySetMixin, permission-matrix tests.
M3 Locations + catalog: models, admin, seeds for Marinduque's 6 municipalities and the cacao configuration, PSGC loader command.
M4 Registry + farms: farmers, associations, farms, crop stands, plantings; duplicate detection; merge service; API + tests.
M5 Surveys + workflow + audit: rounds, inventory records, stage counts, transition services, validation rules, comments, audit log; API + tests.
M6 Imports: legacy adapter, normalizers with unit tests for every messy example in section 3, reconciliation, template generator, Celery tasks; acceptance tests against the expected numbers (skipped without the file).
M7 Frontend: shell, auth, pages from section 11, generated API client, component tests.
M8 Hardening: security checklist, synthetic demo seed (make seed-demo), README (setup, commands, architecture overview), docs/data-dictionary.md, docs/architecture.md.

## 14. Definition of done for Phase 1
- make up && make migrate && make seed && make import-legacy FILE=data/raw/... works from a clean clone.
- The province total after import is 81,712 and the reconciliation shows Santa Cruz +940.
- Backend tests pass with >= 85% coverage on services, selectors and permissions; frontend tests and type-check pass; CI is green.
- No personal data in git history, fixtures or logs.
When done, STOP and report: what was built, how to run it, test/coverage results, open issues, review-list items from the import, and recommendations for Phase 2. Do not start Phase 2 until I confirm.

## 15. Later phases (context only, do not build yet)
Phase 2: analytics (materialized views per round x barangay x stage, KPI endpoints, ECharts dashboards), GIS map, official Excel/PDF reports in the PAO's layouts with letterhead and signatories, harvest UI, offline PWA field app.
Phase 3: interventions/distributions tracking, public aggregate dashboard, onboarding other crops by configuration, production deployment (Nginx + TLS, backups, Sentry, uptime monitoring, CI/CD).
Design Phase 1 so these slot in without refactoring.
