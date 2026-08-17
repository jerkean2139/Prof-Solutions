# RUNBOOK: operating the Profitable Solutions system

This is the "how to run it" guide. `README.md` explains what the system is and
how to develop it. This file is the day-to-day operations manual: start it, ship
it, check it, and turn on the pieces that need keys.

Every command here is real and lives in `package.json`. Anything that needs a
key or a login to an outside service is called out plainly. Never paste a secret
into a chat, a commit, or a code file. Secrets go in environment variables only.

## What this system is, in one breath

GoHighLevel is the front door (storefronts, texts, emails, ACH payments). This
app is the engine behind it (products, inventory, sales, orders, fulfillment,
commissions). They talk through tags and custom fields. This app never sends a
message and never touches a bank number.

## What you need before anything

- Node 20 or newer
- A Postgres database (version 14+)
- A Redis instance (version 6+)

On Railway, Postgres and Redis are add-ons you provision once. Everywhere else
they are two connection URLs you paste into the environment.

## The environment variables

Copy `.env.example` to `.env` and fill it in. The must-haves to boot at all:

- `DATABASE_URL` — the Postgres connection string
- `REDIS_URL` — the Redis connection string

The rest have safe defaults and can stay empty until you are ready for them.
The ones that turn on real outside services:

- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `AUTH_ENFORCED` — staff login
- `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_CUSTOM_FIELD_IDS` — GoHighLevel
- `ACCEPT_BLUE_WEBHOOK_SECRET` — verifies inbound payment webhooks
- `ANTHROPIC_API_KEY` — the read-only ops question box (Phase 3)

The app refuses to start if `AUTH_ENFORCED=true` and there is no
`CLERK_SECRET_KEY`. That is on purpose: a bad setup fails loudly instead of
letting everyone in.

## First-time setup

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and REDIS_URL
npm run migrate:up        # build all the tables
npm run seed              # load fake demo data (refuses to run in production)
```

What you'll see: `migrate:up` prints one "applied migration" line per step.
`seed` runs the whole money-in loop once so screens have something to show.

## Running it locally

```bash
npm run dev               # the web app + API, on http://localhost:3000
npm run worker            # the background sender that talks to GoHighLevel
```

Open `http://localhost:3000/app/` for the installable app (order entry,
receiving, sales, fulfillment, catalog, dashboard, payouts, team portal).

What you'll see: the terminal for `npm run dev` prints "server listening". If it
prints a red error about the environment, a required variable is missing or
malformed; the message names the exact one.

## The daily flows (all in the app at /app/)

1. **Catalog** — add products and SKUs. A SKU you add is instantly scannable in
   Receiving.
2. **Sales** — start a sale for a team, pick the products it offers, open it.
3. **Order entry** — take paper and phone orders fast. Online orders arrive from
   the GoHighLevel store on their own.
4. **Receiving** — scan or type a code, enter a quantity, receive. Corrections
   live under "Adjust / correct a count" and always ask for a reason.
5. **Fulfillment** — finalize a sale, generate the bulk pick list, pick, ship
   one delivery, then settle it.
6. **Payouts** — approve and pay the commissions a settlement accrued.
7. **Dashboard** — the whole business at a glance, with CSV export for the
   spreadsheet work you still want to do in Excel.

## Deploying to Railway

Railway builds from the repo and runs the app. You set the same environment
variables in the Railway project settings that you have in your local `.env`,
plus the Postgres and Redis URLs Railway gives you.

Run these once against the production database, from a shell that has the
production `DATABASE_URL` set (do NOT run `seed` in production):

```bash
npm run migrate:up
```

Two processes run in production, both from this repo. Both run the compiled
output, so the build runs first (Railway runs `npm run build` for you because
this repo has a `build` script):

- build once per deploy: `npm run build`
- the web app: `npm start`
- the background sender: `npm run start:worker`

