# ADR-0005: PSGC codes are never invented
Status: **Proposed — needs PSGC file from the PAO** · 2026-10-26

**Context.** The brief makes `municipality.psgc_code` unique (non-null) but also says "do not invent
PSGC codes", and no PSGC file is in `data/reference/` yet. M3 must still seed the 6 municipalities.

**Decision.** `municipality.psgc_code` is `unique, null=True` (like barangay). `make seed` creates the
6 municipalities by name with `psgc_code=NULL`. `seed_psgc --province=Marinduque` fills codes for
municipalities and barangays from the official file (matching on normalized name, reporting misses)
and sets `is_verified=true`, merging import-created barangays that match. A Django system check warns
while any municipality lacks a code.

**Consequences.** The system is usable before the reference file arrives; codes only ever come from PSA data.
