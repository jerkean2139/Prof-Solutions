# Deploying to Railway (first time)

The click-by-click version of the Railway section in `RUNBOOK.md`, for someone
who has not set up hosting before. Roughly 30 minutes.

Do this **before** `GHL-GO-LIVE.md`: the GoHighLevel store posts orders to a
public URL, and there is nothing to point it at until this is done.

## What you end up with

Four boxes in one Railway project.

| Box | What it is | Public URL? |
|---|---|---|
| web | The app and the API | Yes |
| worker | The background sender for GoHighLevel | No |
| Postgres | The system of record | No |
| Redis | The outbound job queue | No |

**The build and start commands are already in the repo** — `railway.json` for
web, `railway.worker.json` for the worker. You do not type start commands
anywhere. The only thing you tell Railway about the worker is which of those two
files it should read.

> **Do not set a Custom Start Command in the Railway UI.** It overrides the
> config file, which is where the pre-deploy migration step lives. A manual start
> command silently skips migrations and the app boots against a database with no
> tables.

## 1. Project and add-ons

Sign in to Railway with GitHub, then **New Project → Deploy from GitHub repo →
Prof-Solutions**. The first build fails; it has no database yet.

In the same project: **Create → Database → PostgreSQL**, then **Create →
Database → Redis**.

## 2. Variables on the web service

Everything in `.env.example` belongs here. The two that come from Railway rather
than from you:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
REDIS_URL    = ${{Redis.REDIS_URL}}
```

Paste those literally — braces and all. They are references, not placeholders.
A pasted connection string works until the add-on rotates its password, and then
fails as an authentication error weeks after the deploy that caused it.

Also set:

```
NODE_ENV     = production
DATABASE_SSL = auto
AUTH_ENFORCED = false
```

`DATABASE_SSL=auto` reads `sslmode` out of the URL, which is right for both the
private URL and the public proxy URL. **Do not set `PORT`** — Railway injects it,
and a hardcoded one is how a healthy app gets reported as having no open ports.

## 3. Deploy and check

Redeploy and wait for green. Then **Settings → Networking → Generate Domain**.

- `GET /health` → `{"ok":true,"db":"up","authEnforced":false}`
- `/app/` loads the app

Keep the domain. `GHL-GO-LIVE.md` step 7 points the store webhook at
`https://<domain>/webhooks/ghl`.

Migrations already ran: `railway.json` runs `npm run migrate:deploy` as a
pre-deploy command, so the schema is applied before the new version takes
traffic, and a failed migration blocks the rollout instead of half-breaking a
live one. Nobody touches the database by hand (rule 11).

## 4. The worker service

**Create → GitHub Repo →** the same repo, then:

1. **Settings → Config-as-code → Railway Config File** → `railway.worker.json`
2. Add the same variables from step 2
3. No domain

Step 1 is the one that matters. Without it the service reads `railway.json`,
and you get two web servers and nothing draining the queue.

Confirm from its logs: `ghl outbound worker started`. Without this service the
app queues GoHighLevel jobs that nothing ever sends — and nothing errors, so it
is indistinguishable from working until a team mentions they were never
messaged.

## Never seed production

`npm run seed` wipes and reloads mock data. It refuses to run when
`NODE_ENV=production` (`src/seed/seed.ts`). Do not work around that.

## Optional: deploy on merge

The CI workflow already has a deploy job, inert until you add both:

- `RAILWAY_TOKEN` — a repo **secret**
- `RAILWAY_SERVICE` — a repo **variable**, the web service's name

With both set, a merge to `main` deploys after tests pass.

## Adding keys later

Each is a variable on the web service — and, for the GoHighLevel ones, the
worker too.

| Variable | Turns on | Guide |
|---|---|---|
| `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_CUSTOM_FIELD_IDS` | Storefront, messaging, growth loop | `GHL-GO-LIVE.md` |
| `ACCEPT_BLUE_WEBHOOK_SECRET` | Verified ACH payment webhooks | `GHL-SETUP.md` |
| `ANTHROPIC_API_KEY` | The Ask tab | `README.md` |
| `CLERK_SECRET_KEY` + `AUTH_ENFORCED=true` | Staff login | `RUNBOOK.md` |

## When a deploy fails

`RUNBOOK.md` has the log-message-to-cause table. The short version: read the
**first** error, not the loudest one — a wall of identical stack traces is one
dependency down, and the real cause is above it.