The CI workflow has a deploy step that stays inert until `RAILWAY_TOKEN` is set
as a GitHub secret. Add that token to let merges deploy.

## The smoke test after every deploy

Green tests are not a working feature. After a deploy, check the live app:

1. `GET /health` returns `{"ok":true,"db":"up"}`. If `db` is down, the database
   URL is wrong or the database is asleep.
2. Open `/app/` and load the Dashboard. Numbers appear, no error banners.
3. In Catalog, add a throwaway product and SKU. It shows in the list.
4. In Receiving, scan or type that SKU and receive 1. On-hand goes up by 1.
5. If GoHighLevel is wired, send a test store order and confirm it appears in
   the team's order history.

If any step fails, the deploy is not done. Fix it before calling it complete.

## Turning on staff login (Clerk)

1. In Clerk, create the application and copy the secret and publishable keys.
2. Set `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`.
3. While login is still off, add each staff member to the `users` table with
   their `clerk_user_id`, so their actions have an owner.
4. Set `AUTH_ENFORCED=true` and restart.

What you'll see: with login off, the app runs as a single mock user. With it on,
a request without a valid Clerk token gets a 401.

## Turning on GoHighLevel

Follow `GHL-GO-LIVE.md`: seven steps, about thirty minutes, with `GHL-SETUP.md`
as the long form when a step needs more detail. In short: create the custom
fields it lists, put their IDs in `GHL_CUSTOM_FIELD_IDS`, set `GHL_API_KEY` and
`GHL_LOCATION_ID`, and run the worker (`npm run start:worker`). Without
`GHL_API_KEY` the worker logs what it would send and skips, so nothing breaks
before you are ready.

Before trusting it with a real team, prove the wiring:

```bash
npm run ghl:preflight
```

It verifies the token authenticates, the location resolves, every custom field
ID exists in that location, and no two logical names point at the same ID. It
only reads, never writes, and never prints the token. A wrong field ID is
otherwise silent — the app skips an unmapped field with a warning rather than
guessing — so this is the difference between finding out now and finding out on
a real team's finalize.

What it cannot check: whether a workflow is listening for each trigger tag.
GHL creates a tag when it is applied, so that part is eyes-on (step 7).

## The read-only ops question box (Phase 3)

`GET /agent/schema` works today and lists the tables. `POST /agent/query` — and
the **Ask** tab in the app — turn on as soon as `ANTHROPIC_API_KEY` is set; until
then they say plainly that they are not configured. Every query it will ever run
is read-only, three ways over: a SQL guard, a SELECT-only database role, and a
read-only transaction.

To turn it on: set `ANTHROPIC_API_KEY` and restart. Then open **Ask** and try one
of the example questions. What you'll see: the answer as a table, with the SQL it
ran behind "Show the SQL this ran".

This is the one piece that has never been run against the live API, so treat the
first few questions as the verification step: check the SQL under a couple of
answers and confirm the numbers match what the Dashboard shows. If a question
comes back wrong, the SQL will tell you why — send it over rather than guessing.

## Backups

Postgres is the system of record and the inventory ledger is append-only, so a
regular Postgres backup is the whole story. On Railway, turn on database
backups. Redis is only a cache and a job queue; it can be rebuilt and does not
need backing up. The inventory snapshot cache can always be rebuilt from the
ledger with `npm run snapshot:rebuild`.

## When something looks wrong

- **A screen is blank or shows an error line.** Open `/health`. If the database
  is down, that is the cause. If it is up, the browser console names the failing
  request.
- **On-hand looks off.** It is a cache. Run `npm run snapshot:rebuild`; it
  recomputes every number from the append-only ledger and is always safe to run.
- **GoHighLevel is not getting updates.** Confirm the worker is running and
  `GHL_API_KEY` is set. The worker retries and, after three failures, parks the
  job in a dead-letter queue rather than losing it.
- **Migrations will not apply.** Never edit the database by hand. Fix it with a
  new checked-in migration and `npm run migrate:up`.
