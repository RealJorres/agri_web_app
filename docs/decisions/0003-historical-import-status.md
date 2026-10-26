# ADR-0003: Status of records imported from the 2023 legacy workbook
Status: Accepted · 2026-10-26 (approved by product owner)

**Context.** Two brief requirements conflict:
- Rule 2.1 / §11: summaries are computed over **approved** records.
- §10.A.5: legacy records are imported as **validated**; §14 requires the province total after
  import to be **81,712**.

If imported rows stay `validated`, every approved-only summary shows 0 until someone approves 208+
records by hand.

**Options.**
1. *(Recommended)* Import as `approved`, then lock the historical round (`status=closed`, records
   `locked`). `approved_by` = the user who commits the import, `flags.source = "legacy_import"`, one
   audit entry per record plus one for the job. Rows with missing fields still carry flags. Rows below
   the TOTAL row are imported as `draft` (farmer status `needs_review`) and are therefore excluded from
   totals until someone completes and submits them.
2. Import as `validated` (as written) and give the coordinator an audited "approve all validated in
   round" service. Totals reach 81,712 only after that step.
3. Import as `validated` and let historical rounds count validated records. Rejected: two definitions
   of "official" numbers.

**Consequences of 1.** The DoD check works right after import; the human approval is the import
commit itself (confirmed by the user on the preview screen). Reopen still works per §8.

**Amendment (2026-10-26, ADR-0013 §6).** The historical round is created open and not auto-closed:
rows below the TOTAL row become draft records that must remain editable. Approved imported records
are locked when the coordinator closes the round.
