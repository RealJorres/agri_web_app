# ADR-0018: Harvest summary
Status: Accepted · 2026-10-27 (sack weight to be supplied by the PAO)

**Context.** Harvests (brief §5) are reported per crop stand in mixed units: kilograms of wet beans,
dried beans or pods, sacks, and other units. Many come from legacy remarks with no date.
Harvests are not part of the draft → approved workflow.

**Decision.**
- `GET /api/v1/analytics/harvests` (view_aggregates, scoped like every other aggregate) returns, per
  municipality: the number of harvests and farmers, kg per product form, sacks, the number of
  entries in other units, and how many have an estimated date. It is computed on every request from
  the harvest rows; nothing is stored.
- **Kg is never summed across product forms.** Wet and dried beans are not comparable weights, and
  no conversion factor has been agreed.
- **Sacks and other units are never converted to kg.** They stay separate until the PAO gives a
  sack weight per product form; the conversion would then be a catalog setting, not code.
- **Undated harvests.** With a year filter they are left out, and the response says how many were
  left out (`undated_excluded`) so the total is never silently smaller.
- The screens label these figures as *reported harvests*. They are not validated or approved like
  inventory records.

**Consequences.** Adding harvest review later means a status on Harvest plus a filter in
`apps.production.selectors`. The endpoint and the screens stay the same.
