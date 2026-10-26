# ADR-0007: Configurable duplicate-farmer thresholds
Status: Accepted · 2026-10-26 (approved by product owner)

**Context.** The brief sets "likely duplicate" at pg_trgm similarity ≥ 0.85. pg_trgm scores for common
Filipino name variants are usually lower (e.g. "Ma. Luisa Reyes" vs "Maria Luisa Reyes" scores roughly
0.6–0.7), so 0.85 only catches near-identical spellings.

**Decision.** Normalize names first (lowercase, strip accents and punctuation, expand "Ma." → "maria",
"Sto." → "santo", drop suffix), then compare. Thresholds are settings:
`DUPLICATE_WARN_SIMILARITY` (default **0.85**, as in the brief) for the submit-time validation warning,
and `DUPLICATE_SUGGEST_SIMILARITY` (default 0.6) for the live "possible duplicates" list on the farmer
form. Same `rsbsa_no` is always a duplicate. Tune both after the legacy import using its 3 known pairs.

**Consequences.** Brief behaviour preserved by default; better recall in the UI without noisy warnings.
