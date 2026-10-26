# M6 Acceptance Handoff — Delegated / Human-Not-Present Commerce

Status: **IMPLEMENTATION + REGRESSION HARDENING COMPLETE; LIVE PAYPAL SANDBOX ACCEPTANCE STILL REQUIRED**

PR #16 must remain unmerged and M7 must remain unstarted until the isolated hosted wallet bootstrap and fresh live Sandbox execution end in `M6 SANDBOX ACCEPTANCE: PASS`, independent review finds no blocking defect, and the merge decision is explicitly made.

## Pull request

- Repository: `VictorCyberDev/PayFlow`
- PR: `#16 — M6 — Delegated / Human-Not-Present Commerce`
- Branch: `m6-delegated-human-not-present-commerce`
- Base: `main` at `880a890f9e0735d03ee7e0de625907e408f5fc73`
- PR state: Draft, open, mergeable, unmerged
- M7: **not started**

## Verification state

The repaired M6 branch has passed exact-head GitHub verification across:

- root format, lint, typecheck, unit tests, PostgreSQL integration tests, coverage, production dependency audit, and build;
- console lint, typecheck, tests, and production build;
- Chromium E2E.

After the first green exact-head run, additional regression coverage was added specifically to lock the repaired wallet boundary:

- browser callback POST contains only random `state` and never setup token / vault id / credentials;
- stored owner wallet is loaded server-side at order-create time;
- missing owner wallet fails before a PayPal order is created;
- hosted Agent payment readiness follows durable wallet state, not environment-variable presence.

The final PR head must be green again after these hardening/documentation commits before deployment evidence is accepted.

## M6 persistence and security boundary

M6 now contains two additive forward-only migrations:

- `011_m6_delegated_payment_instrument.sql` — AES-256-GCM encrypted owner-bound PayPal delegated instrument;
- `012_m6_paypal_vault_setup_state.sql` — AES-256-GCM encrypted, ten-minute, one-time setup token bound to principal + authenticated durable console session + random callback state digest.

The browser never receives the PayPal setup token or stored vault id. PayPal callback completion accepts only a 43-character random state token. The corresponding setup row is atomically claimed once, then exchanged server-side. The resulting payment token is stored encrypted and owner-bound.

## Hosted M6 acceptance environment

Dedicated acceptance environment only; historical M5 deployment and financial evidence are not reused.

- Stable URL: `https://payflow-m6-acceptance.vercel.app`
- Vercel project: `payflow-m6-acceptance`
- Hosting root: `hosting/m6/`
- Historical M5 hosting root remains `hosting/m5/`

The next deployment must be proven to come from the final green PR head before live acceptance proceeds.

Required host configuration remains private and must not be pasted into chat, committed, or printed:

- `DATABASE_URL`
- `PAYFLOW_M5_PRINCIPAL_ID`
- `PAYFLOW_M5_AGENT_ID`
- `PAYFLOW_M5_BOOTSTRAP_KEY`
- `PAYFLOW_M5_ORIGIN=https://payflow-m6-acceptance.vercel.app`
- `PAYFLOW_M6_DEMO_AGENT=true`
- `PAYFLOW_M6_SIGNING_KEY` (persistent Ed25519 PKCS#8 PEM)
- `PAYPAL_ENVIRONMENT=sandbox`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_EXPECTED_MERCHANT_ID` (real 13-character Sandbox merchant id)

`PAYPAL_DELEGATED_VAULT_ID` is **not** part of the hosted acceptance configuration anymore. The owner creates the delegated instrument through the one-time hosted wallet bootstrap, and the Agent consumes that encrypted database record.

## Remaining live acceptance sequence

### Gate A — exact-head deployment

1. Confirm the final PR head is green across all CI jobs.
2. Deploy that exact commit to the dedicated M6 Vercel project.
3. Verify the deployment source SHA and stable acceptance alias.
4. Verify static security headers and fail-closed unauthenticated API behavior.

### Gate B — one-time owner wallet approval

From the authenticated M6 console, the owner selects **Connect Sandbox PayPal** and completes PayPal Sandbox payer approval once.

Acceptance requirements:

- start response contains only `approvalUrl`; no setup token;
- PayPal returns with random `state` only;
- completion stores one encrypted owner payment instrument;
- `/api/paypal-vault/status` becomes `connected: true` for that owner;
- `/api/demo-agent/status` becomes `SANDBOX_CONNECTED` because the durable instrument exists;
- no purchase occurs during wallet setup.

### Gate C — true delegated execution

Run the hardened acceptance runner against the same isolated database and hosted owner/Agent identity:

```bash
RUN_M6_SANDBOX_ACCEPTANCE=true \
DATABASE_URL='…' \
PAYPAL_ENVIRONMENT=sandbox \
PAYPAL_CLIENT_ID='…' \
PAYPAL_CLIENT_SECRET='…' \
PAYPAL_EXPECTED_MERCHANT_ID='…' \
PAYFLOW_M5_PRINCIPAL_ID='…' \
PAYFLOW_M5_AGENT_ID='…' \
PAYFLOW_M5_BOOTSTRAP_KEY='…' \
PAYFLOW_M6_SIGNING_KEY="$(cat key.pem)" \
npm run acceptance:m6:sandbox
```

The runner refuses a database with prior financial history and refuses when the owner has no approved stored instrument.

A PASS requires all of the following:

- `$84.00 USD` outcome `COMPLETED`;
- `askedHuman === false` during delegated execution;
- exactly one PayPal order;
- exactly one PayPal capture;
- second attempt adds zero captures and does not complete;
- payment attempt `CAPTURED`;
- reservation `COMMITTED` for 8400 minor units;
- execution grant `CONSUMED`;
- live provider order terminally `COMPLETED` with exactly one capture;
- Operation Trace `VERIFIED`;
- output terminates with `M6 SANDBOX ACCEPTANCE: PASS`.

### Gate D — zero-effect drift

On the hosted console, the `$184` trusted-price drift scenario must remain blocked before provider effect and project `$0 moved` in Activity/Trust Trace.

### Gate E — independent review and merge decision

After live PASS only:

1. Preserve non-secret acceptance evidence: exact commit SHA, deployment ID/URL, Sandbox order id, capture id, bounded call counts, reservation/grant/payment terminal states, Trace verdict, and `$184` zero-effect evidence.
2. Review the full PR diff independently for authority widening, browser-held authority, secret leakage, replay gaps, provider retry ambiguity, owner isolation, and stale docs/config.
3. Resolve every blocking finding.
4. Re-run final CI if review changes code.
5. Mark PR ready for review only when all gates remain clean.
6. Merge only after the merge decision is explicitly authorized.
7. Start M7 only from the merged M6 state.

## Non-regression boundary

M6 does not redesign the accepted M1–M5 Trust Kernel, AgentPassport, Mandate, deterministic authorization, durable reservations/accounting, Ed25519 one-time grants, payment-attempt state machine, PayPal UNKNOWN/reconciliation logic, trusted quote/sealed manifest, EvidenceLedger, OperationTraceService, Authority projections, or owner/session controls.

Browser returns, UI state, PayPal setup approval, and provider observations are inputs/evidence. None independently grants financial authority.
