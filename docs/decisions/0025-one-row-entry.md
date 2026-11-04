# ADR-0025: One row of data entered by hand
Status: Accepted · 2026-11-04 · Requested by the product owner: a provincial encoder should be able to enter one
row, not only import a workbook.

**Problem.** The permission already existed, but entry took four screens: new farmer, add farm, add crop, record
inventory. A partial stop left a farmer with no record.

**Decision.** `POST /inventory-entries` takes one row and `services/entry.service.ts` runs the existing services
in one transaction, so their rules, scoping and audit entries still apply and a refusal leaves nothing behind. The
**New entry** page (`/inventory/entry`) is its form, and is open to anyone with `edit_records`. It follows the
capability rule rather than naming the provincial encoder, so municipal validators and field encoders get it too.

**Rules worth knowing.**
- Unlike an import, a hand-entered new farmer always needs recorded consent.
- A registered farmer's farm is reused when the barangay matches and, if a sitio was given, the sitio too. Otherwise
  a new farm is created. A crop stand is reused the same way.
- A row holds one variety and one planting year. Further plantings go on the farmer's page.
- "Save and submit" makes two requests. If the submit is refused, the draft stays and its page opens.
