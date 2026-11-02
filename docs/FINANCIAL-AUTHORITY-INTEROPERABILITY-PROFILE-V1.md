# Financial Authority Interoperability Profile v1

The profile is transport-neutral: REST, MCP, A2A, AP2, ACP, UCP or future transports may carry inputs, but none becomes the source of financial Authority.

## Identity inputs

A principal and acting agent must be bound through a trusted identity context. External identity assertions require issuer validation, audience checking, freshness and lifecycle status.

## Authority

Authority is explicit, bounded, time-limited and versioned. It constrains action kind, amount, currency, counterparties, quantity/value dimensions, conditions, and permitted delegation.

## Delegation

Every child scope is a subset of its parent. Delegation cannot increase amount, add currencies/actions/counterparties, extend expiry, break ancestry or bypass revocation.

## Request binding and runtime revalidation

The exact proposed action is normalized, hashed/bound to the current Authority and revalidated immediately before irreversible provider effect. Model output and protocol payloads remain untrusted input.

## Execution grant

A grant is bounded to an Authority, exact action digest, idempotency key, audience/rail context where applicable, and expiry. It is one-time/replay-resistant and does not expose unrestricted payment credentials.

## Verification and Proof

Verification is read-only. Proof records authorization, delegation, reservation/grant state, provider effect, effect count, UNKNOWN/reconciliation and final outcome. Tampering fails verification.

## Revocation, replay and privacy

Revocation propagates across delegation. Request/presentation nonces are replay protected. Verification uses minimum necessary disclosure, public-key discovery and cache/freshness rules.

## Protocol mappings

Adapters may map external identity/commerce/agent protocol fields into candidate context. Missing semantics fail closed or require explicit escalation; adapters never manufacture Authority.
