# PayFlow takeover audit and truth ledger — M7→M25

Audit date: 2026-11-02. Working branch: `claude/eloquent-einstein-dw0mxk`.
Nothing here is a claim of public release or external acceptance. Status words are
exactly: `COMPLETE_REAL`, `COMPLETE_LOCAL`, `BLOCKED_EXTERNAL`, `PARTIAL`.

## 1. Source truth

| Item                                           | Finding                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Default branch                                 | `main` @ `3b1b263b9f504e0a3b2503d173cd66ad9d266739` (merge of PR #16, M6). Reconfirmed on GitHub.                                   |
| PR #18 `m7-m60-master-execution`               | Open, head `d3773ec`. 39 commits, 245 files, +35.9k lines. Branched from `9f1aca9`, which pre-dates the merged M6.                  |
| PR #17 `roadmap/m7-m60-authority-network-lock` | Open (ADR-017 roadmap lock). Docs only.                                                                                             |
| PR #5 `pre-m4-vercel-deployment-shell`         | Open and stale since M4. Candidate to close; not touched.                                                                           |
| Hosted production                              | Vercel project `payflow` serves `main` @ `3b1b263` (M6). `payflow-m6-acceptance` serves the M6 branch. **No M7+ code is deployed.** |
| Environment                                    | This session has no PayPal, Groq, database or Vercel secret variables. Hosted environment variable values were not read.            |

### Reconciliation (done)

PR #18 was **not** merged blindly. Its head was merged into current `main` on this branch
(`git merge`, no history rewrite). There were no textual conflicts. Migrations 001–012 (main, M6)
and 013–019 (integration) are a gap-free sequence and apply cleanly on an empty database.

Verified on the merged tree (local, PostgreSQL 16; CI uses 17):

- `tsc --noEmit`, `eslint .`, `prettier --check .`, secret scan (454 files, 0 findings), `evidence:check`, build: pass
- Unit: 1074 passed (826 skipped = PostgreSQL suites without a database)
- PostgreSQL integration: 22 files, 823 tests passed (including all M6 suites — M6 behaviour is intact)
- Python SDK: 4 passed. Console: 98 passed.

After the Gateway execution work in §3, with a database present: 1911 unit/integration tests
pass in the default run and the 23 integration files pass (837 tests). Format, lint, typecheck,
secret scan, evidence check and build are green.

## 2. Takeover matrix

| Component                                                                | Class                          | Notes                                                           |
| ------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------- |
| Trust Kernel, durable reservation, execution grants, boundary            | PRESERVE                       | The one decision path. Untouched.                               |
| M6 delegated commerce, PayPal rail, reconciliation, Proof                | PRESERVE                       | Reused as the execution path for the Gateway.                   |
| `src/network/*` gateway, access, verify, events, enterprise, federation… | RECONCILE → PRESERVE           | Merged; passes. Breadth is far ahead of customer evidence.      |
| `src/protocols/*` MCP, A2A, HTTP adapters                                | PRESERVE                       | Real stdio subprocess tests exist; not re-audited line by line. |
| REST `/v1/actions` (non-executing)                                       | EXTEND                         | Ended at ALLOW + grant. See §3.                                 |
| Gateway → real payment execution                                         | **EXTEND (done this session)** | `src/network/gateway-execution.ts`, `rest-execution.ts`.        |
| SDKs (TS, Python), OpenAPI, verifier CLI, merchant SDK                   | EXTEND                         | Do not yet cover `/v1/actions/execute`.                         |
| Console / company site (`apps/console`)                                  | PRESERVE                       | Not deployed with M7+.                                          |
| Docs/legal/privacy/pricing drafts                                        | PRESERVE                       | Drafts for counsel; no legal review exists.                     |
| `packages/sdk-python/**/__pycache__` tracked                             | REMOVE (done)                  | Build artefacts had been committed.                             |
| Hosted Gateway, credential issuance, live Sandbox run                    | BLOCKED_EXTERNAL               | Needs deployed environment and PayPal Sandbox credentials.      |

## 3. The M7 residue found

`FinancialAuthorityGateway.requestAction` and `DurableFinancialAuthorityGateway` stopped at
`ALLOW + reservation + grant`. Integration tests ran the Execution Boundary into a
**fake sink**. M7.4 (“must not end at ALLOW + grant”) was not met. Nothing in the Gateway
referenced the PayPal rail.

PayPal human-not-present capture is only possible through M6's vaulted, commerce-bound path
(trusted quote, sealed manifest, merchant binding). A generic proposal cannot be captured
without a payer. So the Gateway must route through that path rather than invent another.

### What was built

`ExecutingGateway.requestPurchase` (`src/network/gateway-execution.ts`) sits in front of the
existing `DelegatedCommerceService`. It:

1. verifies access (scope `action:request`, audience, expiry, status);
2. binds the credential to exactly one agent and principal, and the Authority to that pair;
3. claims the nonce atomically (`replay_keys`), so a replay is a zero-effect DENY;
4. runs the **existing** path: trusted quote → claimed-terms check → manifest → proposal →
   Trust Kernel → durable Reservation → one-time grant → Execution Boundary → rail;
5. maps the outcome to a structured response (`decision`, `status`, `effectCount`, `reason`,
   `recoverable`, `humanSummary`, `nextAction`, `proof` references).

The only change to M6 code is an optional `expected` field on `DelegatedAttemptInput`: the
agent's claimed amount/currency/merchant is compared with the trusted quote and refused on
mismatch before any manifest, proposal, reservation or grant exists. The claim is never
authority.

`createExecutingRestHandler` (`POST /v1/actions/execute`) is a thin HTTP adapter with
structured failure bodies. An unexpected error reports `effectCount: null` and `doNotRetry`,
never a false “zero”.

### Evidence (PostgreSQL, fake provider) — `tests/m7-gateway-execution.integration.test.ts`, 14 tests

| Acceptance action                                           | Result                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Valid $84 inside Authority                                  | `COMPLETED`, 1 create + 1 capture, 1 grant                         |
| Claimed amount ≠ trusted price                              | `DENY`, 0 reservations/grants/attempts, 0 provider calls           |
| Merchant substitution                                       | `DENY`, zero effect                                                |
| Trusted price $184 vs $100 limit (drift)                    | `DENY AMOUNT_EXCEEDS_AUTHORITY`, zero effect                       |
| Authority limit below price                                 | `DENY NO_OFFER_INSIDE_AUTHORITY`, zero effect                      |
| Replay of same nonce                                        | `DENY REPLAY_DETECTED`, provider effects stay 1                    |
| Revoked Authority                                           | `DENY AUTHORITY_REVOKED`, zero effect                              |
| Wrong agent / principal / scope / audience / expired access | rejected before anything stored                                    |
| Unknown field smuggling extra Authority                     | `REQUEST_MALFORMED`, zero effect                                   |
| 5 concurrent $84 vs $100                                    | exactly 1 `COMPLETED`, 1 capture                                   |
| Lost capture response                                       | `UNRESOLVED`, `effectCount: null`, `doNotRetry`; no second capture |

“Provider” above is the repository's fake PayPal provider. **This is not a PayPal Sandbox
result.**

## 4. Milestone status (honest)

| Milestone          | Status                                                                                                      | Basis                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M6                 | Accepted as demonstrated sandbox execution (historical). No strict fresh-DB acceptance runner was ever run. | Unchanged.                                                                                                                                                                                                               |
| M7                 | **PARTIAL**                                                                                                 | Execution seam built and tested locally. Missing: live PayPal Sandbox run through the Gateway, hosted endpoint, credential issuance/revocation flow, SDK/OpenAPI coverage of `/v1/actions/execute`, deployed quickstart. |
| M8 Verify          | PARTIAL                                                                                                     | Code, CLI and tests exist and pass; not re-audited against every M8 item; not hosted.                                                                                                                                    |
| M9 Break Authority | PARTIAL                                                                                                     | Reproducible 1,000-attack evidence is committed and checked byte-for-byte; the “real model” demo needs a live model key and has not been run here.                                                                       |
| M10 Public preview | PARTIAL                                                                                                     | Site, docs and drafts exist in source; none deployed from this branch; legal/privacy text awaits counsel; status page must show only measured state.                                                                     |
| M11–M15            | PARTIAL                                                                                                     | Procurement/enterprise/pilot/billing foundations in source. No customer, pilot or pricing evidence exists, so Gate B cannot close.                                                                                       |
| M12                | BLOCKED_EXTERNAL (partner acceptance)                                                                       | Internal CRM/pilot assets exist; no partner has accepted.                                                                                                                                                                |
| M16–M24            | PARTIAL                                                                                                     | Protocol and verify-network source and tests exist. M17 (ChatGPT) depends on account/policy eligibility.                                                                                                                 |
| M25                | BLOCKED_EXTERNAL                                                                                            | Requires a real outside party. None is claimed.                                                                                                                                                                          |

Gate A, B and C: **not closed.**

## 5. Exact next actions

1. Deploy this branch to a preview (after CI is green) and run the Gateway against PayPal Sandbox:
   needs the Sandbox client credentials and a vaulted owner wallet in the hosted environment.
2. Add `/v1/actions/execute` to `openapi/payflow-v1.yaml` and both SDKs; add the credential
   create/revoke flow so the quickstart works end to end.
3. Decide the fate of PR #18 (supersede with this branch) and stale PR #5.
4. External: a design partner or sandbox integrator for M12/M25, and counsel for legal drafts.

## 6. M7 live Sandbox acceptance (2026-11-02)

Evidence file: `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json`. Real hosted preview and
real PayPal Sandbox; not the fake provider.

| Item                  | Value                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                | `540f10f4b4c12ea77ad634b16a9937d9ae217e4a` on PR #19                                                                                                                                                                                                      |
| CI on that exact head | `verify` (PostgreSQL 17), `console`, `console-e2e` all success                                                                                                                                                                                            |
| Deployment            | `dpl_AVaxP54y9TZq5S8vZ27uo3wXJ8eJ`, project `payflow-m6-acceptance`, target **preview** (not promoted), READY                                                                                                                                             |
| Database              | Existing M6 acceptance Neon database. Snapshot branch `br-super-field-b8baqoz2` taken first. Migrations 013–020 applied as one transaction (additive `CREATE` only). M6 evidence unchanged (1 captured, 79 events, 14 mandates, 1 vaulted wallet before). |
| Access                | Digest-only credentials created by the same code, inserted by SQL. No new Vercel secret was created and no existing secret was read. Preview is behind Vercel Authentication; a 23-hour share link was used.                                              |

| Scenario                      | Result                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amount drift / merchant drift | `DENIED`, `effectCount 0`, no new attempt, grant or reservation (verified in the database)                                                                                     |
| Wrong agent / bad credential  | `REJECTED` 403 / 401, `effectCount 0`                                                                                                                                          |
| **ALLOW $84**                 | `COMPLETED`, `effectCount 1`, PayPal Sandbox capture `9M2050175R8521521`, reservation `COMMITTED`; exactly one new payment (attempts, captures, grants and reservations 1 → 2) |
| Replay of that nonce          | `DENIED REPLAY_DETECTED`, no second capture                                                                                                                                    |
| 3 concurrent further requests | all `DENIED` (`CUMULATIVE_LIMIT_EXCEEDED` ×2, one refused as ineligible), no further capture                                                                                   |
| Proof                         | `VERIFIED`, financial outcome `CAPTURED`, 29 stages, references from principal through provider capture                                                                        |
| Revoked credential            | `REJECTED` 401, `effectCount 0`, counts unchanged                                                                                                                              |
| Revoked Authority             | `DENIED AUTHORITY_REVOKED`, `effectCount 0`                                                                                                                                    |

Not exercised live: UNKNOWN (not manufactured), suspended Authority, hosted admin issuance. Those are
covered by the PostgreSQL tests only.

Defect found by the live run and fixed afterwards in source (not redeployed): kernel codes
`CUMULATIVE_LIMIT_EXCEEDED`, `QUANTITY_EXHAUSTED`, `MERCHANT_NOT_ALLOWED`, `MANDATE_EXPIRED`,
`AGENT_SUSPENDED` and an internal `DELEGATED_REQUEST_REFUSED` produced a generic message.

## 7. M8 audit findings (in progress)

- Verify checks signature, audience, challenge, expiry, lifecycle, binding and replay.
- The portable proof verifier (`payflow-proof/v1`) exists, but **nothing issues a signed portable
  proof from an executed Gateway operation**. A separate client therefore cannot yet verify a
  Gateway outcome without the operation trace.
- Both canonicalizers sort keys with `localeCompare`, which is locale-dependent. It should be a
  code-point sort, with a test that proves existing signatures are unchanged.
