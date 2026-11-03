# ADR-0020: How imports commit on MongoDB
Status: Accepted · 2026-11-03 · Amends brief §10 and the M5 wording in the migration plan. Follows ADR-0019.

**Context.** The brief and the plan call for an import commit in one transaction, all or nothing. MongoDB
aborts a transaction that runs longer than 60 seconds by default. Atlas is reached over the internet, so each
write costs tens of milliseconds. A row in the old design takes about 15 separate writes, and the real workbook
has more than 200 rows, so one write per document would run past the limit and fail every time.

**Decision.**

1. **Workbook imports stay all or nothing.** Every document is built in memory first, then written with a bulk
   insert per collection, inside one transaction. That is about 20 round trips, whatever the file's size.
2. **Template imports commit one row per transaction.** They go through the regular services (scope checks,
   rules, audit), which take too many writes to fit a large file inside the limit. The row and its link commit
   together, so a row is never half-saved. A row that breaks a rule is listed and the others continue. If the
   connection fails, the job is marked failed and says how many rows were saved. Uploading the same file again
   skips those rows, because the row links make it idempotent.
3. **The workbook adapter is driven by the catalog** (ADR-0019). A new kind, `legacy_workbook`, names a commodity,
   a round name and an as-of date. `legacy_cacao_2023` remains as that same adapter with the 2023 cacao values
   filled in. Only tree crops are accepted, because the layout holds whole-number counts per stage.

**Consequences.**
- A template import can end partly saved. The job shows this, and the fix is to upload the same file again.
- Bulk inserts skip the services, so the workbook commit carries its own scope keys and audit entries. The
  integrity script and the tests check them.
- `frontend/openapi.json` gains the new kind and upload fields. The upload screen uses them at M7.
