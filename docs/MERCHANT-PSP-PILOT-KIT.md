# Merchant / PSP Verification Pilot Kit

Status: **COMPLETE_LOCAL / BLOCKED_EXTERNAL** until a real merchant or PSP integrates.

Local prerequisites included in the repository: signed Authority presentations, replay/freshness verification, public Verify quota interface, issuer/key directory, merchant SDK alpha, Gate Mark state model, test vectors and a checkout example.

## Partner checklist

- Named technical/security contacts.
- Sandbox-only first integration.
- Merchant/verifier audience identifier defined.
- Challenge issuance and replay store wired durably.
- Key discovery/rotation test completed.
- Valid/revoked/expired/tampered vectors pass.
- UNKNOWN/reconciliation runbook reviewed.
- Gate Mark rule understood: mark is not proof.
- No provider/payment credential crosses the Verify API.
- Pilot telemetry records real results only.

## Metrics

Verification latency, verification volume, invalid/revoked/expired rate, replay attempts, directory cache misses, integration errors and Proof-link usage. Customer/revenue/adoption metrics remain zero/unknown until a real external pilot exists.
