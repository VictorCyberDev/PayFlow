# Independent security / assurance readiness

Status: **COMPLETE_LOCAL / BLOCKED_EXTERNAL** for an actual independent audit.

This repository already contains a threat model, adversarial boundary tests, durable authorization tests, execution-grant tests, payment/reconciliation tests and operation-trace verification. M7+ adds scoped external-agent access, signed Authority presentations, verifier replay protection, tenant boundaries, delegation attenuation, merchant verification, rail conformance, Break Authority 100/1000 and reconciliation operations.

## Evidence package

An external reviewer should receive: architecture and data-flow docs; Trust Kernel invariants; migration history; threat model; protocol-version notes; OpenAPI; key/issuer metadata model; representative denial/replay/concurrency/UNKNOWN tests; Break Authority reports; dependency inventory; secret-management assumptions; CI results; and exact commit SHAs.

## Secret inventory classes

Expected secret classes include database credentials, provider sandbox credentials, OAuth/client secrets, webhook signing material and signing private keys. They must be injected from environment/secret stores, never committed. Public verification keys and key metadata are not secret.

## Pentest checklist

Test tenant isolation, authentication bypass, scope escalation, Authority widening, replay, nonce/challenge reuse, signature tampering, key rotation/revocation, malicious protocol payloads, malformed money/currency values, integer/precision boundaries, webhook duplication, reconciliation races, SSRF in external endpoints, rate-limit bypass, unsafe error leakage, CSP/browser injection and dependency compromise.

## Remediation

Each finding needs severity, affected invariant, reproducible case, owner, fix SHA, regression test and closure evidence. Passing an internal test suite is not an independent audit or certification.
