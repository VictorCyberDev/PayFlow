# V4 release state

| Field                 | Value                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Branch                | `claude/busy-fermat-xsieoy`                                                                                                 |
| Head                  | `96ab0fa` (plus this ledger commit)                                                                                         |
| Base                  | `main` @ `fcad674`                                                                                                          |
| CI on exact head      | **WAITING_CI** — the workflow runs on `pull_request` and on four legacy branch names, so a pull request is what triggers it |
| Production deployment | **NOT PERFORMED**                                                                                                           |

## Gates (§35)

| Gate                   | Verdict                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Product            | **PASS.** Homepage is consumer-first, the demo needs no setup, the assistant is wired to a real endpoint. No onboarding or account, which Gate A also asks for: see D3.                                                                                                                   |
| B — Integration        | **PASS with a stated limit.** The one implemented connector on this host (Groq) is contract-tested against an injected model; it has not been exercised live from this deployment (E-6). No provider is presented as commissioned.                                                        |
| C — Financial safety   | **PASS.** The Trust Kernel is untouched and its suites are green. The public app cannot move money; PayPal credentials on it remain inert. `/api/partner` creates no authority — the plan carries `authorization: "NONE"` and a test asserts the browser refuses any reply that does not. |
| D — Database           | **PASS, trivially.** No migration, no schema change, no data touched.                                                                                                                                                                                                                     |
| E — Security           | **PASS.** Secret scan clean over 926 files. The model key is read only inside the function. The endpoint is same-origin, body-bounded and rate limited — and the limiter's per-instance, best-effort nature is documented in the source rather than overstated.                           |
| F — Experience         | **PASS.** axe clean, 320px clean, reduced-motion honoured, visible focus, all states reach assistive technology as words.                                                                                                                                                                 |
| G — CI and integration | **NOT MET.** Needs a pull request to run CI on the exact head.                                                                                                                                                                                                                            |
| H — Operations         | **NOT MET.** Rollback is the previous Vercel deployment, which is fine, but the production deploy itself is the owner's decision.                                                                                                                                                         |

## What the owner has to decide

1. **Merge.** CI must be green on the exact head first.
2. **Deployment protection (E-1).** `payflow-public` is set to `ssoProtection: all`, so _every_ address including `payflow-public.vercel.app` answers 302 to a Vercel login. Until that is changed, no judge, founder or customer can open this work. The sibling `payflow` project uses `all_except_custom_domains`, which is why `payflow-one-kappa.vercel.app` serves anonymously. This is a one-field settings change and it makes a site public, so it was not made here.
3. **Which project is the product.** Two projects build this repository. `site.ts` currently points canonical metadata at `payflow-one-kappa.vercel.app`. That should be settled before anything is marketed.
