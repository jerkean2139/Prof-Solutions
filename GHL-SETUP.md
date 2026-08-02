# GoHighLevel Setup Guide

This is the from-scratch guide for setting up GoHighLevel so it works with the Profitable Solutions app. Hand this to whoever owns the GHL account. Follow it top to bottom. Every value you create here gets pasted into the app's settings at the end.

## What you are setting up, in one picture

GoHighLevel is the front door. The app is the engine behind it.

- **GoHighLevel does:** the team stores, the buyer checkout and ACH payment, all texts and emails, and the contact records.
- **The app does:** products, inventory, orders, pick lists, shipping, and the numbers.

They talk to each other two ways:
1. **App to GHL:** the app puts a **tag** and some **custom fields** on a contact. Your GHL **workflow** sees the tag and sends the message. The app never sends a message itself.
2. **GHL to app:** when a buyer checks out on a team store, GHL sends the order to the app through a **webhook** (a web address the app listens on).

You will set up both directions below.

## Before you start, you need

- A GoHighLevel **sub-account** (also called a **location**) for Profitable Solutions, with you as an admin.
- **Accept Blue** connected in that sub-account for ACH payments. If it is not connected yet, do that first in GHL payment settings.
- The app deployed and reachable at a public web address. Write it here so you have it while you work:
  - App address: `https://__________` (example: `https://prof-solutions.up.railway.app`)
- About 60 to 90 minutes.

Menu names in GoHighLevel move around between versions. If a menu is not where this guide says, use the search box at the top of GHL and type the thing you are looking for.

---

# Part A: Get the API token and Location ID

The app needs a token to talk to GHL, and it needs to know which location to talk to.

## A1. Create a Private Integration token

1. In your Profitable Solutions sub-account, open **Settings**.
2. Find **Private Integrations** (it may be under a "Business Services" or "API" area).
   - **What you'll see:** a page that says Private Integrations with a button to add one.
3. Click **Create new integration** (or the plus button).
4. Name it `Profitable Solutions App`.
5. Turn on these permissions (scopes). Turn on the read and write version of each where offered:
   - **Contacts** (view and edit)
   - **Contacts / Tags** (add tags)
   - **Custom Fields** (view)
   - **Workflows** (view)
   - **Opportunities** (view) if you plan to use the rep pipeline later
6. Click **Create** and **copy the token** it shows you.
   - **What you'll see:** a long string of letters and numbers. This is shown once.
7. Paste it somewhere safe for now. This becomes `GHL_API_KEY` in Part F.

If your account does not have Private Integrations, use a **Location API Key** instead (Settings, then Business Info or API Keys). Either works as the token.

## A2. Get the Location ID

1. Still in **Settings**, open **Business Info** (or **Company** / **Business Profile**).
2. Find the **Location ID** (sometimes shown in the web address as `location/XXXXXXXX`).
   - **What you'll see:** a short code of letters and numbers.
3. Copy it. This becomes `GHL_LOCATION_ID` in Part F.

---

# Part B: Create the custom fields

The app writes results onto the team's contact record using custom fields. You create the fields here, then collect their IDs so the app knows where to write.

## B1. Add each field

1. In **Settings**, open **Custom Fields**.
2. Click **Add Field** and create each row in this table. Put them on the **Contact** object. Use the exact **Field name** shown.

| Create this field | Type | What the app writes into it |
|---|---|---|
| Sale Total Raised | Currency or Text | dollars a finished sale brought in |
| Sale Unit Count | Number | how many units the finished sale sold |
| Next Sale Target | Date or Text | the date the team's next sale is targeted for |
| Incentive | Text | the offer for registering the next sale |
| Tracking Number | Text | the shipment tracking number |
| Carrier | Text | the shipping carrier (like UPS) |

- **What you'll see:** each field appears in your custom fields list after you save it.

## B2. Collect the field IDs

The app matches fields by their **ID**, not their name, because names can change.

1. Open each field you just made and find its **Field ID** (or **Key**). It may be in the field's detail panel or the web address when you edit it.
   - **What you'll see:** a code of letters and numbers, different for each field.
2. Fill in this table as you go. You will paste it into the app in Part F.

