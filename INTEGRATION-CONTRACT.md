# Integration Contract — GoHighLevel and the Custom Stack

The purpose of this document is to prevent the same data existing in two places with two different values. Read it before touching the GHL API.

## The one rule

**One system owns each field. The other one reads it.** No field is owned by both. If you find yourself writing sync logic that has to merge two versions of the same value, stop, because the ownership was defined wrong.

---

## Ownership table

| Data | Owner | Other system's access |
|---|---|---|
| Rep name, email, phone, address | GoHighLevel | Custom stack caches, read only |
| Rep application status and pipeline stage | GoHighLevel | Custom stack reads |
| Rep approval decision | Custom stack | Pushed to GHL as a tag and pipeline move |
| Rep territory assignment | Custom stack | Pushed to GHL as a custom field |
| Rep commission earned | Custom stack | Pushed to GHL as a custom field for display |
| Organization contact info | GoHighLevel | Custom stack caches, read only |
| Products and SKUs | Custom stack | Not in GHL at all |
| Inventory | Custom stack | Not in GHL at all |
| Campaigns | Custom stack | Summary pushed to GHL as custom fields |
| Orders and order lines | Custom stack | Not in GHL at all |
| Pick lists, shipments, packing slips | Custom stack | Tracking number pushed to GHL |
| All SMS and email sends | GoHighLevel | Custom stack triggers via API, never sends directly |
| Marketing campaigns, pixels, retargeting | GoHighLevel | Custom stack does not touch |

---

## Identity linking

`reps.ghl_contact_id` and `organizations.ghl_contact_id` are the join keys. They are the only link between the two systems.

- A rep record in the custom stack **cannot exist** without a `ghl_contact_id`. Reps are created in GHL first, always.
- If a rep exists in GHL but not here, the sync job creates the local record.
- If a local rep's `ghl_contact_id` no longer resolves in GHL, flag it for human review. Do not delete anything.

---

## Sync direction and triggers

### GHL to custom stack (inbound)

**Rep application submitted.** GHL webhook fires on form submission or pipeline stage change. Custom stack creates or updates the `reps` record with status `applicant`.

**Contact detail changed.** GHL webhook on contact update. Custom stack refreshes its cached name, email, phone. Cache only, never authoritative.

**Organization created.** GHL webhook. Creates or updates `organizations`.

Inbound is webhook-driven with a nightly reconciliation job as backstop. Webhooks get missed. Assume it.

### Custom stack to GHL (outbound)

**Rep approved.** Custom stack sets status to `approved`, then pushes a tag (`rep-approved`) and moves the GHL pipeline stage. GHL's onboarding sequence fires from that tag, not from anything here.

**Starter kit shipped.** Push tag `rep-kit-sent` plus tracking number to a custom field. GHL sends the notification.

**Territory assigned.** Push territory name to a GHL custom field so it appears on the contact record.

**Campaign closed.** Push campaign name, total raised, and unit count to GHL custom fields on the organization contact. Enables GHL to send the results email.

**Commission accrued or paid.** Push running total to a custom field. Phase 2.

Outbound is queued through Redis, not fired synchronously. A GHL API failure must never block an inventory operation or an order entry.

---

## What triggers messages

The custom stack **never sends an email or SMS directly.** Not one. Every message goes out through GoHighLevel.

Pattern: custom stack does the work, sets a tag, GHL owns the message. This keeps deliverability, compliance, opt-out handling, and message history in one place.

Example, campaign results notification:
1. Custom stack closes the campaign and calculates totals
2. Custom stack writes totals to GHL custom fields on the org contact
3. Custom stack applies tag `campaign-closed`
4. GHL workflow fires on that tag, merges the custom fields into an email, sends it

Do not shortcut this by sending from the application. Compliance and opt-out live in GHL.

---

## Failure handling

- Every outbound GHL call goes on a Redis queue with retry and exponential backoff
- Three consecutive failures on the same job moves it to a dead letter queue and alerts an admin
- Log every API call with request, response, and status. This is the first thing you will need when something silently stops syncing.
- Nightly reconciliation compares rep and organization records both directions and reports drift. Report, do not auto-fix. Auto-fixing drift on a broken assumption makes it worse.

---

## Rate limits

GoHighLevel enforces API rate limits and they change. Read current limits from their docs before setting concurrency, do not assume a number from memory. Design for batching from day one. A bulk campaign close pushing 400 organization updates cannot fire 400 individual calls in a burst.

---

## What not to build

Things that already exist in GoHighLevel. Do not rebuild any of these in the custom stack:

- Rep application forms
- Onboarding email and SMS sequences
- Weekly rep call reminders
- Any landing page
- Contact activity timeline
- Two-way SMS conversations
- Appointment booking
- Marketing pixel and retargeting management

If a requirement seems to need one of these, the answer is a GHL API call or a GHL workflow, not a new feature here.
