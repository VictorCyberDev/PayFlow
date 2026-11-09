# M51–M53 status (workspace discovery, comparison, booking intents)

Evidence levels follow the program mandate. Nothing here is `EXTERNAL_VALIDATED` or `PROVIDER_ACCEPTED`.

| Milestone | IMPLEMENTED | WIRED | UI_ACCEPTED | DB_ACCEPTED | TEST_ACCEPTED | PROVIDER_ACCEPTED | HOSTED_ACCEPTED |
|---|---|---|---|---|---|---|---|
| M51 workspace discovery | yes | gateway route | browser test + axe (6 widths) | migration 055, integration test | yes | **no** (fictional sandbox source only) | **no** (nothing deployed publicly) |
| M52 comparison / liability | yes | same | same | same | yes | no | no |
| M53 booking intents | yes | member + agent routes | browser journey + axe | migration 056, integration test | yes | no | no |

## What is true
- Search only looks. It reserves, books, pays and contacts no one. The only source is a fictional sandbox fixture, labelled as such on screen.
- Unknown terms stay unknown: an unstated cost, deposit, term or cancellation fee is never treated as favourable, and a listing with any of them unstated cannot be proposed.
- A booking is approved by a person (budget held atomically in the ledger), handed off by a person, and becomes "reserved" only when a person attaches evidence. The screen never claims more than that evidence: owner-attestation reads "You told us this is confirmed. PayFlow has no proof." and the badge says "Confirmed by you".
- UNKNOWN keeps the budget held and is resolved only by evidence. Expiry and decline release the hold exactly once. Agents may propose and read; they can never approve, hand off, confirm, decline, cancel or record a deposit (refused at the route and again in the service).

## Defects found and fixed while building
- Expiry did not release the ledger hold; attestation confirmation sent a null into ledger evidence; decline replay returned 400.
- A desk with a 30-day minimum term was shown as fitting a 7-day stay (`STAY_SHORTER_THAN_MIN_TERM`).
- The `/v1/admin` request budget (60/min) was keyed by bearer token only, so all cookie-session people behind one address shared one bucket. Now keyed by hashed session cookie; the per-address cap still applies. Regression test with mutation check.

## Not done
- No real provider adapter (commerce, talent or workspace). No live booking, quote, price or availability exists in this system.
- Booking approval is still member-only; no notification is sent when a booking approaches its deadline.
- Mutation note: removing the route-level agent block does not fail tests because the service independently refuses agents; the assertion now pins the `MEMBER_ONLY` reason.
