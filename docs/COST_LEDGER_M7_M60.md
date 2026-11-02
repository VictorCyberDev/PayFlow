# M7–M60 Cost Ledger

This ledger covers work performed on `m7-m60-master-execution`.

| Resource                   |                                  Usage in this execution | Cost posture                                                   |
| -------------------------- | -------------------------------------------------------: | -------------------------------------------------------------- |
| Vercel remote deployments  |                                                        0 | $0.00 incremental spend                                        |
| Vercel preview deployments | Disabled for the PayFlow project before M7 branch pushes | Prevented accidental preview spend                             |
| GitHub repository APIs     |                                  Used for source control | Existing/free account capability; no new paid resource created |
| Web documentation research |          Used for current public protocol specifications | No paid API/resource created by PayFlow                        |
| Payment providers          |                                 0 live financial effects | No money moved                                                 |
| Paid LLM/API testing       |                                                        0 | Not used                                                       |

## Session 2 (verification and depth work)

| Resource                                                      | Usage                                                  | Cost posture                                                |
| ------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Vercel remote deployments                                     | 0 (no deploy, no preview created, no Vercel API write) | $0.00                                                       |
| Local PostgreSQL 16, Node, Chromium (preinstalled Playwright) | all tests, migrations, browser E2E                     | free/local                                                  |
| npm registry                                                  | `yaml`, `ajv`, `ajv-formats` (dev-only, MIT/BSD)       | free                                                        |
| GitHub Actions                                                | CI runs on the draft PR for pushes to this branch      | within the repository's existing plan; no new paid resource |
| Paid LLM/API                                                  | 0                                                      | not used                                                    |

## Cost uncertainty

No Vercel deployment has been initiated during this execution. No paid external resource has been created. The target remains **Vercel incremental spend: $0.00**.
