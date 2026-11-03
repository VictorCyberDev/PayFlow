# Design Partner Pilot Pack

Status: DRAFT proposal template. **Sandbox only: PayPal Sandbox, no real money.** No enterprise SLA, no uptime promise, no certification, no named customers. PayFlow is a developer preview with no customers today.

## 1. Executive overview

PayFlow decides what an AI agent may economically do, enforces that decision before money moves, and proves what happened. The pilot tests whether that boundary works on one bounded workflow of the partner's, in a sandbox, and records measured results.

## 2. Architecture summary

Per the repo README: untrusted intent -> trusted identity -> bounded Authority and delegation -> deterministic Trust Kernel -> durable reservation -> one-time exact-bound execution grant -> runtime revalidation -> replaceable rail -> reconciliation -> Proof. Ambiguous provider outcomes stay `UNKNOWN` until reconciled. See docs/ARCHITECTURE.md.

## 3. Security summary

See docs/THREAT_MODEL.md, docs/COMPANY-LAUNCH-SECURITY-REVIEW.md and docs/SECURITY-ASSURANCE-READINESS.md. Credentials are scoped, expiring and revocable; only digests are stored. This is internal review only: no independent audit, no certification.

## 4. Sandbox guide

Follow docs/QUICKSTART-M7.md. The quickstart's five-minute target is unmeasured and must not be quoted.

## 5. Use-case definition template

| Item                                  | Partner fills in                    |
| ------------------------------------- | ----------------------------------- |
| Agent and owner                       |                                     |
| Action type (pay / refund / purchase) |                                     |
| Amount ceiling, currency              |                                     |
| Allowed payees/merchants              |                                     |
| Approval step (who, when)             |                                     |
| Rail used in sandbox                  | PayPal Sandbox                      |
| Expected volume in pilot              |                                     |
| Failure cases to test                 | denial, replay, revocation, UNKNOWN |

## 6. Success metrics (measured, not pre-filled)

Authorities created; governed actions; deny/escalate rate; replay attempts blocked; UNKNOWN rate and reconciliation latency; Proof exports verified independently; integration defects; partner-reported time to integrate. Targets are agreed with the partner before start; none are promised here.

## 7. Responsibilities

- PayFlow: sandbox workspace, SDK, docs, issue response on a best-effort basis, defect fixes as capacity allows.
- Partner: named sponsor and technical contact, use-case definition, test data, feedback, security questions.
- Both: record evidence honestly; no mock data presented as partner data.

## 8. Data handling

Sandbox only. No production customer or payment data. Retention per docs/DATA-PRIVACY-RETENTION.md. Legal terms (confidentiality, data processing, liability) have had no legal review and must be settled before any engagement; see docs/DESIGN-PARTNER-PILOT-KIT.md.

## 9. Support

Best effort, by email or shared channel agreed per pilot. No response-time commitment and no on-call.

## 10. Timeline (indicative)

Week 0: scope and use case. Week 1: sandbox provisioned, integration. Week 2: test vectors (denial, replay, revocation, UNKNOWN). Week 3: measured run. Week 4: review and written outcome. Dates depend on the partner; none are committed.

## 11. Procurement worked example (to adapt, not a claim of any partner)

Authority: office supplies, one approved vendor, $100 per purchase, $500 per month, human approval above $50. The agent asks for a $84 keyboard.
ALLOW within the limit (paid once in the Sandbox), DENY when the vendor or price is outside the Authority ($0 moved), ESCALATE when the amount is above the autonomous threshold (nothing is reserved or paid until a person with an approver role decides), and a Proof the partner's finance team can verify offline. See docs/PROCUREMENT-AUTHORITY.md.

## 12. Integration requirements

- An engineer who can call `actions.execute` from the agent (TypeScript or Python SDK, or plain HTTPS).
- A named human who owns each Authority, and a named person per role (approver, security, finance reader).
- The partner's own agent, or the sample agent, and the Sandbox payment rail. No production rail is available yet.
- A decision on what the partner wants to prove afterwards, so the Proof fields match their audit question.

## 13. Evidence plan

Everything measured in section 6 is read from PayFlow's own records (audit trail, reconciliation metrics, Proof) and from the partner's feedback log. Nothing is pre-filled. At the end: the written outcome, the Proof exports the partner verified themselves, the defects found, and what the partner would need before a production pilot. No result is published or named without the partner's written agreement.

## 14. Security brief

One page for the partner's security reviewer: docs/security-ops/THREAT-MODEL-UPDATE.md (what is defended and what is not), docs/security-ops/M14-OPERATIONS.md (reconciliation, alerts, key rotation, database roles), the role matrix in `src/network/rbac.ts`, and the limits stated on the public Security page. No independent audit or certification exists.
