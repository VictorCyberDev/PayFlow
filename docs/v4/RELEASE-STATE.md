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
3. **Which project is the product.** Two projects build this repository, and they do **not** build the same thing:

   - `payflow` builds from the repository root, uses the root `vercel.json`, and serves `payflow-one-kappa.vercel.app` — the address the public can actually open, and the one `site.ts` already names as canonical. **The V4 work lands here.**
   - `payflow-public` builds from `hosting/m6`. That config rewrites `/api/(.*)` to the M6 acceptance host, so no root-level function can ever be reached on it, and that host currently answers `503 UNAVAILABLE` because its own configuration is missing.

   So "deploy to `payflow-public`" and "ship the product" are not the same action. This should be settled before anything is marketed.

---

## Post-release acceptance, run against the live public origin

`https://payflow-one-kappa.vercel.app`, 2026-11-12, after `fe61619` went live.

| Check                                                       | Result                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`, `/try/`, `/partner/`, `/explore/`                      | all **200**                                                                                                                                                      |
| Homepage headline and the "What is real here today" section | present                                                                                                                                                          |
| `/try/` simulation banner                                   | present                                                                                                                                                          |
| CSP on the live origin                                      | carries `img-src 'self' data: https:`, `connect-src 'self'` and `referrer-policy: no-referrer`                                                                   |
| `POST /api/partner`                                         | **200 PLANNED** — a real plan from the production Groq key, carrying `authorization: "NONE"` and the "has not bought, booked, hired, sent or paid" disclosure    |
| `POST /api/explore`                                         | **200 FOUND** — real catalogue products from the production Channel3 key, `evidence: "PROVIDER_OBSERVED"`, delivery and tax named as excluded                    |
| `POST` with a foreign `Origin`                              | **403**                                                                                                                                                          |
| **Total**                                                   | **15 checks, 0 failures**                                                                                                                                        |
| Gate A against the **deployed** site (`A11Y_ORIGIN=...`)    | **48 routes x 6 widths = 288 page checks, 0 failures** (evidence: `docs/evidence/public/a11y-deployed.json`)                                                     |
| Real browser journey on the live site                       | A founder's goal typed into `/partner/` returned a four-workstream plan, each marked _Needs you_, a re-derived total, and the "Nothing has been done" disclosure |

### One defect this found, and the fix

Driving the live site turned up something no test had: the **identical** goal
planned on one attempt and failed on the next with "PayFlow could not plan that
one". Two causes, both now fixed:

1. The default model reasons before it answers and reasoning tokens come out of
   `max_completion_tokens`, so a 1,200-token ceiling truncated the JSON
   mid-object and the provider rejected its own output. The ceiling is now
   4,000; the answer stays bounded by `outputBytes` and by the schema.
2. A provider `400` was being read as "it refused you". It is also what the
   provider returns when the model's generation failed validation — a
   transient fault on an identical request. Telling a founder to reword a
   perfectly good goal would be wrong, so the two are now distinguished by the
   provider's own error code, failing closed on anything unrecognised.
