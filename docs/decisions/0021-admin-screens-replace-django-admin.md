# ADR-0021: Admin screens replace the Django admin site
Status: Accepted · 2026-11-03 (M7)

**Context.** Staff accounts, the catalog and report settings were maintained in Django's built-in admin
site. Express has no equivalent, so these needed their own routes and screens (ADR-0019).

**Decision.** `/api/v1/admin/*` routes, open only to the `admin` capability, with screens under
`/admin/` in the app: users and assignments, crops with stages and varieties, material sources, and
report settings with signature blocks. Every change is audited in the same transaction as the change.

**Rules these screens add.**
- Accounts are deactivated, never deleted, because audit entries point at them. A deactivated person
  is refused at once, and their sessions are revoked.
- You cannot deactivate your own account, or give up your own system admin role if no other active
  administrator would remain.
- A system admin assignment always covers everything. One limited to a town would still reach every
  account and the whole catalog, so it is refused.
- Superuser is not settable here. It stays with `npm run create-admin -w server`.
- A code never changes once created. A commodity's program and measure cannot change once it has crop
  stands or rounds, because those copy its program key and their counts assume the measure.
- A stage, variety or source that records use cannot be removed.
- An import spelling (alias) that two entries would share is refused when typed, because imports match
  aliases exactly and must never have to guess. Aliases appear only on admin routes.
- A logo is tried in a throwaway PDF at upload, so a damaged image is refused there. PNG and JPEG only,
  2 MB at most.
- Letterhead, program line and signature blocks are part of a report's signed content, so changing them
  marks existing sign-offs as superseded. The settings page says so.

**Left out, for now.**
- Units, municipalities and barangays have no screens. Units come from the seed, and locations from the
  PSGC loader.
- An audit log browser. Entries are written and shown per record, with no search across them.
- An RA 10173 erasure screen. The service exists, and the PAO has yet to decide whether it is needed.

**Known limits.**
- Re-running `npm run seed` resets seeded fields on seeded rows, so it would undo an administrator's
  edit to, for example, a seeded crop's plants per hectare. Aliases and added rows are kept.
- Changing plants per hectare or the bearing flag changes figures worked out for past rounds. Both are
  audited, and the plants-per-hectare field warns about this.
- The report's program line is one setting for all crops, so a crop in another program needs it changed
  before printing.
- A program change and a new crop stand arriving at the same moment are not locked against each other.
  This needs an administrator acting in the same instant as an encoder, on a crop with no stands yet.
