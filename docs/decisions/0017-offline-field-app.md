# ADR-0017: Offline field app scope
Status: Proposed · 2026-10-27

**Decision.** Offline support is limited to field encoders capturing inventory *drafts* (and new
farmers/farms) for their assigned barangays. The device caches only that subset (Dexie/IndexedDB),
clears it on sign-out, and queues writes with an `Idempotency-Key` so a retried sync never duplicates
a record. The server runs the normal services on sync; validation errors and conflicts (record changed
meanwhile) come back to the device for the encoder to resolve: never last-write-wins. Workflow actions
beyond submit (validate/approve) stay online-only.
