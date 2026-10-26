# ADR-0015: Official reports, signatories and sign-off
Status: Proposed · 2026-10-27 (layout and signatories to be confirmed by the PAO)

**Decision.** Letterhead lines, logo and signatories (name, title, role label, order) are report
settings edited in Django admin, never hard-coded: people and titles change. The first layouts copy
the 2023 workbook's SUMMARY sheet and municipal lists. Reports are generated on demand from locked
records only (a round must be closed), so the same inputs always give the same file. Sign-off by the
provincial head records actor, time and the SHA-256 of the generated file in an audited row; it does
not store the figures.

**Consequences.** Re-generating a signed report must reproduce the hash; if records are reopened
after sign-off, the sign-off is shown as superseded.
