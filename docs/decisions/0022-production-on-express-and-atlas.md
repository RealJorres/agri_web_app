# ADR-0022: Production on Express and Atlas
Status: Accepted · 2026-11-03 (M8). ADR-0023 moves the frontend to Netlify and the logo into MongoDB.

**Serving.** One Express process serves both the API and the built frontend, so they share an origin
(ADR-0002) and there is no separate web server to run. API responses keep their strict policy
(`default-src 'none'`, `no-store`). Pages get their own, allowing the configured map tile host and
MapLibre's worker, which loads from our own built files (ADR-0016). Scripts run only from this origin. Inline styles are allowed,
because MapLibre and the charts set style attributes. Built files are cached for good, since their names
hold a hash of their content, and `index.html` is revalidated, so a release shows at once.

**HTTPS.** Node does not end TLS here. A proxy or platform does, and production requires
`TRUSTED_PROXY_COUNT` of at least 1 and an `https://` `PUBLIC_ORIGIN`. Plain page requests redirect to
that configured address, never to one built from the request's `Host` header, so they cannot be pointed
elsewhere. A plain write is refused rather than redirected, because its body has already crossed the
network unencrypted. The health check is exempt, for the host's own probe.

**The audit log stays append-only.** Postgres used a trigger. MongoDB has none that fits, so the rule moves
to the database's permissions: the running application's account has a custom role, with `find` and
`insert` only on `audit_logs`. MongoDB enforces that however the application misbehaves. A test proves it
on a real authenticated replica set, and `npm run db-role -w server -- --check` proves it on the live
cluster with the live account. The account also cannot create indexes or collections, or read other
databases, so a separate administrator's account runs the setup scripts.

**What this cost.** The role lists collections by name, because MongoDB has no "everything except" form.
A new collection therefore needs adding to the role, and the application fails with a clear authorization
error on it until then. `db-role --check` finds this. Atlas does not accept `createRole` from a client, so
setting up the role is a manual step in Atlas (`docs/deployment.md`).

**The host needs a lasting disk.** Uploads, error reports and the logo stay on a private disk (ADR-0009)
rather than moving to object storage. This keeps them out of anything served publicly with no new
dependency, but it rules out hosts with throwaway disks. Revisit this if the chosen host has none.

**One instance.** Rate limits and import jobs live in the process (ADR-0019, ADR-0020). Running two would
need both moved out first.

**Data dictionary.** `docs/data-dictionary.md` is generated from the models and a test fails if it is out
of date, replacing the generator that was a Django management command.
