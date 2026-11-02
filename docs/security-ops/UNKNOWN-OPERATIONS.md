# UNKNOWN outcome operations

Status: DRAFT operational documentation, 2026-11-02. Developer preview, PayPal Sandbox only. Describes what exists in the code on branch `claude/eloquent-einstein-dw0mxk`.

## The rule

**UNKNOWN is financial truth. An operator never re-executes an UNKNOWN payment.** No new `payment_attempts` row, no new execution grant, no new create-order or capture call, no manual status change. The only things that move an UNKNOWN attempt to a terminal state are (a) provider evidence read from PayPal and (b) the existing reconciliation code applying that evidence to the **same** attempt, with the **same** persisted request IDs. A human note is context, never provider truth.

Source of the rule: `docs/OPERATIONS-RECONCILIATION.md`, `docs/ADR-003-paypal-execution-reconciliation.md`, `src/network/reconciliation-ops.ts` ("Observes provider truth only. It never calls rail.execute()"), `src/network/gateway-execution.ts` (UNRESOLVED responses carry `effectCount: null` and `doNotRetry: true`).

### Important precision: what the code actually does today

Two reconciliation implementations exist and they are **not** equivalent:

1. `PayPalExecutionRail.reconcile(attemptId)` in `src/paypal.ts` is the one that runs against Postgres. It always calls Show Order (`getOrder`) first and asserts amount, currency, merchant reference and commerce binding. It is **not purely read-only**: inside a conservative six-hour window measured from `payment_attempts.created_at` (`withinPayPalRetryWindow`), it may resubmit
   - create-order, only when the attempt has no `provider_order_id`, using the stored `create_order_request_id`; and
   - capture, only when Show Order proves the order is `APPROVED`, single purchase unit, with **zero** captures, using the stored `capture_request_id`.
     Both are idempotent resubmissions of the original request ID (PayPal-Request-Id), preceded by a durable Authority revalidation (`dispatch`). A response with a completed capture finalizes the existing attempt; an order that is `COMPLETED` without a capture stays unknown.
2. `ReconciliationOperationsCenter` in `src/network/reconciliation-ops.ts` is lookup-only, compare-and-set, rail-agnostic. It takes an abstract repository. **No Postgres implementation of that repository exists, and no application code writes `reconciliation_queue` or `reconciliation_observations`** (those tables exist in migrations 013 and 015 but are unused by the running system). Do not look in them for live state today; use `payment_attempts`.

Operator consequence: your own investigation is strictly read-only (SQL SELECTs and PayPal GET). The owner-authenticated nudge `POST /api/demo-agent/reconcile` runs implementation 1 and may therefore perform the narrow same-ID resubmission described above. Treat that nudge as "ask the system to finish what it already started", never as a retry tool. If you want a guaranteed observation-only pass, do not use the nudge; use the manual procedure below and escalate. A code change that adds an observation-only mode is recommended in SECURITY-ENGINEERING-REVIEW.md (F-08).

## When is an attempt UNKNOWN

`payment_attempts.status` values (migration 003 check constraint): `NOT_STARTED, ORDER_CREATING, ORDER_CREATE_UNKNOWN, ORDER_CREATED, PAYER_ACTION_REQUIRED, CAPTURE_PENDING, CAPTURE_IN_FLIGHT, CAPTURE_UNKNOWN, CAPTURE_PENDING_PROVIDER, CAPTURED, FAILED, CANCELLED`.

Unsettled states an operator watches: `ORDER_CREATE_UNKNOWN`, `CAPTURE_UNKNOWN`, `CAPTURE_PENDING_PROVIDER`, plus any `ORDER_CREATING` / `CAPTURE_IN_FLIGHT` that has not moved for minutes (the process died mid-call). The partial index `payment_attempt_reconcile_idx` covers the first three.

Typical causes (from `docs/THREAT_MODEL.md`): timeout, connection reset, malformed post-transmission response, ambiguous 5xx, process crash after the provider call.

What the system holds while UNKNOWN: the execution grant stays `CLAIMED` (not `CONSUMED`, not `FAILED`), the reservation stays `EXECUTING`, and the authority is quarantined. The agent receives `status: UNRESOLVED`, `effectCount: null`, `doNotRetry: true`. Portable Proof for the operation answers `409 PROOF_NOT_ISSUABLE` until the outcome is verified.

## Fields to look at

Start from the attempt, then walk outward.

