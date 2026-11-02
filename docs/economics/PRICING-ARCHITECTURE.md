# Pricing architecture

**HYPOTHETICAL - NOT VALIDATED.** PayFlow is a developer preview on PayPal Sandbox only. It has no customers, no revenue, no pricing validation and no legal review. Nothing in this document is a price list, an offer, or a forecast. Every number below is an illustration used to reason about structure. Willingness to pay is unvalidated; see [WTP-EVIDENCE.md](WTP-EVIDENCE.md), which is empty.

This extends, and does not replace, [../PRICING-METERING.md](../PRICING-METERING.md). The code placeholders in `src/network/metering.ts` (`DEVELOPER`, `PLATFORM`, `ENTERPRISE`) exist to test arithmetic only.

## Package hypotheses

| Package        | Who it is for (hypothesis)                                                               | Pricing shape (HYPOTHESIS - NOT VALIDATED)                                                                              | Purpose                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SANDBOX**    | Developers evaluating Authority, the Execution Boundary and Proof against PayPal Sandbox | Free. No payment details. Rate limits and fair-use caps to be defined.                                                  | Adoption and feedback. Cost to serve is small (see [COST-MODEL.md](COST-MODEL.md)); abuse and support time are the real risks.                                    |
| **PLATFORM**   | Teams running agents with real economic authority once a production rail exists          | Usage-based: a per-governed-action rate, possibly with a small monthly minimum. No tier or figure is validated.         | Revenue scales with governed activity rather than with seats.                                                                                                     |
| **ENTERPRISE** | Organizations needing governance, procurement, support and integration                   | Annual platform fee plus governance/control entitlements plus support level, negotiated. May include a usage allowance. | Covers the cost of security review, SSO/audit integration, SLAs, and support, which are largely human time.                                                       |
| **VERIFY**     | Anyone who must check a Proof (counterparties, auditors, other systems)                  | Free, or free up to a volume with a metered rate above it.                                                              | Verification is the trust surface of the product. Charging the verifier at low volume adds friction and weakens the network effect. Abuse control is the concern. |

## What would be metered

The code recognises four meters: `GOVERNED_ACTION`, `VERIFY_CALL`, `ACTIVE_AGENT`, `ENTERPRISE_CONTROL`. Which are billable per package is a hypothesis:

| Meter              | SANDBOX       | PLATFORM                        | ENTERPRISE                              | VERIFY        |
| ------------------ | ------------- | ------------------------------- | --------------------------------------- | ------------- |
| GOVERNED_ACTION    | metered, free | hypothesis: billable            | hypothesis: allowance + overage         | n/a           |
| VERIFY_CALL        | metered, free | hypothesis: free                | hypothesis: free                        | free / volume |
| ACTIVE_AGENT       | metered, free | hypothesis: not billed or minor | hypothesis: reported, maybe entitlement | n/a           |
| ENTERPRISE_CONTROL | n/a           | n/a                             | hypothesis: entitlement flag            | n/a           |

Update after the audit ([METERING-AUDIT.md](METERING-AUDIT.md)): the hosted Gateway now emits `GOVERNED_ACTION` in source (idempotent, with outcome metadata; a governed action is an authenticated, well-formed, non-replayed request PayFlow evaluated). `ACTIVE_AGENT` is derived as a distinct count. `VERIFY_CALL` and `ENTERPRISE_CONTROL` are still not emitted. This is not deployed, and no usage-based price can be billed yet.

## Design principles (stated, not validated)

1. Price a unit the customer already understands and can predict (see [VALUE-METRICS.md](VALUE-METRICS.md)).
2. Do not price as a percentage of payment volume by default. Doing so raises regulatory questions and misaligns incentives (a customer is charged more when the system allows more); flagged for counsel in VALUE-METRICS.
3. Verification stays cheap or free where it strengthens the network.
4. Enterprise price must cover human cost, which the model shows dominates infrastructure cost at every tier.
5. Billing never moves money: the existing billing abstraction is sandbox-only and draft-only (`InMemoryBillingProvider`).

## Illustrative arithmetic (ILLUSTRATIVE only)

The existing placeholder is 1 US cent (`governedActionMinor = 1`) per governed action. At that placeholder, 10,000 governed actions would be $100 and 500,000 would be $5,000. These are used in [GROSS-MARGIN.md](GROSS-MARGIN.md) as HYPOTHETICAL revenue. They are not a recommendation.

## What must be true before any price is published

- At least the interviews in WTP-EVIDENCE.md have been run and logged (currently 0).
- Metering is wired to the live Gateway and verified idempotent end to end.
- A production rail and the legal posture have been reviewed by qualified counsel (not done).
- Measured, not estimated, cost per operation (the profile inputs in the cost model are estimates).

## Status

| Item                        | Status                                                   |
| --------------------------- | -------------------------------------------------------- |
| Package structure           | Hypothesis                                               |
| Price points                | None validated; none proposed                            |
| Willingness to pay          | NOT VALIDATED; evidence log empty                        |
| Metering wired to live path | GOVERNED_ACTION in source; not deployed; other meters no |
| Legal / regulatory review   | Not done                                                 |
