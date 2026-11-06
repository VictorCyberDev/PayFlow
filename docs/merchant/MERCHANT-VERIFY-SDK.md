# M23 — Merchant Verify SDK

Status: **COMPLETE_LOCAL**. 18 pure tests plus 5 integration tests against the real hosted Verify and real signed Proofs
(including an UNKNOWN one). No real merchant has integrated it, nothing is deployed, and it has not been security-reviewed
by anyone else.

`@payflow/merchant-verify/verifier` (`packages/merchant-sdk/src/verifier.ts`). It only answers questions: it never
authorises a payment and never sees a payment credential.

## The checkout flow it supports

1. `issueChallenge(order)`: one random challenge per order, single use, five minutes, **bound to that order's facts**
   (order id, amount, currency, merchant, action kind).
2. `verifyAgent(presentation, order)`: the agent shows an Authority credential (M22) made for **this merchant** and **this
   challenge**. The challenge is looked up in the merchant's own store; the agent cannot supply one.
3. The agent pays through PayFlow. The Gateway decides and moves money. The SDK is not involved.
4. `associateProof(proof, order)`: the signed Proof of that payment is verified (hosted Verify, or offline) against the
   order's amount, currency and merchant, and tied to this order once.

## Rules enforced in code (and tested)

| Rule                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- |
| A challenge works once, expires, and cannot be used for a different amount, order id, merchant or currency                      |
| A refused attempt does not spend the challenge; a successful one does, atomically                                               |
| A presentation made for another merchant, or for an action beyond the agent's authority, is refused for that reason             |
| An **UNKNOWN** payment outcome **holds**: neither ship nor cancel. A Verify outage also holds; it is not evidence of no payment |
| A Proof of no money moved does not ship; an inauthentic or mismatched Proof is refused, naming what differs                     |
| One payment cannot pay for two orders; re-checking the same order is fine                                                       |
| Anything but exactly one effect with an action id is refused (never guessed)                                                    |

## Gate Mark rules (`docs/AUTHORITY-MARK-BETA.md`, now enforced)

- `VERIFIED` comes only from a verification **this verifier instance produced for this order**, and only while fresh
  (default 5 minutes). Older, or for another order → `UNKNOWN`. A hand-made "verified" result gets **no mark at all**.
- Revoked → `REVOKED`; expired → `EXPIRED`; missing, stale or forged revocation data → `UNKNOWN`.
- A failed check (bad signature, wrong verifier, out of scope) shows **no mark**: it is not "unknown", and it must not
  look like anything.
- No verification attempted → `SUPPORTED`, which says only that the integration exists; it is not proof.
- `renderGateMarkHtml` carries state by shape **and** words, escapes every value, hides the decorative shape from assistive
  technology, and drops any link that is not https (or localhost).
- The mark is never an authorization input.

## Mutation checks

Each of these breaks a test: removing the order binding of challenges, letting one payment pay two orders, accepting a
hand-made verification for a mark, not holding on UNKNOWN, and not consuming a challenge on success.

## Not claimed

- In-process stores (challenges, nonces, Proof ledger). A merchant with several instances must supply shared ones with the
  same atomic `consume`/`claim`; the interfaces exist, no shared implementation does.
- The trust source for issuer keys and status lists is injected. No issuer directory is published yet (M24).
- The SDK is TypeScript only and assumes the credential format of M22 (not a standard).
- `MerchantVerifierClient` (the older class posting to `/v1/verify/presentations`) is unchanged and that route is not
  mounted on the hosted Gateway; use `MerchantVerifier`.
- The mark's visual design has not been reviewed in a browser here (no axe or screenshot run for `renderGateMarkHtml`).
