# ADR-0013: Legacy cacao 2023 import mapping
Status: Accepted · 2026-10-26

**Context.** The 2023 workbook stores one row per farmer-farm with free-text cells that combine
several values ("2016, 2018,2021 & 2022", "UF18 & BR25", "DA/PCA/Own Produced"). The data model has
one planting per batch, many varieties per planting, and one material source per planting.

**Decisions.**
1. *Farmer identity within the file:* same normalized name and same home barangay = one farmer with
   several farms (review item "same_name_twice"). Same name in different barangays = two farmers
   (review item "possible_duplicate"). No fuzzy merging on import: merges are a human decision.
2. *Plantings:* one planting per parsed year (qty_planted NULL); if no year parses, one planting with
   year NULL when any variety/source exists. Varieties are attached to every planting of the stand.
   The source is set only when the cell has exactly one source; otherwise source is NULL and the
   resolved sources are listed in `planting.notes`. The raw cells are kept in notes when the mapping
   is ambiguous (several years together with several varieties/sources).
3. *Farm barangay:* FARM LOCATION if it (or its first site in "A/B") matches a barangay of the
   municipality; else the home barangay. The raw FARM LOCATION is always kept in `farm.location_raw`.
4. *Barangays not in the database* are created with `is_verified=false` and reported (ADR-0005).
5. *Associations:* rapidfuzz `token_sort_ratio` on normalized names within the municipality:
   >= 90 reuse, 75–89 review item (default: create new; the commit request may map it to an existing
   association), < 75 new.
6. *Record status (amends ADR-0003):* rows above the TOTAL row are imported as `approved` with
   `flags.source = "legacy_import"`; the round is created open and is **not** auto-closed, because
   rows below the TOTAL row are imported as `draft` (farmer status `needs_review`) and must stay
   editable until someone completes and submits them. The coordinator closes the round (locking it)
   when they are resolved. Name-only rows are not imported (review list).
7. *Remarks:* recognised harvest phrases become Harvest rows (date NULL, `date_estimated=true`,
   `raw_text` kept); the remark text minus those phrases stays in `record.remarks`.
8. *Idempotency:* `ImportRowLink(file_sha256, sheet, row)` records what each source row created.
   Re-committing the same file (any job) creates nothing new.
9. *Who may commit:* legacy imports approve records, so committing needs both `run_imports` and
   `approve` (in practice a system admin); template imports need `run_imports` and create
   `submitted` records that enter the normal MAO review queue. The CLI (`make import-legacy`) runs
   as the system account and is audited as such.
