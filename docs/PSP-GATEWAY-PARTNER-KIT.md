# PSP / acquirer / gateway partner kit

Status: **COMPLETE_LOCAL / BLOCKED_EXTERNAL** until an external provider integrates.

## Reference flow

Agent proposes an exact financial action → PayFlow Trust Kernel evaluates current Authority → bounded one-time execution capability is issued → partner adapter validates digest/idempotency/expiry → provider effect occurs → normalized evidence returns → UNKNOWN is reconciled by lookup, never duplicate execution → Proof records terminal truth.

## Partner requirements

- Sandbox first; no production customer data for conformance.
- Preserve idempotency and provider reference.
- Never accept model text or protocol assertions as financial Authority.
- Never mutate amount, currency, payee, fee, quantity, or action semantics behind the grant digest.
- Return `UNKNOWN` when provider effect cannot be determined.
- Support lookup/reconciliation independent of execute.
- Protect credentials outside Proof/logs.
- Provide webhook authenticity and duplicate-delivery behavior.

## Test vectors

Allowed action, expired grant, action-digest mismatch, idempotency mismatch, duplicate execute, decline, timeout before effect, timeout after effect, delayed callback, duplicate callback, lookup after ambiguity, revoked Authority before provider boundary, and provider-reference mismatch.

No partnership, certification, or live-provider capture is claimed by this kit.
