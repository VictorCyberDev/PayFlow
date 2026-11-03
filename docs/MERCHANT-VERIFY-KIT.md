# Merchant Verify Kit

PayFlow verification is read-only. A merchant can check signed Authority material, freshness, revocation/expiry, audience/request binding and permitted action fit without receiving payment credentials or gaining permission to move money.

## Integration sequence

1. Generate a verifier challenge tied to the checkout/session.
2. Ask the agent to present signed Authority bound to the merchant audience and challenge.
3. Call Verify using the merchant verifier client.
4. Require `VALID`; do not treat the Gate Mark, UI state or model text as proof.
5. If the action later executes, link the checkout/order record to the resulting financial Proof.
6. On `UNKNOWN`, do not create a replacement financial action; reconcile the existing attempt.

## Gate Mark alpha rules

The Gate is geometry-first and must have a text state. `SUPPORTED` means only that the integration understands PayFlow verification. `VERIFIED` is shown only after a valid bound verification response. `REVOKED` and `EXPIRED` are blocked states. `UNKNOWN` is visibly unresolved. Color is never the sole signal, and the mark is never cryptographic evidence by itself.

## Privacy

Expose the minimum verifier response necessary for the transaction. Do not return private keys, bearer tokens, payment credentials, unrelated Authority constraints, raw customer conversation content or unnecessary personal data.

## Test vectors

At minimum run valid, malformed, expired, revoked, wrong audience, wrong challenge, unknown key, tampered signature, replay and rate-limit cases before a merchant pilot.