```sql
select id, status, provider, idempotency_key,
       grant_id, reservation_id, proposal_id, mandate_id, principal_id,
       amount_minor, currency, merchant_reference,
       create_order_request_id, capture_request_id,
       provider_order_id, provider_status, provider_capture_id, provider_capture_status,
       payer_action_url is not null as has_payer_url,
       failure_classification, provider_debug_id,
       last_reconciled_at, captured_at, created_at, updated_at
from payment_attempts where id = '<ATTEMPT_ID>';

select id, status, claimed_at, consumed_at, failed_at, expires_at from execution_grants where id = '<GRANT_ID>';
select id, status, amount_minor, currency, expires_at, updated_at from authorization_reservations where id = '<RESERVATION_ID>';
select id, principal_id, authorized_agent_id, spent_minor, cumulative_limit_minor, revoked_at from mandates where id = '<MANDATE_ID>';
select sequence, type, occurred_at, data from evidence_events
  where data::text like '%<ATTEMPT_ID>%' order by sequence;
```

How to read them:

| Field                                                  | Meaning for the operator                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                                               | Which step is in doubt. `ORDER_CREATE_UNKNOWN`: no order known. `CAPTURE_UNKNOWN`: order exists, capture result unknown.                         |
| `provider_order_id`                                    | The key for Show Order. If null the order may or may not exist at PayPal; the stored `create_order_request_id` is the idempotency handle.        |
| `provider_capture_id`, `provider_capture_status`       | Set only after provider evidence. `PENDING` is not completion; `COMPLETED` is.                                                                   |
| `amount_minor`, `currency`, `merchant_reference`       | What the Authority allowed. PayPal must show the same amount, currency, and `reference_id` equal to `proposal_id`. Any difference is a mismatch. |
| `create_order_request_id`, `capture_request_id`        | Stable idempotency IDs. Never regenerate them. Record them in the incident log; they are not secrets.                                            |
| `failure_classification`                               | A value starting `COMMERCE_` means a commerce-binding mismatch was found; the attempt is quarantined and `reconcile` refuses it.                 |
| `last_reconciled_at`                                   | Last time the system looked. Old plus UNKNOWN means nobody has run reconciliation (there is no scheduler).                                       |
| `created_at`                                           | Start of the six-hour retry window. After the window, no resubmission is possible; only lookup.                                                  |
| grant `CLAIMED`, reservation `EXECUTING`, `claimed_at` | Authority is held. Do not revoke-and-reissue to "unstick" it; that would let a second effect occur if the first one landed.                      |
| `mandates.revoked_at`                                  | If set, the final reconcile still records the truth, but no further dispatch is allowed.                                                         |

## Reading provider state read-only

Allowed (all are GET / dashboard views):

1. PayPal Sandbox dashboard: sign in with the Sandbox business account that is the payee, Transactions, search by order ID or capture ID.
2. API Show Order: `GET https://api-m.sandbox.paypal.com/v2/checkout/orders/<PROVIDER_ORDER_ID>` with a Bearer access token obtained by the operator from the Sandbox app credentials held in the secret manager. Do not put the client secret or access token in logs or tickets. If `provider_order_id` is null, search the dashboard by amount, time window and the `reference_id` (= `proposal_id`).
3. Read `purchase_units[0].amount`, `purchase_units[0].payments.captures[]` (id, status, amount), `status`, `payee.merchant_id`.

Forbidden for the operator: `POST .../orders`, `POST .../capture`, `POST .../refund`, voids, creating a new order for "the same" purchase, or editing `payment_attempts`.

## What the provider answer means

