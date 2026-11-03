# ADR-0014: Analytics through refreshed materialized views
Status: Accepted · 2026-10-27

> **Superseded by ADR-0019.** MongoDB has no materialized views here; figures are aggregated per request.

**Context.** Brief rule 2.1 forbids stored totals; §15 asks for materialized views for analytics.
Dashboards aggregate across rounds, municipalities, barangays and stages and must stay fast.

**Decision.** Materialized views are *derived caches* of approved/locked records, never a source of
truth and never written by application code. Official figures shown on records, round pages and
reports keep coming from the live `stage_totals` selector; dashboards read the views. A test asserts
the views equal the live selector. Refresh is `REFRESH MATERIALIZED VIEW CONCURRENTLY`, debounced
(at most one refresh per 30 s), scheduled `on_commit` by the services that change official numbers,
plus a nightly safety refresh. Dashboards show "data as of <last refresh>".

**Consequences.** Seconds-old dashboard data at worst; no extra write paths; drop-and-recreate is
always safe.