| App name (do not change) | Your GHL field ID |
|---|---|
| `sale_total_raised` | |
| `sale_unit_count` | |
| `next_sale_target` | |
| `incentive` | |
| `tracking_number` | |
| `carrier` | |

If you skip a field, the app just skips writing it. It will not break. It will not guess an ID.

---

# Part C: Create the tags

The app puts these tags on a team's contact. Your workflows (Part D) watch for them. Create them now so they exist.

1. In **Settings**, open **Tags**.
2. Click **Add Tag** and create each of these, spelled exactly:

| Tag | The app adds it when |
|---|---|
| `team-onboarded` | a team finishes registering and their store should be built |
| `sale-complete` | a team finalizes a sale (totals are ready) |
| `next-sale-eligible` | the growth loop should invite them to register their next sale |
| `shipment-sent` | the team's bulk order has shipped |

- **What you'll see:** each tag in your tag list.

---

# Part D: Build the workflows

A workflow is the part that actually sends a message. Each one starts from a tag the app added and reads the custom fields the app wrote. Build these four.

For every workflow: **Trigger** is "Contact Tag" (fires when the tag is added), and the **filter** is the tag from the table.

## D1. New team onboarded

- **Trigger tag:** `team-onboarded`
- **Do:** send the team a welcome message, and this is where you build or link their **team store** (Part E). If you build stores by hand today, this is your signal to build one.

## D2. Sale results

- **Trigger tag:** `sale-complete`
- **Do:** send the team an email or text with their totals. Use the merge fields for **Sale Total Raised** and **Sale Unit Count** so the message shows real numbers.
- **What you'll see:** when testing, the message shows the dollars and unit count the app wrote.

## D3. Next sale growth loop (with countdown)

- **Trigger tag:** `next-sale-eligible`
- **Do:** invite the team to register their next sale. Use the **Incentive** field for the offer and **Next Sale Target** for the countdown date.
- Tip: you can add a wait step and a reminder a few days before the **Next Sale Target** date so the countdown feels real.

## D4. Shipment sent

- **Trigger tag:** `shipment-sent`
- **Do:** tell the team their delivery is on the way. Use the **Tracking Number** and **Carrier** fields in the message.

---

# Part E: The team store and the order webhook

This is the most involved part. It is how buyers order and how those orders reach the app.

## E1. Build the team store funnel

1. Build a **funnel** (or store page) that lists the products for a sale, with a checkout.
2. Turn on **Accept Blue ACH** as the payment method on the checkout.
   - **What you'll see:** buyers can pay by bank account (ACH), not just card.
