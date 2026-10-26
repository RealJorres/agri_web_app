# Phase 2 plan

Status: **started 2026-10-27** on the product owner's go-ahead. Scope from brief §15: analytics
(materialized views, KPI endpoints, ECharts dashboards), GIS map, official Excel/PDF reports in the
PAO's layouts, harvest UI, offline PWA field app. Each milestone ends with tests green and commits.

## Inputs needed from the PAO (do not block other milestones)
| # | Input | Needed by | Until then |
|---|---|---|---|
| 1 | Municipality/barangay boundary file (GeoJSON or shapefile, e.g. NAMRIA/PSA) in `data/reference/` | P2-M5 choropleth | map shows farm points and a municipality table; nothing is drawn from invented shapes (ADR-0016) |
| 2 | Letterhead logo image and the official report layouts (if they differ from the 2023 SUMMARY sheet) | P2-M3 | layout copies the 2023 SUMMARY sheet; logo slot empty |
| 3 | Signatory names and titles per report | P2-M3 | configured in Django admin, not in code (ADR-0015) |
| 4 | Sack weight (kg) for cacao harvests, wet vs dried | P2-M4 | sacks reported separately from kg (no guessing) |
| 5 | Answers to the import review list (K18, K19, "PS", KI→K1, association matches) | any time | review list stays open |

## P2-M1 — Analytics core (backend)
_Done 2026-10-27._
1. Two PostgreSQL materialized views over approved/locked records (ADR-0014): `analytics_stage_totals`
   (round × barangay × stage: trees, area, records, farmers) and `analytics_record_facts` (one row per
   official record: round, barangay, farmer, total trees, bearing trees). Read through unmanaged models.
2. Refresh service + debounced Celery task, scheduled `on_commit` from every service that changes
   official numbers (approve, close, reopen, import commit, merge, farm barangay change) and nightly
   by beat. `analytics_refresh` row records when data was last refreshed (shown on dashboards).
3. KPI endpoints (`/api/v1/analytics/…`, `view_aggregates`, scoped like everything else): round
   overview with deltas vs the previous round; breakdown by municipality or barangay; trends across
   rounds; distributions (trees per farm, planting years, varieties).
4. Tests: views equal the live `stage_totals` selector for every role scope; refresh triggers;
   KPI math on synthetic data; the real file gives 81,712 in the views too (real_data).

## P2-M2 — Dashboards (frontend, Apache ECharts)
_Done 2026-10-27; checked in Chrome on the real data (360 px width not verified: window could not be resized)._
Overview dashboard (KPI tiles, stage mix, by-municipality stacked bars, trend line), municipality
drill-down to barangays, distributions. Every chart has an accessible data table and CSV download;
colour-blind-safe palette; works at 360 px. Charts are lazy-loaded so other pages stay light.

## P2-M3 — Official reports
Report settings in admin (letterhead lines, logo, signatories with titles and order, per report).
Excel (openpyxl) and PDF (WeasyPrint) for: the provincial summary (2023 SUMMARY layout: farmers, area
by stage, population by stage, totals, 625/ha note, signatory blocks) and the municipal farmer list
(personal data: `export_personal_data`, audited). Reports are generated from locked records, so a
signed report can always be regenerated identically; provincial-head **sign-off** stores who, when
and a SHA-256 of the generated file (no totals stored).

## P2-M4 — Harvest UI
Harvests on the crop-stand page (list/add/edit), harvest summary per municipality (kg; sacks
separately until a sack weight is configured), date-estimated flag visible.

## P2-M5 — GIS map (MapLibre GL)
Boundary loader (`seed_boundaries` from `data/reference/`), farm location capture on the farm form
(map click or device GPS), map page: municipality/barangay choropleth (trees, bearing share) and farm
points (only for `view_personal_data`, clustered). Tile source per ADR-0016.

## P2-M6 — Offline field app (PWA: Workbox + Dexie)
Field mode for field encoders: assigned barangays' farmers and stands cached; inventory drafts
captured offline and synced with idempotency keys; server validates on sync; conflicts shown, never
silently overwritten. Device data minimised, cleared on sign-out (ADR-0017).

## P2-M7 — Hardening and report
Performance pass (EXPLAIN on analytics queries), docs, coverage gate, Phase 2 report.
