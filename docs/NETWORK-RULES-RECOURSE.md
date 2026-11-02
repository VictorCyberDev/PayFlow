# Network rules and recourse evidence

Status: technical rules framework only. These rules do **not** have contractual or legal force without real agreements.

## Participant obligations

Issuers authenticate principals and publish bounded Authority plus current key/revocation status. Verifiers check issuer trust, signature, audience, freshness, lifecycle and action fit without moving money. Agents submit exact actions and may only attenuate delegation. Rails accept only bounded grants, preserve idempotency and report ambiguity as UNKNOWN.

## Key compromise and revocation

Compromised keys transition to revoked status in directory/transparency metadata. Cached verification metadata must respect bounded freshness. Authority revocation propagates across delegations and is revalidated before provider effect.

## Disputed actions

Recourse evidence should preserve the Authority reference, exact action, delegation path, grant, provider reference when known, portable Proof, revocation timing, reconciliation observations and incident reference. Missing evidence stays explicit rather than being replaced by inference.

## UNKNOWN

UNKNOWN is unresolved financial truth. It routes to provider lookup/reconciliation. It must not be converted into success/failure for convenience and must not trigger a replacement execution.

## Privacy and incidents

Proof and recourse exports disclose the minimum information necessary to establish financial truth. Incident handling must preserve immutable evidence, revoke compromised authority/key material, notify affected participants according to real agreements, and record remediation evidence.
