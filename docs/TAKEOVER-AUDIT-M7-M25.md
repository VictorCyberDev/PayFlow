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

## 7. M8 independent Verify — audit and work (source-level; not yet deployed)

Fresh line-by-line audit of `src/network/verify.ts`, `packages/verifier`, `packages/merchant-sdk`:

| M8 requirement                                                                    | Finding                                                                                                                     | Action                                                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify signature, challenge, audience, issuer, expiry, revocation, tamper, replay | Present in `verifyAuthorityPresentation` (Ed25519; verdicts VALID/INVALID/EXPIRED/REVOKED/WRONG_AUDIENCE/TAMPERED/REPLAYED) | Preserved                                                                                                                                       |
| Read-only security                                                                | Verifier package imports only `node:crypto`, `zod`, `node:fs/promises`                                                      | Now enforced by a test that fails on any payment, database or network import                                                                    |
| Evidence a separate client can verify                                             | **Gap.** `payflow-proof/v1` existed but nothing issued one from an executed Gateway operation                               | `PortableProofIssuer` signs it from the existing verified trace; `GET /v1/proofs/{id}/portable`, `GET /v1/keys`                                 |
| CLI                                                                               | **Defect.** Rejected any proof older than 24 h as `STALE_PROOF`, so last week's payment looked invalid                      | Historical evidence verifies by authenticity; freshness is opt-in `--max-age`; future-dated proofs always refused                               |
| Canonical bytes                                                                   | **Hazard.** Key sort used locale-dependent `localeCompare`                                                                  | Portable proof and presentation moved to code-point order; a test pins identical order for their exact key sets so no existing signature breaks |
| UNKNOWN                                                                           | —                                                                                                                           | Signed as `UNKNOWN` with `effectCount: null`; rewriting it to success fails verification                                                        |

Deliberately **not** changed: the `localeCompare` canonicalizers in `execution-grant.ts`, `evidence.ts`,
`canonical.ts`, `persistence.ts`, `trust-trace.ts` and others. They protect historical signed and
hash-chained M6 evidence. They are listed as a known cross-implementation hazard (ASCII keys make
them deterministic in practice).

Evidence: `tests/m8-portable-proof.integration.test.ts` runs the CLI in a **separate process with no
database and no PayFlow environment** against a proof fetched over real HTTP from the hosted
composition: valid, four tamper cases, wrong key, historical vs `--max-age`, UNKNOWN, scope and
ownership, public-key endpoint exposes no private material.

Remaining for M8: merchant-facing simple result is in `packages/merchant-sdk` (not re-audited here
beyond import hygiene); a **public** hosted verify endpoint and abuse controls (M21) are not built;
the new routes are not yet deployed.

## 8. M9 Break Authority — audit and work (source-level; not yet deployed)

| M9 requirement                                             | Finding                                                                                                                                                                                                            | Action                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve the adversarial suite                             | 1,000 integrated scenarios (16 families), 1,000 kernel-only, 41 fault injections, 7 conformance, 14 tool-selection; all committed and byte-verified in CI                                                          | Preserved unchanged                                                                                                                                                                      |
| Exact tested scope in the headline                         | **The mandate's wording would overstate.** The 1,000 integrated scenarios are parameterised variants of 16 attack families and produce only **38 distinct containment outcomes**; the rail is a deterministic fake | Headline is "1,000 adversarial scenarios. 0 uncontained." with the scope line beside it, and the family and outcome counts stated in the first paragraph                                 |
| Methodology, categories, evidence                          | Existing page was three paragraphs                                                                                                                                                                                 | `/research/break-authority/`: outcome first, Gate illustration, per-family table, other suites with their own limits, "what this does not show", reproduction                            |
| Exact release binding                                      | Cannot embed a commit SHA in a file committed in that commit                                                                                                                                                       | Binding is by SHA-256 of each report, generated into `docs/evidence/break-authority-summary.json` and verified byte-for-byte by `evidence:check`; the page reads those generated numbers |
| Reproducibility                                            | `npm run evidence:check`                                                                                                                                                                                           | Documented on the page                                                                                                                                                                   |
| Visual demo ($184 vs $100 Authority, Gate stops, $0 moved) | Existing interactive `GateExample`                                                                                                                                                                                 | Reused; labelled as an illustration                                                                                                                                                      |
| Real AI demo                                               | **Not done.** The model key exists only inside the hosted environment, which this session must not read; no model call has been made. Nothing is faked                                                             | The page and summary state `realModelRun: false` and "no live model was run"                                                                                                             |
| Security page / Trust Center                               | Exists in the content model; not re-audited this pass                                                                                                                                                              | Open                                                                                                                                                                                     |

Browser acceptance of the new page: no horizontal overflow at 320, 375, 768 and 1440 px (a real
overflow at 320/375 from unwrappable digests and the table was found and fixed); table headers intact;
state not conveyed by colour alone. Console tests (105) assert that the page shows the generated numbers,
states its limits, makes no overclaim (no "certified", "unbreakable", "guarantee"), and that the console's
copy of the summary equals the CI-verified file.

Pre-existing guard honoured: the console's boundary test forbids `process.env` in the browser graph, so
the page does not read a build commit from the environment.

## Gate A release-candidate deployment (2026-11-03)

