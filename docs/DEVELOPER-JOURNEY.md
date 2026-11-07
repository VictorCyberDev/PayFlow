# Developer journey and failure matrix (Phase B)

Status: **COMPLETE_LOCAL.** Executed by `tests/phase-b-developer-journey.integration.test.ts` against real PostgreSQL and the
real hosted Gateway over HTTP, through the supported SDKs and APIs only. The "rail" is a deterministic provider double:
**no real money moved and no hosted (deployed) behaviour is claimed.**

## The journey

| #   | Step                                                                                         | Through                                                               |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | A stored Gateway Authority exists for the tenant                                             | sandbox Authority provisioning (database row)                         |
| 2   | The member issues a signed portable credential FROM that stored Authority                    | `PayFlowMemberClient.credentials.issue`                               |
| 3   | The merchant learns the issuer's keys and revocations, pinned to one thumbprint, by fetching | `IssuerDirectoryClient` (`/v1/issuer/directory`, `/v1/issuer/status`) |
| 4   | Merchant issues a single-use challenge bound to one order (and restarts before using it)     | `MerchantVerifier` + PostgreSQL stores                                |
| 5   | The agent presents the credential for that audience, challenge and nonce                     | `present()`                                                           |
| 6   | The merchant verifies it against the order                                                   | `MerchantVerifier.verifyAgent`                                        |
| 7   | The agent pays: reservation, one-time grant, simulated effect                                | `PayFlowClient.actions.execute` with the agent's own credential       |
| 8   | A portable Proof is produced and tied to the order once via hosted Verify                    | `/v1/proofs/{id}/portable`, `hostedProofVerifier`                     |
| 9   | Anyone verifies the Proof offline with the public key document only                          | `@payflow/open-verifier`                                              |

## Failure matrix (each asserts the exact reason, and that no effect happened where none should)

| Case                                                 | Result observed                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Amount beyond the credential                         | merchant: `ACTION_NOT_IN_SCOPE`                                                                                      |
| Amount not matching the trusted price at the Gateway | `DENIED`, `$0`, `CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE`                                                           |
| Wrong merchant / wrong currency                      | merchant: `ACTION_NOT_IN_SCOPE`; Gateway `DENIED`                                                                    |
| Wrong agent                                          | presentation signed by another key: `POSSESSION_NOT_PROVEN`; payment as another agent: `ACCESS_AGENT_MISMATCH`, `$0` |
| Tampered credential                                  | `ROOT_SIGNATURE_INVALID`                                                                                             |
| Replayed challenge / presentation                    | `UNKNOWN_CHALLENGE`, also from a second merchant instance                                                            |
| Revoked credential, revoked Authority                | merchant learns `REVOKED` from the signed status list; Gateway `AUTHORITY_REVOKED`, `$0`; Gate Mark `REVOKED`        |
| Stale issuer status                                  | `STATUS_LIST_STALE`, Gate Mark `UNKNOWN`; recovers on refresh                                                        |
| Stale directory                                      | `UNKNOWN_ISSUER_KEY` (fail closed); recovers on refresh                                                              |
| Key rotation                                         | pre-rotation credential and post-rotation credential both verify through a client that followed the chain            |
| Duplicate payment                                    | same nonce executes once (`REPLAY_DETECTED`); one Proof cannot pay a second order                                    |
| UNKNOWN effect                                       | `UNRESOLVED`, `effectCount: null`; merchant `HOLD / OUTCOME_UNKNOWN`; no second capture                              |
| Interrupted execution (lost create response)         | `UNRESOLVED`, `doNotRetry`; replay refused; one order, no capture                                                    |
| Merchant-store restart                               | unspent challenge survives, spent one stays spent, ledger entry survives                                             |
| Concurrent delegated spending                        | of two concurrent purchases on a shared budget, one succeeds, one is refused; a widening hop is refused              |
| Cross-tenant access                                  | another organization lists, revokes, delegates and issues nothing; the original keeps working                        |

Mutation checks that fail this suite: omitting revoked Authorities from the status list, ignoring the tenant on credential
revocation, and letting one payment pay two orders.

## Not claimed

- Nothing here runs on the deployed host, a real PayPal rail, a real merchant, or a real agent framework.
- The Gateway's own Authority ceiling is exercised elsewhere; with the demo catalog the amount that reaches the Gateway is
  fixed by the trusted price, so the Gateway-side "amount" case is a price-mismatch denial, not an Authority-ceiling denial.
- Clock is a fixed test clock; real clock skew between issuer and merchant is not exercised.
