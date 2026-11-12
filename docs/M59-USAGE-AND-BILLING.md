# M59 — usage and billing, said honestly

Status: IMPLEMENTED, WIRED (org view + route + customer screen), DB_ACCEPTED (PostgreSQL integration tests). **Not** HOSTED_ACCEPTED. No payment is ever taken, and that is by design, not omission.

## The gap

`usage_events` has existed since migration `013`, the Gateway writes to it as governed actions happen, and `buildUsageInvoice` has existed to aggregate it. A customer could see **none of it**: `grep -c usage app-ui/app.js` returned `0`. The product metered its customers and showed them nothing.

## What was added

| Piece                                     | What it does                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `usageHome` in `src/network/org-views.ts` | Per-meter totals for the current month and for all time, plus the invoice preview                         |
| `usagePeriod`                             | The UTC calendar month a moment falls in, exported so it can be tested on month ends                      |
| `GET /v1/admin/org/usage`                 | permission `view:finance`                                                                                 |
| `#/usage`                                 | A screen in the main navigation: what was measured, what it would be billed as, and what has been charged |

## The one thing this had to get right

A usage screen is the single place in a product where you can imply a debt that does not exist. `docs/PRICING-METERING.md` is explicit that the coefficients in the code are placeholders for testing arithmetic — "not a published price sheet, revenue forecast or evidence that customers will pay".

So the preview is built on the **DEVELOPER** plan, whose every coefficient is zero, and the response carries two statements the screen shows in words:

> This is what PayFlow has actually measured for you. Nothing here is estimated, and nothing here has been charged.

> You are not on a paid plan and no price has been agreed. PayFlow has not published a price sheet, so this shows what was used rather than what it would cost.

Building a non-zero total out of the placeholder table would have been the easy version and a lie told in money. There is also no plan assignment per organization anywhere in the schema, so picking a paid plan would have meant inventing commercial state the business has not agreed.

The screen adds: _"Nothing has been charged and no payment method is held. If PayFlow ever charges for this, it will say so before it does."_

## What it shows

- **This month**, per meter, in a customer's words: "Actions PayFlow checked for you", "Proof checks", "Agents that did something", "Organization controls used" — with the month's count and the lifetime count side by side.
- **What it would be billed as**: one line per meter used this period plus a `BASE` line, each with quantity × unit, every unit `0.00`, and the plan named.
- An organization that has done nothing is told that plainly, instead of being shown an empty bill.

Nothing is estimated or extrapolated. Every number is a `SUM(quantity)` over rows that exist.

## Evidence

`tests/m59-usage.integration.test.ts`, real HTTP + real Gateway + PostgreSQL:

1. the period is the UTC calendar month the moment falls in — including month ends, where an off-by-one would hide
2. an organization that has done nothing is told so, rather than shown a bill
3. what is shown is what the table holds, split into this month and all time (a row dated before the period counts to the lifetime figure only; the preview lists only meters used this period; every amount is zero)
4. another organization's usage is never counted into this one
5. a role without the finance permission cannot read usage, and a viewer can

Rows are inserted straight into `usage_events` — the table the Gateway writes to — rather than stubbed in front of it, so the query under test is the query that runs in production.

## Still not done in M59

- **Support correspondence.** The help screen is a glossary and the usage screen links to it, but there is no way to send a message to a human, because no email has ever been delivered (blocker B-1). An outbox row is not a sent message and will not be described as one.
- **A paid plan, a payment method, an invoice that charges.** All of that needs a commercial decision and a payment provider. The arithmetic and the aggregation are in place for when there is one.
