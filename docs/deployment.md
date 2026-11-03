# Going live

This is the runbook for production, in order. Nothing real reaches Atlas until step 5, and that step
needs the PAO's approval first. Reasons are in ADR-0019, ADR-0020 and ADR-0022.

## Before you start

- [ ] PAO has approved putting real farmer data on the hosted database (RA 10173).
- [ ] PAO has confirmed the farmer count rule (ADR-0015).
- [ ] The Atlas tier and region are chosen, and backups are confirmed for that tier. Free and shared
      tiers have limited or no backups, so check this before loading anything you need to keep.
- [ ] A host is chosen. It must provide all of:
  - Node 22;
  - HTTPS, ended by a proxy or platform in front of the app. This server does not end TLS itself;
  - **a disk that survives restarts** for `PRIVATE_FILES_DIR`. Uploaded workbooks, error reports and the
    report logo live there. A host with a throwaway disk would lose them;
  - one running instance. Sign-in rate limits and background import jobs are held in that process.
- [ ] The host's outgoing address is on the Atlas IP access list. Avoid `0.0.0.0/0`.

## 1. Settings

Set these in the host's secret store, not in a file in the repository:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | the connection string. See step 3 for which account |
| `MONGODB_DB` | `agri_prod`. Must differ from development's `agri_dev` |
| `JWT_SIGNING_KEY` | a random value of 50+ characters |
| `PUBLIC_ORIGIN` | `https://your.address`, with no path |
| `TRUSTED_PROXY_COUNT` | how many proxies are in front, usually `1`. Too low breaks HTTPS detection; too high lets clients fake their address |
| `PRIVATE_FILES_DIR` | a private folder on the lasting disk |
| `HOST` | `0.0.0.0` if the proxy is on another machine, otherwise leave it |
| `PORT` | what the proxy forwards to |

The server refuses to start if a required value is missing or weak.

## 2. Build

```sh
npm ci
npm run build
```

## 3. Database accounts

Use two Atlas accounts:

- An **administrator's** account, for steps 4 and 5 only. Your current account has `atlasAdmin`, which
  can change or delete anything on the cluster, so it should not be what the app runs with.
- An **application** account, for the running server. Create it as follows.

`npm run db-role -w server` prints the privileges, per collection. In Atlas, go to Database Access →
Custom Roles and add a role named `agriApp` with those privileges. `audit_logs` gets `find` and `insert`
only, and that is what keeps the audit log append-only. Then add a database user with only that role. The
wording of Atlas's screens may differ. Atlas does not accept `createRole` from a client, so this is done
in Atlas itself.

The application account cannot create collections or indexes, so step 4 needs the administrator's.

## 4. Indexes and reference data

With `MONGODB_URI` set to the **administrator's** account:

```sh
npm run create-indexes -w server
npm run seed -w server
npm run seed-psgc -w server -- <file>         # when the PAO has supplied it
npm run seed-boundaries -w server -- --file <file> --level municipality --province Marinduque --dry-run
```

Read the boundary report before dropping `--dry-run`. A shape that fails a check is listed and not loaded.

## 5. Real data (needs PAO approval)

Still with the administrator's account:

```sh
npm run import-workbook -w server -- data/raw/cacao_production_data_as_of_july_2023.xlsx
npm run integrity -w server
```

Check the printed figures before going further: 212 named rows, 208 with trees, 81,712 trees, 130.74 ha,
Santa Cruz +940 against the workbook's own total. Stop if any differs.

A large import is bulk-written to stay inside MongoDB's 60-second transaction limit (ADR-0020). If it is
stopped, re-running does not duplicate rows.

## 6. First administrator

```sh
npm run create-admin -w server -- you@your.office.gov.ph
```

The password is typed at a hidden prompt. Everyone else is added in the app, under **Users**.

## 7. Start with the application account

Switch `MONGODB_URI` to the **application** account, then:

```sh
npm run db-role -w server -- --check
npm start
```

The check must say the role is right for every collection. It tries each operation and leaves nothing
behind. If it reports `audit_logs: can be changed`, you are still on the administrator's account.

Then check that:

- `https://your.address/api/health` reports the database as `ok`;
- `http://your.address/` redirects to HTTPS;
- you can sign in, and the dashboard shows 81,712 trees for the 2023 round.

## After a release

```sh
npm ci && npm run build
```

Run `npm run create-indexes -w server` with the administrator's account if an index changed. If a new
collection was added, add it to the role first (`npm run db-role -w server` shows it), then run the
check. Restart the server afterwards.

## Good to know

- **Do not re-run `npm run seed`** on a live system without reading ADR-0021: it resets seeded fields on
  seeded rows, which would undo an administrator's edit to them.
- `npm start` writes JSON logs to standard output, with no personal data in them.
- Finished imports' files are removed after `IMPORT_FILE_RETENTION_DAYS` (30). The logo is kept.
- The default map tiles come from OpenStreetMap, for low-volume internal use. Switch `MAP_TILE_URL` before
  any public use (ADR-0016). The page's security policy follows that setting.
- After cutover, the old Docker volume with the Postgres database still holds real personal data, and
  should be deleted. That is the product owner's decision, and it needs Docker one last time.
