# ADR-0009: Uploaded workbooks and error reports are private, short-lived files
Status: Accepted · 2026-10-26

**Context.** Uploaded workbooks and generated error reports contain personal data.

**Decision.** Store them under a private storage root (`PRIVATE_MEDIA_ROOT`, never served as static or
public media); download only through an authenticated, scoped, audited endpoint. Store the SHA-256
file hash on `import_job` for idempotency. A Celery beat task deletes the files of committed or failed
jobs after `IMPORT_FILE_RETENTION_DAYS` (default 30); the job row and summary remain.
`import_job.summary` contains review items with raw values, so it is treated as personal data and
scoped like farmers. Logs never include cell values.

**Consequences.** Minimal PII footprint outside the main tables.