| Show Order says                                                                    | Meaning                                       | What happens / operator action                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly one capture `COMPLETED`, amount/currency/merchant match, order `COMPLETED` | One effect happened                           | Reconciliation finalizes the existing attempt `CAPTURED`, reservation `COMMITTED`, grant `CONSUMED`, appends evidence. No other action.                                                                               |
| Capture `PENDING`                                                                  | Provider has not finished                     | Attempt becomes `CAPTURE_PENDING_PROVIDER`. Wait and reconcile again. Do not treat as success or failure.                                                                                                             |
| Order `APPROVED`, zero captures                                                    | Capture did not land (as far as PayPal shows) | Inside the six-hour window the rail may resubmit the same `capture_request_id`. Outside it, the attempt stays unknown: escalate (see below).                                                                          |
| Order `CREATED` / `PAYER_ACTION_REQUIRED`, zero captures                           | Payer has not approved                        | Attempt waits for payer action (`PAYER_ACTION_REQUIRED`). Not an operator problem.                                                                                                                                    |
| Order `COMPLETED` but no capture object                                            | Inconsistent                                  | Stays unknown. Escalate. Do not guess.                                                                                                                                                                                |
| Order not found (404) and `provider_order_id` known                                | Unexpected                                    | Stays unknown. Escalate; capture a screenshot and the `provider_debug_id`.                                                                                                                                            |
| Amount, currency, payee or `reference_id` differ from the attempt                  | Provider/local divergence or substitution     | `COMMERCE_*` classification, attempt quarantined, evidence appended. This is a SEV-1 candidate: run RB-1 in INCIDENT-RUNBOOKS.md.                                                                                     |
| Two or more captures                                                               | Duplicate effect                              | SEV-1. Stop, preserve evidence, run RB-1. Refunds are an external business decision, not an operator shortcut.                                                                                                        |
| Definitive rejection of the first create-order                                     | Zero effect proven                            | The rail records a definitive create failure: attempt `FAILED`, grant `FAILED`, reservation `FAILED`, evidence `PAYMENT_EXECUTION_FAILED`. This is the only path to a proven-zero state besides a later lookup proof. |

Resolution semantics in the lookup-only operations center (`deriveReconciliationState`): `SUCCEEDED` with `effectCount 1` resolves to `RESOLVED_SUCCEEDED`; `FAILED` with `effectCount 0` resolves to `RESOLVED_FAILED`; anything else is `UNRESOLVED`. Mirror this standard by hand: success needs evidence of exactly one effect, failure needs evidence of zero effects, everything else stays open.

## Procedure

1. List unsettled attempts (Q2 in INCIDENT-RUNBOOKS.md). Oldest first.
2. For each, run the attempt query above and record the table values in the log.
3. Read provider state (section above). Record order status, capture IDs, amount, currency, payee.
4. Compare. If everything matches and PayPal shows one completed capture: ask the owner to run the reconcile nudge (`POST /api/demo-agent/reconcile`, owner session) so the system finalizes the attempt with its own code. Re-query and confirm `status = 'CAPTURED'`, reservation `COMMITTED`, grant `CONSUMED`, and a new `evidence_events` row.
5. If PayPal shows nothing at all and the attempt is inside the six-hour window: run the nudge once, re-query. Do not run it repeatedly.
6. If the attempt is outside the window, still UNKNOWN, or evidence conflicts: stop. Escalate (below). Leave the authority quarantined.
7. After resolution, fetch the Proof (`GET /v1/proofs/{proposalId}` with `proof:read`); the portable Proof can be issued once the outcome is verified.

## Escalation

| Condition                                                         | Escalate to                 | Within                            |
| ----------------------------------------------------------------- | --------------------------- | --------------------------------- |
| UNKNOWN older than 1 hour with a healthy provider                 | Incident lead               | no SLA exists; target is internal |
| UNKNOWN older than 24 hours, or outside the six-hour window       | Incident lead + engineering | same day                          |
| Any amount/currency/payee mismatch, `COMMERCE_*`, or two captures | SEV-1 (RB-1)                | immediately                       |
| Suspected evidence tampering (hash chain break, edited row)       | SEV-1 (RB-1), then RB-8     | immediately                       |

"Within" values are internal working targets for a preview with no on-call staff, not commitments to anyone.

## Do not

- Do not revoke and recreate an Authority to "retry" a purchase while its attempt is UNKNOWN.
- Do not clear `reconciliation_queue` rows or insert `reconciliation_observations` by hand; the application does not read them.
- Do not mark an attempt `FAILED` because the provider is silent. Silence is UNKNOWN.
- Do not tell an agent or user "it failed" or "it succeeded" before the attempt is terminal. Say it is being reconciled.
- Do not paste PayPal tokens, client secrets or full API responses containing personal data into tickets.

## NOT IMPLEMENTED

- A Postgres-backed `ReconciliationRepository` and a worker that fills and drains `reconciliation_queue` / `reconciliation_observations`.
- A scheduled reconciliation job. `reconcileOutstanding()` exists but nothing schedules it (no cron in `vercel.json` or `hosting/m6/vercel.json`).
- An operator-facing route or CLI for reconciliation (only the owner-session nudge on the demo console host exists; the Gateway has the `reconcile:request` scope name but no `/v1` reconcile route).
- An observation-only reconcile mode and an age-based alert for stale UNKNOWN attempts.
- Alerting. No monitoring or paging is configured in the repository.
