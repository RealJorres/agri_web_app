# ADR-0023: Frontend on Netlify, API on Render
Status: Accepted · 2026-11-04 · Hosts chosen by the product owner, for a demo. Changes the serving part of
ADR-0022.

**Decision.** Netlify hosts the built frontend, and Render runs the API (`netlify.toml`, `render.yaml`).
Netlify forwards `/api/*` to Render, so the browser only ever talks to one origin. That keeps ADR-0002: the
refresh cookie stays first-party and needs no `SameSite=None`, and there is no CORS to get wrong. Express no
longer serves the frontend unless `STATIC_DIR` is set. The page's security headers now come from
`netlify.toml`, and a test keeps its policy equal to `spaCsp()`.

**What the free tiers cost, and how the app copes.**
- Render's free service sleeps after 15 idle minutes and takes about a minute to wake. Netlify's proxy is
  reported to give up at around 30 seconds, so the first request after a sleep can fail. The app says the
  server is waking up instead of showing a generic error.
- Render's free disk is wiped on every restart and sleep. The report logo therefore moved into MongoDB. It
  is small, and belongs with the settings it is part of. Uploaded workbooks and error reports stay on disk,
  so a stored file can vanish: a commit or download then says to upload again, instead of failing obscurely.
  The real workbook is loaded from a trusted machine with `import-workbook`, not through this path.
- A sleep or restart during a browser import stops it. At the next start the job is marked failed (ADR-0020).

**Personal data.** Requests carrying farmer data now pass through Netlify and Render as well as Atlas. Each
sees them unencrypted at its proxy, even though every hop is HTTPS. This is a new processor for RA 10173
purposes, and the PAO should know.

**Limits to revisit before real use.** Move to paid tiers, or a host with a lasting disk and no sleep. Atlas's
free tier has no backups the PAO could restore from. Render's outbound addresses are shared by everyone in the
region, so the Atlas access list is broader than a dedicated address would be. `TRUSTED_PROXY_COUNT` must be
checked once deployed (`docs/deployment.md`): too low puts all users in one rate-limit bucket, and too high
lets a client fake its address in the audit log.
