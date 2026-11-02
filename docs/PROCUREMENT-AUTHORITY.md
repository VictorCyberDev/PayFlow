# Procurement Authority — what exists, what does not

Status: **built and tested in source, Sandbox only, not deployed, no customer.** One decision path:
procurement is a use of the same Authority, Trust Kernel, Reservation, one-time grant and Proof as every
other action. There is no separate procurement policy engine.

## The flow

```
Procurement request
  → trusted vendor quote (the agent's claimed amount/merchant are only checked against it)
  → Authority (supplier scope, per-purchase and cumulative limits, quantity, expiry)
  → Trust Kernel decision
      ALLOW  → Reservation → one-time grant → Execution Boundary → PayPal Sandbox → reconciliation → Proof
      DENY   → $0 moved, reason the agent can act on
      ESCALATE → NEEDS_APPROVAL → a human decides (the agent cannot)
```

## Policy dimensions

`src/network/procurement.ts` (`procurement-authority/v1`) evaluates: approved vendors, approved SKUs with
expected unit price and a price-tolerance band, maximum quantity, currency, budget, tax and fee ceilings,
cost centre, purpose, invoice-reference prefix, expiry, supplier substitution policy, recurring-action
cap, and a human-escalation threshold. It is a pure function; the live Gateway path today uses the Trust
Kernel's Authority fields (merchant scope, per-purchase and cumulative limits, quantity, conditions,
autonomous and human-approval thresholds). **Wiring the full procurement pack into the live execution
path is not done.**

## Finance view (real data)

`GET /v1/admin/org/authorities` and `/v1/admin/org/finance` report, per Authority and in total:

| Number    | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| Reserved  | Decided, not yet paying                                              |
| In flight | Money may be moving. UNKNOWN outcomes stay here and are not released |
| Settled   | Confirmed by the provider                                            |
| Available | Limit minus the three above                                          |

A test requires reserved + in flight + settled to equal the kernel's own `consumedMinor`, so the finance
number cannot drift from what is actually enforced. "Committed obligations" beyond a reservation (invoices,
subscriptions) are **not modelled**; the API returns `NOT_MODELLED` rather than zero.

## Approval escalation

When a purchase exceeds the autonomous limit, the Gateway returns `NEEDS_APPROVAL` and nothing is
reserved or paid. `GET /v1/admin/org/decisions` lists what waits. `POST /v1/admin/decisions/{receiptId}/approve`
records the approval under the Authority owner's principal and reserves the Authority;
`/reject` records an audit event and removes it from the queue. The agent's credential cannot reach these
routes (tested). **Approving does not pay.** Completing a payment after approval still needs the existing
payer-present resume; that path is not wired to the Gateway.

## UNKNOWN in procurement

A payment whose provider outcome is unknown shows as "Payment status being confirmed. Don't retry." The
amount stays held. `GET /v1/admin/org/unknown` lists these for operators. Nothing re-executes.

## Proof

The existing operation trace and the portable Proof carry the organization's principal, the agent, the
supplier (merchant), item, quote, Authority, approval where one was needed, reservation, grant, provider
result and outcome. The signed portable Proof binds agent, amount, currency and merchant.

## Not built

ERP and invoice connectors; subscription and recurring controls in the product; obligations beyond a
reservation; wiring the full procurement pack into live execution; completing payment after approval
without the payer present; any procurement customer.

Public page: `/solutions/finance/` (illustrative data, labelled).
