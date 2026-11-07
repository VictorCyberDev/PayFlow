# Orders (M41)

An **order** is what a settled purchase became: the thing the supplier now owes.

- **Creation.** Only for a purchase order that PayFlow itself reconciled as SETTLED (M40). One order per purchase order. A person
  (`mission:ledger`) or the order's buyer agent may create it; another agent, even one that can purchase, is refused `NOT_THE_BUYER`.
- **Status** is `PLACED → CONFIRMED → SHIPPED → DELIVERED`, with `CANCELLED` (final) and `IN_DISPUTE`. Moves are forward only; a dispute
  resolves to `DELIVERED` or `CANCELLED`. The database refuses an illegal move even if the service did not.
- **Only a person moves it.** A status, supplier reference or expected-delivery-date event moves the order only when a person records it
  with `verify: true` and evidence (`OWNER_ATTESTATION`, `DOCUMENT_REF` or `CONNECTOR_CALL`). An agent's report, or what a supplier said,
  is stored as a **claim**; the order shows the latest differing claim as `claimedStatus` and never believes it.
- **Events are append-only.** Supplier-written text is stored as data and bounded; it cannot instruct anything.
- **Late** is computed: an expected date has passed and the order is not delivered or cancelled.

Orders move no money and contact no one. Refunds and disputes are M43; fulfillment tracking is M42.
