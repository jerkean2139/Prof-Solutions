# GHL go-live checklist

The at-the-keyboard version: do these seven steps in order in the Zenoflo
GoHighLevel account, then run one command to prove it is right.

`GHL-SETUP.md` is the long form with screenshots-worth of detail and the
workflow copy. Use this page while clicking; drop into that one when a step
needs more explanation.

**Roughly 30 minutes**, most of it step 3.

Per `DECISIONS.md` (2026-08-16) this is a **Private Integration in a single
location**. There is no marketplace app and no OAuth. If someone hands you an
OAuth client ID and secret, they are solving a different problem — stop and
re-read that decision.

---

## Step 1 — Create the Private Integration token

Settings → **Private Integrations** → create one, named something like
`Profitable Solutions Ops`.

Scopes it needs: **read and write on Contacts**, plus **read on Locations**.
Contacts write is what lets the app apply tags and set custom fields. Locations
read is what lets preflight confirm the token is pointed at the right place.

Copy the token when it is shown. **It is shown once.** If your account has no
Private Integrations section, a Location API Key works the same way.

- [ ] Token created and copied somewhere safe for the moment

> Never paste this token into a chat, a commit, a code file, or a ticket. It
> goes in an environment variable and nowhere else.

## Step 2 — Get the Location ID

Open the location in GHL and read it out of the browser URL, or Settings →
Business Info. It looks like `ve9EPM428h8vShlRW1KT`.

- [ ] Location ID copied

## Step 3 — Create the six custom fields

Settings → **Custom Fields**, on the **Contact** object. Create all six. The
names are yours to choose; **the types matter**, and the IDs are what the app
actually uses.

| Field name in GHL | Type | The app writes it when |
|---|---|---|
| Sale Total Raised | Monetary (or Number) | a sale is finalized |
| Sale Unit Count | Number | a sale is finalized |
| Next Sale Target | Date | a finalize sets a next-sale target |
| Incentive | Text | a finalize sets a next-sale target |
| Tracking Number | Text | a bulk shipment is recorded |
| Carrier | Text | a bulk shipment is recorded |

- [ ] All six created

## Step 4 — Collect the six field IDs

Open each field and take its ID from the URL or the field detail panel. This is
the fiddliest step and the one preflight was written to check, so do not agonise
over it — just get them down and let the script catch a slip.

- [ ] Six IDs collected, each matched to the right field

## Step 5 — Put it all in the environment

In `.env` locally, or the Railway project variables in production:

```bash
GHL_API_KEY=<the token from step 1>
GHL_LOCATION_ID=<the ID from step 2>
GHL_CUSTOM_FIELD_IDS={"sale_total_raised":"ID1","sale_unit_count":"ID2","next_sale_target":"ID3","incentive":"ID4","tracking_number":"ID5","carrier":"ID6"}
```

`GHL_CUSTOM_FIELD_IDS` must be **one line of valid JSON**. The keys are the
app's logical names and must be spelled exactly as above; the values are your
IDs from step 4. A key the app does not recognise is ignored at runtime, which
is exactly how a typo hides — preflight warns about it instead.

- [ ] All three variables set

## Step 6 — Prove it

```bash
npm run ghl:preflight
```

It checks that the token authenticates, that the location resolves, that every
field ID exists in that location, and that no two names point at the same ID.
It only reads, never writes, and never prints your token.

Fix anything it reports and run it again until it says `PASS`. Then start the
outbound worker:

```bash
npm run worker
```

- [ ] `npm run ghl:preflight` says PASS
- [ ] Worker running

## Step 7 — Build the four workflows

Preflight cannot check this part. GHL creates a tag the moment it is applied,
so "does this tag exist" is not a meaningful question — what matters is that
something is **listening** for each one. The app sets tags and fields; GHL sends
every message (`CLAUDE.md` rule 8).

| Trigger tag | Fires when | The workflow should |
|---|---|---|
| `team-onboarded` | a team finishes registering | alert staff to build or link their store |
| `sale-complete` | a team finalizes a sale | send results using Sale Total Raised and Sale Unit Count |
| `next-sale-eligible` | the growth loop opens | invite them to book the next sale, counting down to Next Sale Target |
| `shipment-sent` | the bulk order ships | send tracking using Tracking Number and Carrier |

Workflow copy is in `GHL-SETUP.md` sections D1–D4.

- [ ] Four workflows live, each triggered by its tag

---

## The end-to-end test

Do this once on a throwaway contact before a real team touches it.

1. Register a test team → contact gets `team-onboarded` within a minute
2. Run a small sale and finalize it → contact gets `sale-complete`, and **Sale
   Total Raised** and **Sale Unit Count** hold real numbers
3. Finalize with a next-sale target → `next-sale-eligible` lands and the
   countdown reads from **Next Sale Target**
4. Ship the bulk delivery → `shipment-sent` lands with **Tracking Number** and
   **Carrier** filled

If a tag lands but its custom fields are empty, the field ID for that one is
wrong — re-run preflight, it will name it.

## What is not wired, so nobody assumes it is

- **Stores are not created automatically.** `team-onboarded` is a signal for a
  person to build or link the funnel. The app does not build storefronts.
- **The app never sends a message.** If a workflow is missing, nothing goes out
  and nothing errors — it is silent. That is why step 7 is on this list.
- **`GHL_LOCATION_ID` is not read by the running app yet**, only by preflight.
  Set it anyway: it is what proves your token points at the right location, and
  endpoints that need it are coming.

## When something is not landing

1. Is the worker running? Without `npm run worker` nothing is sent.
2. Is `GHL_API_KEY` set in *that* environment? Without it the app logs what it
   would have sent and skips. Deliberate, so nothing breaks before you are ready
   — but it looks identical to a silent failure if you are not expecting it.
3. Run `npm run ghl:preflight` again. Tokens get revoked and fields get deleted.
4. Still stuck: the app logs every GHL call with its request, response, and
   status. The answer is in there.
