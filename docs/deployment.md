# Going live

This is the runbook for the demo deployment: the frontend on Netlify, the API on Render, and the data on
MongoDB Atlas. Reasons are in ADR-0019, ADR-0020, ADR-0022 and ADR-0023.

## Before you start

- [x] PAO has approved real farmer data on the hosted database (RA 10173).
- [ ] PAO knows the data also passes through Netlify and Render (ADR-0023).
- [ ] The code is in a private Git repository that Netlify and Render can read.

## 1. Database accounts

Use two Atlas accounts:

- An **administrator's** account, for the setup in steps 2 and 3 only. Run these from a trusted machine, with
  the account in `.env`. It has `atlasAdmin`, which can change or delete anything on the cluster, so the
  server must not run with it.
- An **application** account, for Render. Create it as follows.

`npm run db-role -w server` prints the privileges, per collection (set `MONGODB_DB=agri_prod` first). In Atlas,
go to Database Access → Custom Roles and add a role named `agriApp` with those privileges. `audit_logs` gets
`find` and `insert` only, and that is what keeps the audit log append-only. Then add a database user with only
that role, and a long random password. The wording of Atlas's screens may differ. Atlas does not accept
`createRole` from a client, so this is done in Atlas itself.

## 2. Indexes and reference data

With the administrator's account:

```sh
export MONGODB_DB=agri_prod
npm run create-indexes -w server
npm run seed -w server
npm run seed-psgc -w server -- <file>         # when the PAO has supplied it
npm run seed-boundaries -w server -- --file <file> --level municipality --province Marinduque --dry-run
```

Read the boundary report before dropping `--dry-run`. A shape that fails a check is listed and not loaded.

## 3. Real data and the first administrator

Still with the administrator's account and `MONGODB_DB=agri_prod`:

```sh
npm run import-workbook -w server -- "data/raw/<workbook>.xlsx"
npm run integrity -w server
npm run create-admin -w server -- you@your.office.gov.ph
```

Check the printed figures: 212 named rows, 208 with trees, 81,712 trees, 130.74 ha, Santa Cruz +940 against the
workbook's own total. Stop if any differs. If an import stops, re-running does not duplicate rows. The admin's
password is typed at a hidden prompt. Everyone else is added in the app, under **Users**.

Then check the role with the application account, by running this with its connection string in `.env`:

```sh
npm run db-role -w server -- --check
```

It must say the role is right for every collection. It tries each operation and leaves nothing behind. If it
reports `audit_logs: can be changed`, you are still on the administrator's account.

## 4. API on Render

1. In Render, create a new Blueprint from the repository. It reads `render.yaml`.
2. Enter the values it asks for:

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | the **application** account's connection string |
   | `JWT_SIGNING_KEY` | from `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `PUBLIC_ORIGIN` | the Netlify address. Use a placeholder such as `https://placeholder.example` until step 5 |

3. Find the service's outbound addresses (its **Connect** menu) and add them to the Atlas IP access list. Avoid
   `0.0.0.0/0`.
4. Check that `https://<render address>/api/health` reports the database as `ok`.

## 5. Frontend on Netlify

1. In Netlify, import the repository. It reads `netlify.toml`.
2. Add the environment variable `API_ORIGIN`: `https://<render address>`, with no path. The build fails without it.
3. Deploy, then set `PUBLIC_ORIGIN` on Render to `https://<netlify address>`. Render restarts by itself.

## 6. Check it

- `https://<netlify address>/api/health` reports the database as `ok`, which proves the forwarding.
- You can sign in, and stay signed in after reloading the page, which proves the cookie.
- The dashboard shows 81,712 trees for the 2023 round, and the map shows tiles with no "403" on them.
- `curl -I https://<netlify address>/api/v1/auth/me` shows `Cache-Control: no-store`. If it shows Netlify's page
  headers instead, stop and fix this before real users sign in: responses hold personal data.
- Upload a test workbook through the app, to prove that a file of that size gets through the proxy. Use a
  synthetic one, and do not commit it.

## 7. Check how many proxies Render sees

Sign in, then look at the newest `audit_logs` entry's `ip` in Atlas. It should be your own public address.

- If it is an address of Netlify's, Cloudflare's or Render's, raise `TRUSTED_PROXY_COUNT` by one, and check again.
- If you can change it by sending your own `X-Forwarded-For` header straight to the Render address, lower it.

## Living with the free tiers

- **The first visit after 15 idle minutes takes about a minute.** The app says the server is waking up; try again
  shortly after. Before a demo, open `https://<render address>/api/health` a minute early.
- **The disk is wiped on every sleep.** A workbook uploaded through the app must be committed before the server
  sleeps, or uploaded again. Download error reports soon after a preview. The report logo is safe, in MongoDB.
- **The Atlas free tier has no backups to restore from.** Keep the source workbook. Anything entered in the app
  after the import could be lost.

## After a release

Pushing deploys both. Run `npm run create-indexes -w server` with the administrator's account first if an index
changed. If a new collection was added, add it to the role first (`npm run db-role -w server` shows it), then run
the check.

## Running it all on one server instead

Express can still serve the app itself, on a host with HTTPS in front and a lasting disk. Set `STATIC_DIR` to the
built `frontend/dist`, `PUBLIC_ORIGIN` to the server's own address, `TRUSTED_PROXY_COUNT` to its proxy count and
`PRIVATE_FILES_DIR` to a folder on the disk, then `npm run build` and `npm start` (ADR-0022).

## Good to know

- **Do not re-run `npm run seed`** on a live system without reading ADR-0021: it resets seeded fields on seeded
  rows, which would undo an administrator's edit to them.
- The server writes JSON logs to standard output, with no personal data in them.
- Finished imports' files are removed after `IMPORT_FILE_RETENTION_DAYS` (30).
- The default map tiles come from OpenStreetMap, for low-volume internal use. To switch, set `MAP_TILE_URL` on
  Render and change the tile host in `netlify.toml` (ADR-0016).
- The old Docker volume with the Postgres database still holds real personal data, and should be deleted. That is
  the product owner's decision, and it needs Docker one last time.
