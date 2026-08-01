# Integration Contract: GoHighLevel and the Custom Stack

The purpose of this document is to prevent the same data existing in two places with two different values. Read it before touching the GHL API.

The model is team-based fundraising with held stock and bulk delivery, GoHighLevel as the front door. See `CLAUDE.md`.

## The one rule

**One system owns each field. The other one reads it.** No field is owned by both. If you find yourself writing sync logic that has to merge two versions of the same value, stop, because the ownership was defined wrong.

---

## Ownership table

| Data | Owner | Other system's access |
|---|---|---|
| Rep, seller, buyer, org contact identity (name, email, phone, address) | GoHighLevel | Custom stack caches, read only |
| Rep application status and pipeline stage | GoHighLevel | Custom stack reads |
| Rep approval decision | Custom stack | Pushed to GHL as a tag and pipeline move |
| Rep territory assignment | Custom stack | Pushed to GHL as a custom field |
| Rep and seller commission earned | Custom stack | Pushed to GHL as a custom field for display |
| Organization contact info | GoHighLevel | Custom stack caches, read only |
| Team storefront (funnel, landing page, checkout) | GoHighLevel | Custom stack provisions and feeds catalog, reads orders |
| Product catalog and prices shown in the store | Custom stack | Pushed to the GHL store |
| Products and SKUs | Custom stack | Not in GHL beyond the store catalog |
| Inventory and forecasting | Custom stack | Not in GHL at all |
| Sales (campaigns) | Custom stack | Summary pushed to GHL as custom fields |
| Orders and order lines | Custom stack | Buyer order arrives from the GHL store, then owned by the custom stack |
| Seller attribution on an order | Custom stack | Seller code originates as a GHL store link param |
| Customer operational record and list rollup | Custom stack | Contact identity stays in GHL, linked by `ghl_contact_id` |
| ACH payment processing | GoHighLevel + Accept Blue | Custom stack stores a reference and status only |
| Pick lists, shipments, packing slips | Custom stack | Tracking number pushed to GHL |
| All SMS and email sends, including the growth loop | GoHighLevel | Custom stack triggers via tags and fields, never sends directly |
| Marketing materials, pixels, retargeting | GoHighLevel | Custom stack does not touch |

---

## Identity linking

`reps.ghl_contact_id`, `sellers.ghl_contact_id`, `organizations.ghl_contact_id`, and `customers.ghl_contact_id` are the join keys. They are the only link between the two systems.

- A rep or seller record in the custom stack **cannot exist** without a `ghl_contact_id`. They are created in GHL first, always.
- A buyer becomes a `customer` when their first order arrives. GHL creates the contact at checkout, the custom stack creates or links the `customer` by `ghl_contact_id`.
- Clerk identity (`clerk_user_id`, `clerk_org_id`) governs who can log into the custom stack's portal and app. GHL identity governs contact records. They are different systems for different jobs and do not merge.
- If a local record's `ghl_contact_id` no longer resolves in GHL, flag it for human review. Do not delete anything.

---

## Sync direction and triggers

### GHL to custom stack (inbound)

**Rep or seller application submitted.** GHL webhook fires on form submission or pipeline stage change. Custom stack creates or updates the record with status `applicant`.

**Contact detail changed.** GHL webhook on contact update. Custom stack refreshes its cached name, email, phone. Cache only, never authoritative.

**Organization created.** GHL webhook. Creates or updates `organizations`.

**Buyer order placed on the team store.** GHL webhook on store checkout. Custom stack creates the `order`, links or creates the `customer`, applies seller attribution from the store link param, and records the `payments` reference from Accept Blue.

Inbound is webhook-driven with a nightly reconciliation job as backstop. Webhooks get missed. Assume it.

### Custom stack to GHL (outbound)

**Store provisioned.** On team onboarding, custom stack creates or configures the GHL funnel for the team and pushes the active catalog and prices.

**Rep or seller approved.** Custom stack sets status to `approved`, then pushes a tag and moves the GHL pipeline stage. GHL's onboarding sequence fires from that tag.

**Territory assigned.** Push territory name to a GHL custom field. Phase 2.

**Sale finalized.** Push sale name, total raised, and unit count to GHL custom fields on the organization contact. Apply tag `sale-complete`. Enables GHL to send the results message.

**Growth loop.** Compute next-sale eligibility, incentive, and countdown target. Write to GHL custom fields, apply tag `next-sale-eligible`. GHL runs the re-engagement workflow.

**Shipment sent.** Push tracking number to a custom field. GHL sends the notification.

**Commission accrued or paid.** Push running total to a custom field. Phase 2.

Outbound is queued through Redis, not fired synchronously. A GHL API failure must never block an inventory operation, an order, or a payment record.

---

## Payments

ACH runs through GoHighLevel's Accept Blue integration. The custom stack is not in the money-movement path and is not in PCI or NACHA scope.

- The store checkout collects and processes ACH through Accept Blue. GHL owns that flow
- The custom stack receives and stores a `payments` reference (Accept Blue transaction id, GHL transaction id), the method, amount, and status
- The custom stack never stores or logs raw account or routing numbers
- Payment status updates arrive by webhook. A refund or failure updates the `payments` row, never deletes it
- All dunning and receipt messaging is a GHL workflow, not a custom stack send

---

## What triggers messages

The custom stack **never sends an email or SMS directly.** Not one. Every message goes out through GoHighLevel, including the post-sale growth loop.

Pattern: custom stack does the work, sets a tag and custom fields, GHL owns the message. This keeps deliverability, compliance, opt-out handling, and message history in one place.

Example, sale results notification:
1. Custom stack finalizes the sale and calculates totals
2. Custom stack writes totals to GHL custom fields on the org contact
3. Custom stack applies tag `sale-complete`
4. GHL workflow fires on that tag, merges the custom fields into a message, sends it

Do not shortcut this by sending from the application. Compliance and opt-out live in GHL.

---

## Failure handling

- Every outbound GHL call goes on a Redis queue with retry and exponential backoff
- Three consecutive failures on the same job moves it to a dead letter queue and alerts an admin
- Log every API call with request, response, and status. This is the first thing you will need when something silently stops syncing
- Nightly reconciliation compares rep, seller, organization, customer, and order records both directions and reports drift. Report, do not auto-fix. Auto-fixing drift on a broken assumption makes it worse

---

## Rate limits

GoHighLevel enforces API rate limits and they change. Read current limits from their docs before setting concurrency, do not assume a number from memory. Design for batching from day one. A bulk sale finalize pushing hundreds of contact and custom-field updates cannot fire hundreds of individual calls in a burst.

---

## What not to build

Things that already exist in GoHighLevel. Do not rebuild any of these in the custom stack:

- Rep and seller application forms
- Team storefronts, funnels, and checkout
- ACH payment processing (Accept Blue)
- Onboarding and re-engagement email and SMS sequences
- Any landing page or marketing material hosting
- Contact activity timeline
- Two-way SMS conversations
- Appointment booking
- Marketing pixel and retargeting management

If a requirement seems to need one of these, the answer is a GHL API call or a GHL workflow, not a new feature here.
