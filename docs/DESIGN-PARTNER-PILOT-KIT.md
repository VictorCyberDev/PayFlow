# Design Partner Pilot Kit

Status: **COMPLETE_LOCAL / BLOCKED_EXTERNAL** until a real organization agrees to participate.

## Pilot onboarding

1. Identify the legal organization and named sponsor.
2. Provision an isolated sandbox workspace; never import production customer/payment data for a pilot by default.
3. Register only the pilot agents that need financial authority.
4. Define one bounded Authority template and one measurable workflow.
5. Run denial, replay, revocation and UNKNOWN/reconciliation test vectors before any provider sandbox execution.
6. Record implementation evidence, feedback and security questions without inventing customer statements.

## Integration checklist

- Principal and organization mapped.
- Agent identity and sponsor recorded.
- Sandbox/production environment separated.
- Authority scope, amount, merchant/payee, expiry and action type explicit.
- Gateway credentials scoped; no omnipotent API key.
- Verification path tested independently.
- Webhook receiver authenticates events and handles duplication.
- UNKNOWN outcome runbook tested.
- Proof package export tested.
- Rollback/revocation contact named.

## Pilot metrics

Instrument real values only: Authorities created, governed actions, deny/escalate rate, replay attempts, UNKNOWN rate, reconciliation latency, verification calls, Proof views and integration defects. Do not pre-populate success metrics.

## Security questionnaire topics

Data classification; secrets; tenant isolation; authentication; authorization; encryption; retention; incident response; dependency management; provider credentials; replay/idempotency; reconciliation; audit evidence; subprocessors; geographic constraints; business continuity.

## Agreement requirements

Before a live design-partner engagement: scope, sandbox vs production boundary, data-processing terms, confidentiality, security contacts, liability allocation, permitted provider actions, incident notification, support expectations, termination/revocation and evidence retention.

## Evidence template

Record organization, environment, integration version, exact commit, test vector IDs, timestamps, verifier results, rail/provider used, provider evidence if any, UNKNOWN/reconciliation evidence, defects and sign-off. Never replace missing partner evidence with mock data.
