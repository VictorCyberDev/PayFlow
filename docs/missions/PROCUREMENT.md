# Procurement to payment (M40)

An accepted quote becomes a **purchase order**. The order is an instruction. It is not a payment.

## What the order says

One order per acceptance, immutable, digest-bound: the merchant (the supplier's merchant id), the currency and total, the lines, the
category, the purpose, the cost centre and invoice reference if given, the one PURCHASE agent that may pay it, and the stored Authority
(M29) it must be paid under. It is refused when the quote has expired, when no ACTIVE Authority exists for that agent and category,
when the total is above the Authority's single maximum or allocation, or when the Authority does not name the merchant. An acceptance
that has an order can no longer be withdrawn.

## How the payment happens

Unchanged. The PURCHASE agent calls `actions.execute` under the order's Authority. The credential, Authority, Trust Kernel, reservation,
grant, rail, reconciliation and Proof path decides. Missions never decide money.

## Reconciliation

`POST …/purchase-orders/{poId}/reconcile {proposalId}` reads **PayFlow's own operation trace** for that proposal. What the agent says
about the payment is never read. The trace is compared to the order (authority, agent, currency, amount, trusted total, merchant, SKU,
quantity); a field the trace does not carry is not a mismatch, a field that differs is.

| Classification   | When                                                               | Budget item                                       |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| SETTLED          | verified, captured, provider capture on record, everything matches | → RESERVED → IN_FLIGHT → SETTLED (Proof/provider) |
| UNKNOWN          | invalid trace, unknown financial outcome, capture not on record    | held as UNKNOWN                                   |
| MISMATCH         | the payment differs from the order                                 | held as UNKNOWN (never released, never settled)   |
| FAILED_NO_EFFECT | verified, failed                                                   | cancelled / failed / released with Proof          |
| INCOMPLETE       | the trace is not finished                                          | unchanged                                         |
| DUPLICATE        | the order was already settled by another payment                   | unchanged, flagged                                |

A payment under another Authority or by another agent is **not this order's payment**: it cannot move this order's budget and its
references are withheld. PayFlow with no trace for the proposal answers `TRACE_UNAVAILABLE` and concludes nothing. Reconciling twice
is a replay. Only the order's buyer (or a person with `mission:ledger`) may reconcile.

## Honest limits

- The live Gateway does not yet compare SKU, price, tax, fees, cost centre and invoice to the trusted offer at payment time; reconciliation
  catches a difference afterwards and holds the budget. Status: PARTIAL for gateway-time enforcement.
- A real PayPal Sandbox capture needs the owner's Sandbox credentials. The tests use the provider double. Status: BLOCKED_EXTERNAL.
