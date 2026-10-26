# ADR-0006: Soft delete, partial unique constraints, and PII erasure
Status: Accepted · 2026-10-26

**Decision.** `BaseModel` has `deleted_at`/`deleted_by`; the default manager hides deleted rows and
`all_objects` includes them. All uniqueness constraints are partial
(`condition=Q(deleted_at__isnull=True)`) so a deleted row never blocks re-creation. Deletes go through
services and are audited.

Soft delete keeps personal data, so a separate audited `registry.services.erase_farmer_personal_data()`
(system_admin only) blanks PII fields for RA 10173 erasure requests while keeping anonymous inventory
counts. Audit `before/after` snapshots mask PII values (they record that a personal field changed, not
its value), so erasure is meaningful.

**Consequences.** Data-subject erasure is possible without breaking historical totals.
