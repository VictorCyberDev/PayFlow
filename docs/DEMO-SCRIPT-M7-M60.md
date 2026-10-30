# M7–M60 consolidated demo script

This script is designed for a local/sandbox release candidate. Do not substitute simulator output for real-provider claims.

1. **Frame — Authority.** Show a principal/organization creating a bounded Authority: exact agent, action class, counterparty, integer money/currency, time and delegation limits.
2. **Gate — external agent.** Submit one valid Gateway action and one drifted amount/merchant action. The same Trust Kernel returns ALLOW for the valid action and DENY for drift.
3. **Delegation.** Show parent→child attenuation and a widening attempt failing.
4. **Verify.** Present a signed, audience/challenge-bound Authority to the read-only verifier; tampering, expiry, revocation and replay fail distinctly.
5. **Commit — rail neutral.** Use a bounded one-time grant against the deterministic rail simulator. Duplicate execution returns the same single simulated effect.
6. **UNKNOWN.** Run timeout-after-effect. The first result is UNKNOWN; reconciliation uses lookup only and resolves the existing effect without execution retry.
7. **Proof.** Sign the portable Proof payload and verify it with the standalone verifier. Tamper one field and show signature failure.
8. **Protocols.** Display the five MCP tools and A2A Agent Card. Explain that transports carry requests but do not create Authority.
9. **Enterprise.** Show organization boundary, agent lifecycle, dual-control approvals, policy packs and AP connector normalization.
10. **Federation / M60.** Run the local global-network demonstrator: external platform identity → signed external issuer assertion under explicit trust profile → independent verifier evidence → replaceable rail → UNKNOWN reconciliation → portable Proof.
11. **Break Authority.** Run deterministic 100 and 1,000 scenario suites. Describe them as local Trust Kernel/adversarial results, never as real provider captures.
12. **Close.** `Any agent. Any rail. One authority truth.` State external blockers truthfully: M6 live PayPal acceptance, real additional rail/provider pilots, independent audit, standards/app publication and adoption remain separate external evidence.
