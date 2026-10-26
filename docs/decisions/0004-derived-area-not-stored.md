# ADR-0004: Area derived from tree counts is computed, never stored
Status: Accepted · 2026-10-26

**Context.** `stage_count.area_ha` exists, and the SUMMARY sheet shows area = trees / 625.

**Decision.** For `measure_type=trees`, `stage_count.area_ha` stays NULL and area is computed in
selectors as `count / plants_per_ha`, where plants_per_ha is `10000 / crop_stand.spacing_m²` when the
stand overrides spacing, else `commodity.plants_per_ha` (625 for cacao at 4 m × 4 m). `area_ha` is
filled only for `measure_type=area` commodities (rice, corn), where area is the measured quantity.
Rounding happens only at presentation (2 dp).

**Consequences.** No stale derived values; 81,712 / 625 = 130.74 ha is reproduced by a selector test.
