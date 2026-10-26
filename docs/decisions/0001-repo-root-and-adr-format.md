# ADR-0001: Repo root and ADR format
Status: Accepted · 2026-10-26

**Context.** The brief shows a top-level `agri-dms/` folder; the working directory is `agri-dashboard/`.

**Decision.** This directory *is* the repo root (equivalent to `agri-dms/`); no extra nesting. ADRs are
short Markdown files `NNNN-kebab-title.md` with Status / Context / Decision / Consequences.
Status is `Proposed` until the product owner confirms, then `Accepted` (or `Superseded by ADR-XXXX`).

**Consequences.** Paths in the brief map 1:1 with `agri-dms/` stripped.
