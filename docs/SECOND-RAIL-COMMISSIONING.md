# Second rail decision

Status: **PARTIAL**, not COMPLETE_LOCAL or a commissioned provider.

Paystack Test Mode is the strongest candidate for this owner's existing Nigeria-compatible provider access. Official documentation states test keys are separate from live keys and test transactions use no real money. This is a selection, not an integration claim. The current repository still has only deterministic fake substitutes for M26/M27.

Checked on 2026-10-29:

- https://paystack.com/docs/api/authentication/
- https://paystack.com/docs/payments/test-payments/
- https://paystack.com/docs/api/

No Paystack test credential was available in inspected PayFlow configuration. No unrelated product's live key was reused. No account was created, no terms accepted, no charge attempted and no real-money action performed.

Internally controllable remaining work: test-only adapter refusing live keys; principal-bound instrument lookup; durable action/reference binding and reservation; verified one-time grant consumption; provider idempotency/reference handling; strict amount/currency/provider-result projection; timeout→UNKNOWN; lookup-only reconciliation; signed Proof; recorded provider-contract tests; opt-in live Sandbox acceptance runner. Only after that work is complete can credential/account access be the sole BLOCKED_EXTERNAL residue.

M27 needs an additional genuine provider/environment; a differently named fake adapter does not qualify. Do not claim the same provider's two fixture modes as separate rails.
