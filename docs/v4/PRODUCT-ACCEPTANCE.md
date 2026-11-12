# V4 product acceptance

Evidence recorded against the mandate's journeys (§28). A journey is
**ACCEPTED** only where the stated evidence exists. Anything else is named for
what it is.

Commit under test: the branch head at the time of writing. Local verification: `apps/console/out` served
over HTTP and driven with the pre-installed Chromium.

## Evidence that exists

| Check                                                                               | Result                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Root test suite (`npm test`)                                                        | **1407 passed, 0 failed** (1437 skipped: the integration suites that need PostgreSQL, run separately in CI) |
| Console suite (`npm test --prefix apps/console`)                                    | **134 passed, 0 failed**                                                                                    |
| New partner tests (`tests/founder-partner.test.ts`)                                 | **16 passed**                                                                                               |
| New consumer tests (`apps/console/tests/flow-consumer.test.tsx`)                    | **7 passed**                                                                                                |
| `format:check`, `lint`, `typecheck`, `secret:scan`, `orphan:scan`, `evidence:check` | all pass; secret scan clean over 926 tracked files                                                          |
| axe-core, WCAG 2.0/2.1/2.2 A + AA                                                   | **no violations** on `/`, `/try/`, `/try/` mid-journey and `/partner/`, each at 1280px and 320px            |
| Horizontal overflow at 320px                                                        | **0px** on every new route                                                                                  |
| Browser console errors / page errors                                                | **none**                                                                                                    |
| Static export build                                                                 | succeeds; `/partner` and `/try` generated                                                                   |

## Journeys

| #   | Journey                                                    | Status                                         | Evidence, or what is missing                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | First visitor understands the product                      | **ACCEPTED**                                   | `/` leads with "Make it happen" and a plain-language explanation. A test asserts the homepage contains none of: Authority, Gateway, MCP, A2A, SDK, bootstrap, tenant, Trust Kernel, execution boundary.                                      |
| J2  | First founder turns a goal into a plan                     | **ACCEPTED (local), WAITING_PROVIDER (live)**  | The whole path is built and the governing code is covered by 16 tests with an injected model. The real Groq call can only run in production — see blocker E-6.                                                                               |
| J9  | Financial safety: an unauthorized action is refused safely | **ACCEPTED in principle, SIMULATED in the UI** | The Trust Kernel's refusal behaviour is covered by the pre-existing integration suites. `/try/` _shows_ a refusal, and says it is simulated. The public app cannot execute payments at all, so there is no live refusal to demonstrate here. |
| J11 | Mobile founder                                             | **ACCEPTED**                                   | Every new route driven at 320px: no overflow, no axe violations, navigation fits on one line, touch targets ≥44px.                                                                                                                           |
| J12 | Judge experience                                           | **ACCEPTED**                                   | `/try/` needs no account, code or key; a test asserts the markup contains no sign-in, sign-up, access-code or API-key prompt. Deterministic and resettable. Labelled a simulation in a banner on every step and by a chip in the hero.       |
| J3  | Shopping to a verified purchase                            | **NOT DELIVERED**                              | Channel3 discovery is not wired to the public app, and purchase execution is on the isolated host. Simulated in `/try/` only.                                                                                                                |
| J4  | Talent                                                     | **NOT DELIVERED**                              | Blocker E-3. Deliberately not built on fixtures.                                                                                                                                                                                             |
| J5  | Invoicing                                                  | **NOT DELIVERED**                              | No PayPal Invoicing integration exists in the codebase.                                                                                                                                                                                      |
| J6  | Travel                                                     | **NOT DELIVERED**                              | Blocker E-4.                                                                                                                                                                                                                                 |
| J7  | Founder launch orchestration                               | **NOT DELIVERED**                              | `plan-run-service` remains coordination-only; see the audit, C14–C15.                                                                                                                                                                        |
| J8  | Customer growth                                            | **NOT DELIVERED**                              | Blocker E-5.                                                                                                                                                                                                                                 |
| J10 | Returning founder resumes durable work                     | **NOT DELIVERED**                              | There is no account and no persistence on the public app. `/partner/` state lives in the page and says so.                                                                                                                                   |

## The honest summary

Five of twelve journeys are accepted and two are partial. Five are not
delivered, and three of those are blocked on provider access that no amount of
engineering here would produce.

Two defects were found by looking at the rendered pages rather than by a test,
and both were honesty defects rather than layout ones: the product card's copy
referred to a "highlighted row" and to "sellers marked here" when nothing on
screen was marked. A claim in the copy now corresponds to a mark on the
screen. The keyboard gate caught a third: the new routes' skip link pointed at
`#flow-main` while every check and every other surface expects `#main`.

What changed is the foundation the rest depends on: the public app now has a
face a founder can read and a backend that can run code. Before this commit,
neither existed.
