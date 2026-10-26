# ADR-0010: Viewer role gets aggregate endpoints only
Status: **Proposed** · 2026-10-26

**Context.** §7 says viewers use aggregated endpoints only *and* that serializers drop personal fields
for viewers. Doing both means maintaining redacted variants of every record-level serializer.

**Decision.** Viewers receive **403** on all record-level endpoints (farmers, farms, association
members, inventory records, imports, exports) and can call only aggregate endpoints (home stats, round
progress, later analytics) plus reference data. A `PersonalFieldsMixin` still strips personal fields for
any role lacking the `view_personal_data` capability, as defence in depth and for future roles.

**Consequences.** Smaller attack surface; one permission check instead of per-field redaction everywhere.
