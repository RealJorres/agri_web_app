# ADR-0015: Official reports, signatories and sign-off
Status: Proposed · 2026-10-27 (layout and signatories to be confirmed by the PAO)

**Decision.** Letterhead lines, logo and signatories (name, title, role label, order) are report
settings edited in Django admin, never hard-coded: people and titles change. The first layouts copy
the 2023 workbook's SUMMARY sheet and municipal lists. Reports are generated on demand from locked
records only (a round must be closed), so the same inputs always give the same figures. Sign-off by
the provincial head records actor, time and the SHA-256 of the report's **canonical content** (figures,
labels and signatories serialised as sorted JSON) in an audited row; it does not store the figures.
A file hash was rejected because .xlsx/.pdf embed timestamps and library versions, so the same report
would hash differently on every download. Open rounds can be previewed with a "DRAFT" mark but not
signed.

**Consequences.** Re-computing a signed report's content must reproduce the hash; if records are
reopened after sign-off, the hash no longer matches and the sign-off is shown as superseded.

**"No. of farmers".** Counted as distinct farmers with at least one tree counted in an official
record. The 2023 SUMMARY sheet was typed by hand and does not follow one rule: against the real
data it gives 209 where this rule gives 206.
- Boac: 20 on the sheet, 19 here. Two rows were the same farmer and were merged on import.
- Buenavista: 41 on the sheet, 39 here. The sheet counts rows, including one row with no tree
  counts and a second row for one farmer.
- Mogpog: 23 on both. The sheet already leaves out its 3 rows with no tree counts.

The PAO must confirm the rule (open question in PLAN_PHASE2.md).
