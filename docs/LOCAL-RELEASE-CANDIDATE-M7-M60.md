# Local release candidate — M7–M60

Everything below was run **locally**; nothing was deployed.

| Item              | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Branch            | `m7-m60-master-execution` (mirrored to `ccr-6da356b5-4drem0`)                            |
| Base              | unmerged M6 head `9f1aca9`; `main` = `880a890`                                           |
| Code SHA verified | `7020f9a` (docs-only commit follows it; code identical)                                  |
| Environment       | Linux, Node 22, PostgreSQL 16 (local), Playwright Chromium 1243 (preinstalled), Python 3 |

## Gate results

| Gate                                                                                      | Result                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prettier --check .`                                                                      | pass                                                                                                                                                 |
| `eslint .` (root) / console `eslint`                                                      | pass / pass                                                                                                                                          |
| `tsc --noEmit` (root) / console `typecheck`                                               | pass / pass                                                                                                                                          |
| `npm run secret:scan`                                                                     | pass, 384 tracked files, 0 findings                                                                                                                  |
| `npm run evidence:check`                                                                  | pass, 6 artifacts byte-identical                                                                                                                     |
| `npm test` (with PostgreSQL)                                                              | 1878 passed, 3 skipped (live-provider smoke tests: PayPal Sandbox ×2, Groq)                                                                          |
| `npm run test:integration` (fresh DB, migrations 001–019)                                 | 823/823 on two consecutive runs; **one earlier run showed 1 failure that did not reproduce and was not diagnosed** — treat as an open flake to watch |
| `npm run test:coverage`                                                                   | green; lines 92.66%, branches 87.07%, functions 90.87%                                                                                               |
| Python SDK `unittest`                                                                     | 4/4                                                                                                                                                  |
| Console unit tests                                                                        | 97/97                                                                                                                                                |
| Console browser E2E (Chromium: desktop, 375 px, 768 px, a11y, CSRF, double-submit)        | 19/19                                                                                                                                                |
| Console static build + serve of all 9 routes                                              | HTTP 200 on all                                                                                                                                      |
| `npm audit --omit=dev --audit-level=high`                                                 | 0 vulnerabilities                                                                                                                                    |
| Full `npm audit` (dev)                                                                    | moderate advisories in vitest/vite tooling (pre-existing; dev-only; fix is a breaking vitest major) — not shipped code                               |
| Clean-clone `npm ci` → format, lint, typecheck, secret scan, evidence check, tests, build | pass (DB tests skipped there; run separately above)                                                                                                  |
| Break Authority (fake rail)                                                               | integrated 100 and 1000: 0 uncontained; kernel 1000: 0 unauthorized allows; fault matrix 41/41; conformance 7/7                                      |

## Not run / not claimed

- No Vercel deployment (count 0; cost $0.00). A Vercel API check shows no deployment exists for this branch, so preview auto-deploy is still off.
- No live PayPal Sandbox (M6 acceptance still open), no second real rail, no real LLM runs, no independent audit.
- Hosted-environment E2E (`test:hosted`) not run: it needs a deployment.

## Known issues / watch list

1. The one unexplained transient integration failure above.
2. `main`'s `ci.yml` job names are unchanged; the remote CI result for this head should be read on PR #18 (check runs were not yet reported when this was written).
3. The M60 and federation demonstrators use deterministic fake rails and locally generated keys by design.

## Vercel recommendation

**Do not deploy.** Nothing in M7–M60 needs a hosted environment to be validated; a single consolidated deploy should wait until M6 acceptance closes and the owner wants a hosted demo.