| Item                | Value                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source              | `cd5c427e9461348e08808298eff4826917aac0eb`, exact-head CI green (verify / console / console-e2e)                                                                                                                      |
| Deployment          | `dpl_8MShVQRKcTrZD4m9Fg3DrSmLYx3e`, Vercel preview, project `payflow-m6-acceptance`, READY, Vercel Authentication was found OFF on 2026-11-03 and switched ON (see the closure record)                                |
| Database            | additive migrations 021 and 022 applied after a snapshot; M6 evidence intact                                                                                                                                          |
| Live check done     | Real PayPal Sandbox proof fetched through `GET /v1/proofs/{id}/portable` with a one-use read-only credential (revoked afterwards) and verified offline by the CLI in a separate process: YES. Tampered copy: rejected |
| Live check NOT done | `POST /v1/sandbox/start` (flag `PAYFLOW_PUBLIC_SANDBOX` not set: the only available scope was every preview of the project that holds accepted evidence); width/keyboard review of the deployed site                  |
| Site pages          | `/verify/` and `/status/` served 200 from the preview                                                                                                                                                                 |
| Known issue         | `console-e2e` M6 hero test has failed once in about six CI runs without a root cause; it passed on re-run. Not explained, not hidden                                                                                  |
| Known issue         | Canonical/OG URLs on the site point to `payflow-one-kappa.vercel.app`, not to the preview host                                                                                                                        |

## M8–M15 closure record (2026-11-03)

The authoritative final SHA, CI run and merge SHA are in the PR #19 description and its merge commit; a file committed in a commit cannot
name that commit. Facts below were gathered at the commits shown.

| Item                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / PR           | `claude/eloquent-einstein-dw0mxk` / PR #19 into `main` (`3b1b263`). PR #18's head is an ancestor of this branch. ADR-017 from draft PR #17 is preserved in `docs/`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Migrations            | `001`–`023`, additive. Accepted database: `021`, `022` applied (after snapshot `br-lucky-star-b8a87fk4`); `023` and the three NOLOGIN roles applied 2026-11-03 after snapshot `br-shy-fire-b86qozvq` and a rehearsal on `br-morning-pond-b8kh9ukx`; evidence counts identical before and after (`docs/evidence/ops/db-commissioning-2026-11-03.json`).                                                                                                                                                                                                                  |
| Accepted evidence     | M6/M7: 2 captured payments, 120 evidence events, 16 mandates, unchanged before and after the rehearsal; the accepted branch was only read.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Deployments           | One preview this cycle, `dpl_8MShVQRKcTrZD4m9Fg3DrSmLYx3e` (`cd5c427`). Nothing after it is deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Live proof            | Real PayPal Sandbox Proof (capture `9M2050175R8521521`) fetched from the preview and verified offline in a separate process; tamper rejected.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Site reachability     | Measured: `payflow-one-kappa.vercel.app` returns 404 to an anonymous client on every path (Vercel Authentication, `all_except_custom_domains`). It also still serves the M6 build. No public host exists.                                                                                                                                                                                                                                                                                                                                                               |
| New tests this cycle  | `m13-rbac` (13), `m14-ops` (20), journey runner (1), funnel measures, accessibility acceptance (44 routes × 6 widths = 264 checks). The RBAC oracle was mutation-checked: granting VIEWER one extra permission made two tests fail.                                                                                                                                                                                                                                                                                                                                     |
| Defects found by them | (1) signing-key rotation without a new key id would publish the old public key while signing with the new one; fixed, fails closed. (2) `/v1/keys` hung on a registry refusal; fixed. (3) keyboard-unreachable scrolling table on `/enterprise/`; fixed. (4) CI runner `ubuntu-latest` → 26.04 broke Playwright; pinned to `ubuntu-24.04`.                                                                                                                                                                                                                              |
| Correction            | M13 was previously labelled `COMPLETE_LOCAL` while a single shared admin secret was the only control. That label was wrong then; it is true now (see `tests/m13-rbac.integration.test.ts`).                                                                                                                                                                                                                                                                                                                                                                             |
| Known defects         | `console-e2e` M6 hero flake (~1 in 6 earlier runs, no root cause, passed on re-run). One hosted-gateway test took 17.7 s once under local CPU contention and passes in ~1 s alone (3 of 3). `PayPalExecutionRail.reconcile` six-hour same-request-id resubmission window (M6, accepted, documented).                                                                                                                                                                                                                                                                    |
| Owner-gated           | Public host on an isolated database + env secrets + Vercel Authentication off; a real monitored security contact; a `payflow_runtime` login with a password and the `DATABASE_URL` swap (the deployed app still connects as the schema owner); a scheduler trigger and an alert delivery channel. See `docs/GATE-A-PUBLIC-HOST.md`.                                                                                                                                                                                                                                     |
| External              | Design-partner conversations (0), willingness-to-pay (0), counsel review, a stranger's timed run, independent reproduction, any audit or certification.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Correction            | Correction 2026-11-03: earlier records called this preview "protected". That was not re-verified. When checked, the project's Vercel Authentication setting was OFF and an anonymous request returned 200. The admin plane was disabled on that deployment (404) and the self-serve sandbox was off, so what was reachable was the static site, the public key document, and credentialed routes that refuse anonymous callers. Vercel Authentication was turned ON for the whole project (`all`) the same day and an anonymous request now gets a 302 to Vercel login. |
| Isolated public DB    | Created: Neon project `withered-rice-68056451`, branch `br-steep-glade-bdsyx5v5`, PostgreSQL 17.11, empty of data. Migrations 001–023 and the three NOLOGIN roles applied; schema fingerprint (md5 of table, column and type) identical to the accepted database (`82498c06eefce00974061e000d349f29`; 73 tables, 598 columns, 22 triggers; 438 non-NOT-NULL constraints on both). A runtime `DROP TABLE` is refused. No Vercel project, env var or deployment points at it yet.                                                                                         |
| Observation           | The accepted database runs PostgreSQL 18.6; CI and the new database run 17. Not a defect found, but production data has not been exercised by the 17-based test suite.                                                                                                                                                                                                                                                                                                                                                                                                  |