3. The store shows products at the **$45** unit price (or the sale's price if it differs).

## E2. The seller link

Sellers (team players and parents) share their own link so they get credit.

- A seller's link is the store address with their code on the end, like:
  `https://yourstore.com/northside?sellerCode=NS-JORDAN`
- The part that matters is `sellerCode=`. The value is the seller's code from the app.
- Set up the funnel to **capture the `sellerCode` from the web address** and carry it through checkout, so it can be sent to the app with the order. An order with no code still works; it just credits the team, not a person.

## E3. Send the order to the app

When a buyer checks out, GHL must tell the app. Build a workflow for this.

- **Trigger:** order submitted / form submitted on the store funnel.
- **Action:** a **Webhook** (POST) to your app at:
  `POST https://YOUR-APP-ADDRESS/webhooks/ghl`
- **Body:** send this exact shape (fill the values from the order's merge fields):

```json
{
  "type": "order.created",
  "order": {
    "campaignId": "the app's sale id for this store",
    "buyer": {
      "ghlContactId": "the buyer's GHL contact id",
      "displayName": "buyer name",
      "email": "buyer email",
      "phone": "buyer phone"
    },
    "sellerCode": "NS-JORDAN",
    "lines": [
      { "skuId": "the app's SKU id", "quantity": 2 }
    ],
    "payment": {
      "amount": "90.00",
      "status": "authorized",
      "acceptBlueRef": "the Accept Blue transaction id",
      "ghlTransactionId": "the GHL transaction id"
    }
  }
}
```

**Important, read this:** the app identifies the sale and products by **the app's own IDs** (`campaignId` and `skuId`), not GHL's. So the store has to know those IDs. The practical way to do that today:

- When the app creates a sale and its store, it has the `campaignId` and the `skuId` for each product. Store those on the funnel as **hidden fields** or **custom values**, one per product, so the checkout workflow can put them in the webhook body above.
- The person who sets up a team's store pastes those IDs in once, from the app.

This is the rough edge of the integration. It works, but it means store setup includes copying a few IDs from the app. If that becomes a burden across many teams, tell the dev team and we can add an app endpoint that accepts GHL's product IDs and looks up the app IDs itself, so you would not copy anything. That enhancement is not built yet, and this guide does not pretend it is.

## E4. Optional: send contact and org updates to the app

The app can also take a nightly refresh, but at minimum set up:

- A webhook on **new organization / contact** if you want the app to learn about teams created in GHL. Not required to take orders.

---

# Part F: Put the values into the app

Now paste everything you collected into the app's environment settings (on Railway, this is the service's Variables tab).

| Setting | What to paste |
|---|---|
| `GHL_API_BASE` | `https://services.leadconnectorhq.com` (leave as is) |
| `GHL_API_KEY` | the token from A1 |
| `GHL_LOCATION_ID` | the Location ID from A2 |
| `GHL_CUSTOM_FIELD_IDS` | the field IDs from B2, as JSON (see below) |
| `GHL_RATE_LIMIT_MAX` | `10` (leave as is unless told otherwise) |
| `GHL_RATE_LIMIT_DURATION_MS` | `1000` (leave as is) |
| `ACCEPT_BLUE_WEBHOOK_SECRET` | the signing secret from your Accept Blue / GHL webhook, if you use one |

The `GHL_CUSTOM_FIELD_IDS` value is one line of JSON that maps each app name to your field ID from B2. Replace the example IDs with yours:

```json
{"sale_total_raised":"YOUR_ID","sale_unit_count":"YOUR_ID","next_sale_target":"YOUR_ID","incentive":"YOUR_ID","tracking_number":"YOUR_ID","carrier":"YOUR_ID"}
```

After you save these, **restart the app and start the worker** (`npm run worker`, or the `start:worker` process on Railway). The worker is what actually makes the GHL calls. If it is not running, tags and fields will not go out.

---

# Part G: Verify it works (do not skip)

Run this end to end once on a test team.

1. **Token works:** in the app, register a test team. Then in GHL, open that team's contact.
   - **Pass:** the contact has the `team-onboarded` tag within a minute.
2. **Sale results:** take a test order on the store (or enter one), then finalize the sale in the app.
   - **Pass:** the contact gets the `sale-complete` tag, and **Sale Total Raised** and **Sale Unit Count** show real numbers.
3. **Growth loop:** confirm the `next-sale-eligible` tag lands and the countdown message uses **Next Sale Target**.
4. **Order webhook:** place a real test checkout on the store with ACH.
   - **Pass:** the order appears in the app under that sale, with the buyer as a customer and the seller credited (if a code was used), and a payment reference recorded.
5. **Shipment:** ship the test sale in the app.
   - **Pass:** the contact gets `shipment-sent` with **Tracking Number** and **Carrier** filled.

If a tag never lands, check that the **worker is running** and that `GHL_API_KEY` is set. The app logs every GHL call, so the dev team can see exactly what was sent and what GHL answered.

---

# Reference: what the app sends

### Tags
`team-onboarded`, `sale-complete`, `next-sale-eligible`, `shipment-sent`

### Custom fields (app name to your GHL field ID)
`sale_total_raised`, `sale_unit_count`, `next_sale_target`, `incentive`, `tracking_number`, `carrier`

### Inbound order webhook
`POST /webhooks/ghl` with `{ "type": "order.created", "order": { ... } }` as shown in E3.

### What is not built yet (so nobody assumes it is)
- Automatic store/funnel creation from the app. Today a person builds or links the store when the `team-onboarded` tag lands.
- Automatic mapping of GHL product IDs to app SKU IDs. Today those IDs are copied into the store setup once (E3).
- Accept Blue is used through GHL's checkout. The app only stores a payment reference and status. It never sees bank details.

Keep this guide with the account. When the dev team adds the store-provisioning endpoint, this guide gets a shorter Part E.
