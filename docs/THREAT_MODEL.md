# PayFlow Milestone 1 Threat Model

## Assets

Principal authority; mandate integrity; agent identity; authorization decisions; payment credentials; payment execution; replay/cumulative-spend state; audit evidence.

## Trust boundaries

1. Human → PayFlow: the principal defines delegated authority.
2. AI agent → PayFlow: untrusted proposals enter deterministic validation/authorization.
3. Client → server: client assertions are untrusted; payment credentials belong server-side.
4. PayFlow → PayPal: future external financial side-effect boundary.
5. PayFlow → persistence: future durable state/evidence boundary.

## Threats and Milestone 1 posture

| Threat                      | Milestone 1 control                                                                                                              | Residual risk / future work                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection            | LLM is outside authorization boundary; typed policy is deterministic                                                             | Agent can still propose malicious data; discovery-layer defenses later                                                       |
| Compromised agent           | Agent ID, passport status/expiry, explicit capability intersection and mandate binding                                           | Strong agent authentication/attestation is future work                                                                       |
| Mandate mutation            | Canonical SHA-256 fingerprint binds security-critical fields                                                                     | Fingerprint is not a signature; authoritative durable mandate store needed                                                   |
| Privilege escalation        | Capabilities are explicit and independently checked on passport + mandate                                                        | Administrative issuance/revocation service deferred                                                                          |
| Unauthorized capability     | Fail-closed capability checks                                                                                                    | Durable revocation propagation deferred                                                                                      |
| Replay                      | Mandate/proposal nonce and proposal-ID state are checked for duplicates                                                          | In-memory only; atomic durable uniqueness required                                                                           |
| Transaction substitution    | The service retains the evaluated proposal and refuses a different proposal at execution                                         | Current comparison is process-local; a canonical proposal digest/signed grant is future work                                 |
| Amount manipulation         | Typed money + hard/cumulative thresholds + fingerprinted mandate                                                                 | Atomic reservations needed for concurrent transactions                                                                       |
| Currency manipulation       | Exact ISO-like 3-letter currency match                                                                                           | Currency metadata/reference-data validation can be strengthened                                                              |
| Forged client authorization | Execution accepts only the exact Decision Receipt object previously issued and registered by the in-process Trust Kernel service | Object identity is process-local, not a network credential; signed short-lived grants are required for distributed execution |
| Forged human approval       | Approval is accepted only for an issued ESCALATE receipt and the mandate's principal ID                                          | Milestone 1 does not authenticate the human/session that supplies that principal ID                                          |
| Secret leakage              | No credentials in source; env placeholders; env files ignored                                                                    | Secret manager and rotation required for deployment                                                                          |
| Audit-log tampering         | Hash-chain verification detects modified/reordered entries                                                                       | Whole-ledger deletion/replacement remains possible; durable anchored storage deferred                                        |
| Confused deputy             | Mandate, passport, proposal and principal IDs must align                                                                         | Strong authenticated principal/session boundary deferred                                                                     |
| Retry storms                | Duplicate nonce/proposal ID can be denied                                                                                        | Rate limiting/idempotent provider keys deferred                                                                              |
| Stale authorization         | Agent/mandate expiry checked at evaluation                                                                                       | Revalidation immediately before side effect and short TTL grants needed                                                      |
| TOCTOU                      | Architecture identifies side-effect gate                                                                                         | Atomic authorization/reservation/payment workflow is not implemented yet                                                     |

## Explicit non-claims

The evidence ledger is not a blockchain or immutable database. `mandateFingerprint` is not a digital signature. The Milestone 1 provider boundary does not make PayPal calls. In-memory replay, issued-receipt, approval and cumulative-budget state do not provide distributed consistency. Merchant risk is assumed to arrive from trusted server context, not from the proposing agent. Human approval is principal-bound in the domain model but is not backed by production-grade principal authentication in this milestone.
