# Deploying to Railway (first time)

Getting the app onto the internet. Do this **before** the GoHighLevel setup in
`GHL-GO-LIVE.md`: the GHL store posts orders to a public URL, so there is nothing
to point it at until this is done.

About 30 minutes. `RUNBOOK.md` covers running it day to day once this is done.

## What you end up with

Four boxes in one Railway project:

| Box | What it is |
|---|---|
| App | The web app and JSON API. This one gets a public domain. |
| Worker | The background sender that talks to GoHighLevel. No domain. |
| Postgres | The system of record. |
| Redis | The outbound job queue and cache. |

## 1. Project and add-ons

Sign in to Railway with GitHub, then **New Project → Deploy from GitHub repo →
Prof-Solutions**. The first build fails; it has no database yet.

Add both add-ons to the same project: **Create → Database → PostgreSQL**, then
**Create → Database → Redis**.

## 2. Variables on the app service

```
DATABASE_URL   = ${{Postgres.DATABASE_URL}}
REDIS_URL      = ${{Redis.REDIS_URL}}
NODE_ENV       = production
AUTH_ENFORCED  = false
```

The `${{...}}` values are Railway references, not placeholders — paste them
literally. **Do not set `PORT`**: Railway injects it and the server reads it
(`src/http/server.ts` listens on `env.PORT`).

`AUTH_ENFORCED=false` keeps Clerk enforcement off for the pilot (rule 9). The app
refuses to start with enforcement on and no `CLERK_SECRET_KEY`, so flipping it
later is a deliberate, two-variable change.

## 3. Start command that migrates

Set the app service's **Custom Start Command** to:

```bash
npm run migrate:up && npm start
```

Migrations are tracked in `schema_migrations` and skip what is already applied,
so this is safe on every restart and every redeploy. It also means the database
is never modified by hand (rule 11).

Railway runs `npm run build` for you because the repo has a `build` script;
`npm start` runs the compiled output from `dist/`.

## 4. Domain and health check

**Settings → Networking → Generate Domain.** Then check:

- `GET /health` returns `{"ok":true,"db":"up","authEnforced":false}`
- `/app/` loads the PWA

A `db` that is not `up` means `DATABASE_URL` is wrong — it must be the
`${{Postgres.DATABASE_URL}}` reference, not a pasted connection string.

Keep the domain: `GHL-GO-LIVE.md` step 7 points the store webhook at
`https://<domain>/webhooks/ghl`.

## 5. The worker service

**Create → GitHub Repo →** the same repo, then:

- the same four variables from step 2
- **Custom Start Command:** `npm run start:worker`
- no domain

Confirm from its logs: `ghl outbound worker started`. Without this service the
app queues GHL jobs that nothing ever sends — and nothing errors, so it looks
identical to working.

## Never seed production

`npm run seed` wipes and reloads mock data. It refuses to run when
`NODE_ENV=production` (`src/seed/seed.ts`). Do not work around that.

## Optional: deploy on merge

The CI workflow already has a deploy job, inert until you add both of:

- `RAILWAY_TOKEN` — a repo **secret**
- `RAILWAY_SERVICE` — a repo **variable**, set to the app service's name

With those set, a merge to `main` deploys after tests pass. Without them the job
logs why it skipped and exits clean.

## Adding keys later

Everything else is a variable on the app service (and, for the GHL ones, the
worker too):

| Variable | Turns on | Guide |
|---|---|---|
| `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_CUSTOM_FIELD_IDS` | Storefront, messaging, growth loop | `GHL-GO-LIVE.md` |
| `ACCEPT_BLUE_WEBHOOK_SECRET` | Verified ACH payment webhooks | `GHL-SETUP.md` |
| `ANTHROPIC_API_KEY` | The Ask tab | `README.md` |
| `CLERK_SECRET_KEY` + `AUTH_ENFORCED=true` | Staff login | `RUNBOOK.md` |
