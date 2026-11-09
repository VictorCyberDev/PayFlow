# M54–M71 status (what exists, how far it is proven, what is not done)

Levels: IMPLEMENTED (code exists) · WIRED (reachable through the real Gateway) · UI_ACCEPTED (real browser test and axe) · DB_ACCEPTED (PostgreSQL migration and integration test) · TEST_ACCEPTED (tests, with mutation checks where noted). Nothing below is PROVIDER_ACCEPTED, HOSTED_ACCEPTED or EXTERNAL_VALIDATED: no live provider is connected and nothing is deployed publicly.

| Milestone                                    | IMPLEMENTED | WIRED                                                                    | UI_ACCEPTED                            | DB_ACCEPTED             | TEST_ACCEPTED                                   |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------ | -------------------------------------- | ----------------------- | ----------------------------------------------- |
| M54 services marketplace                     | yes         | member and agent routes                                                  | Services screen, axe                   | none needed (stateless) | yes; 2 mutants killed                           |
| M55 / M60 Founder Launch and templates       | yes         | client only (prefills the wizard)                                        | browser test, axe                      | n/a                     | yes                                             |
| M56 durable automation                       | yes         | booking-expiry job, operator and scheduler run route, member list/settle | Needs checking screen (stubbed wiring) | migration 057           | yes; 3 mutants killed                           |
| M57 recurring schedules                      | yes         | `tick()` inside the run route; no route creates a schedule yet           | none                                   | migration 057           | yes (slot dedupe, catch-up cap)                 |
| M63 FX                                       | yes         | **not wired** (no route or screen uses it)                               | none                                   | none                    | yes; 1 mutant killed; invariants over 600 cases |
| M65 approval quorum                          | yes         | **not wired** (mission approval still needs one approver)                | none                                   | none                    | yes; 1 mutant killed                            |
| M66 agent lifecycle                          | yes         | **not wired** (agent status is still the earlier ACTIVE/other field)     | none                                   | none                    | yes                                             |
| M67 policy packs                             | yes         | **not wired** (not offered in the wizard)                                | none                                   | none                    | yes; 1 mutant killed                            |
| M68 accounting export                        | yes         | `GET /v1/admin/org/missions/:id/ledger/export`                           | Download button; request checked       | n/a                     | yes (formula injection, exact decimals)         |
| M71 reconciliation centre ("Needs checking") | partly      | lists unclear bookings and jobs; does not yet cover orders or payments   | browser test with stubbed responses    | uses 057                | settle route tested against PostgreSQL          |

## What is true

- Automation never repeats an effect it cannot see. A job with an external effect that throws, asks to retry, or loses its worker becomes UNKNOWN; the database trigger refuses to put it back in the queue; only a person settles it, once.
- Two workers never run one job (row lock with SKIP LOCKED plus a lease). A recurring slot becomes one job however many tickers fire; a long outage creates at most three catch-up jobs.
- Booking expiry no longer depends on someone looking: approving a booking schedules a job at its deadline. Before this, a lapsed hold stayed held until the next view.
- Search of services observes only. The only source is a fictional sandbox fixture. An unstated price, delivery time, revision count or refund term is shown as unstated and disqualifies the package.
- Templates fill in a form. They create, approve and spend nothing.
- The export is for a bookkeeper. It connects to no ERP and says so.

## Defects found and fixed on the way

- The `/v1/admin` request budget was shared by everyone signed in from one address. Now per session.
- Several record screens passed an array to the page builder and rendered `[object HTMLElement]`; a date helper threw on missing input. Both found by browser tests, fixed.

## Not done (honest list)

- Screens for approving a quote, resolving a dispute, or deciding a contractor deliverable. Negotiation approval and opening a dispute are done.
- M58 and M59 as separately named items were not identified in the source material available to this work; the commercial loop (quote, negotiation, order, dispute, payment, export) is covered by the existing M36–M50 services plus the screens above.
- M61, M62, M64, M69, M70 and all of M72–M90 are not started. M63, M65, M66 and M67 are pure modules that nothing calls yet.
- No product research outputs, interviews or usability sessions exist, and none are claimed.
- No notification delivery (email or push) exists; the Notifications screen is an in-app list only.
- No public deployment. See `docs/PROGRAM-CHECKPOINT-2026-11-09.md` for what the owner must provide.
