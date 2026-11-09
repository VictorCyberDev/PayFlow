# M54–M71 status (what exists, how far it is proven, what is not done)

Milestone numbers and scopes are those of `docs/ADR-018-roadmap-v3-m26-m95.md`. Levels: IMPLEMENTED (code exists) · WIRED (reachable through the real Gateway) · UI_ACCEPTED (real browser test and axe) · DB_ACCEPTED (PostgreSQL migration and integration test) · TEST_ACCEPTED (tests, with mutation checks where noted). Nothing below is PROVIDER_ACCEPTED, HOSTED_ACCEPTED or EXTERNAL_VALIDATED: no live provider is connected and nothing is deployed publicly.

| Milestone (ADR-018 name)                        | Built here                                                                                | IMPLEMENTED | WIRED                                                             | UI_ACCEPTED                         | DB_ACCEPTED   | TEST_ACCEPTED                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------- | ----------------------------------- | ------------- | ------------------------------------------------------ |
| M54 Business Services Marketplace Layer         | package search, fictional sandbox source, honest unknowns                                 | yes         | member and agent routes                                           | Services screen, axe                | stateless     | yes; 2 mutants killed                                  |
| M55 Founder Launch Mission                      | **only** a starter template pack (see M58). The orchestrated mission is not built         | no          | n/a                                                               | n/a                                 | n/a           | n/a                                                    |
| M56 Durable Mission Automation                  | PostgreSQL job queue, leases, UNKNOWN for effectful jobs, booking-expiry job              | yes         | run route (operator and scheduler secret), member list and settle | Needs checking (stubbed wiring)     | migration 057 | yes; 3 mutants killed. No notifications.               |
| M57 Recurring Business Operations               | **building block only**: slot-deduped schedules. No recurring purchase or renewal         | partly      | `tick()` inside the run route; no route creates a schedule        | none                                | migration 057 | schedule slots tested; nothing recurs yet              |
| M58 Vertical Mission Templates                  | five prefill templates (workspace, brand, equipment, freelancer, bookkeeping)             | yes         | client only                                                       | browser test, axe                   | n/a           | yes; does not advertise anything unbuilt               |
| M59 Complete Customer Experience                | accounts, sessions, wizard, records, settings, help; **no billing, usage, support**       | partly      | yes                                                               | browser tests, axe at six widths    | 054           | yes                                                    |
| M65 Multi-Currency / Fee / FX Authority         | **FX conversion only** (pure). No fee model, no ledger or route uses it                   | partly      | **not wired**                                                     | none                                | none          | yes; 1 mutant killed                                   |
| M67 Separation of Duties + Multi-Party Approval | approval quorum in front of mission approval                                              | yes         | yes: policy routes and gate before approve                        | none (no screen to set a policy)    | migration 058 | yes; 2 mutants killed                                  |
| M68 Agent Lifecycle Governance                  | readiness derived from the stored lifecycle and passport expiry; adds no state of its own | yes         | `GET /v1/app/agents` includes readiness                           | Agents screen (stubbed data), axe   | n/a           | yes; drift guard against the database's allowed states |
| M69 Organization Policy Packs                   | three ceilings packs, applied in the wizard                                               | yes         | `/v1/app/policy-packs`                                            | wizard test, axe                    | n/a           | yes; 1 mutant killed                                   |
| M70 ERP / Procurement / AP Integrations         | **CSV export only**. No ERP connection                                                    | partly      | `GET .../ledger/export`                                           | Download button, request checked    | n/a           | yes                                                    |
| M71 Reconciliation Operations Center            | "Needs checking": unclear bookings and jobs; settle route                                 | partly      | yes (orders and payments are not included)                        | browser test with stubbed responses | uses 057      | settle route tested on PostgreSQL                      |

## What is true

- Automation never repeats an effect it cannot see. A job with an external effect that throws, asks to retry or loses its worker becomes UNKNOWN; the database refuses to put it back in the queue; only a person settles it, once.
- Two workers never run one job (row lock with SKIP LOCKED plus a lease). A recurring slot becomes one job however many tickers fire; a long outage creates at most three catch-up jobs.
- Booking expiry no longer depends on someone looking: approving a booking schedules a job at its deadline. Before this, a lapsed hold stayed held until the next view.
- With no quorum policy, mission approval is exactly as before. With one, an owner's own approval of their own proposal never counts, a member counts once however often they press approve, a revoked owner's vote stops counting, and the mission stays out of force until enough distinct owners approve. Votes cannot be edited or deleted.
- Packs only lower limits; the server does the arithmetic and the screen lists each change.
- Search of services observes only. The only source is a fictional sandbox fixture. An unstated price, delivery time, revision count or refund term is shown as unstated and disqualifies the package.
- The export is for a bookkeeper. It connects to no ERP and says so.

## Defects found and fixed on the way

- The `/v1/admin` request budget was shared by everyone signed in from one address. Now per session.
- Several record screens passed an array to the page builder and rendered `[object HTMLElement]`; a date helper threw on missing input. Both found by browser tests, fixed.
- Milestone labels on early commits of this branch were off by an offset for M63–M70. Corrected in code, tests and file names before merge.
- CI's "Public deployment readiness" check, which I did not run locally, refused the second cron. Fixed; the local pre-push routine now runs every CI step.

## Not done (honest list)

- M55 the orchestrated Founder Launch mission; M57 recurring purchases, renewals and rollovers each checked under Authority; M59 billing, usage, support; M60 acceptance by independent users.
- M61–M64, M66 and M70 beyond the export; M72–M90 as scoped in ADR-018. Many of these have earlier scaffolds from the legacy M26–M60 program (see `docs/M7-M60-EXECUTION-LEDGER.md`); they have not been re-audited here.
- M65 FX is not called by any route or screen. No screen sets a quorum policy. Agent readiness is shown, but suspending, resuming and retiring agents from the screen is not built.
- Screens for approving a quote, resolving a dispute, or deciding a contractor deliverable. Negotiation approval and opening a dispute are done.
- No notification delivery (email or push); the Notifications screen is an in-app list.
- No product research outputs, interviews or usability sessions exist, and none are claimed.
- No public deployment. See `docs/PROGRAM-CHECKPOINT-2026-11-09.md` for what the owner must provide.
