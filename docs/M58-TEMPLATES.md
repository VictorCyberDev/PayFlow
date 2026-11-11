# M58 — the five templates, each proven to lead to a working mission

Status: IMPLEMENTED, WIRED, DB_ACCEPTED (PostgreSQL integration tests). **Not** PROVIDER_ACCEPTED and not HOSTED_ACCEPTED.

ADR-018's M58 is short: preserve the five existing templates and ensure each leads to a functioning supported mission. The five were preserved. The second half was not true, and nothing was checking it.

## The defect this found

The deterministic planner (`templatePlan`) branched on only two provider families:

```
COMMERCE_MARKETPLACE / DIRECT_SUPPLIER  ->  source-offers  ->  compare-offers
TALENT_MARKETPLACE                      ->  source-talent
```

Three of the five templates approve neither:

| Template                    | Approved providers      | Plan it produced                          |
| --------------------------- | ----------------------- | ----------------------------------------- |
| Find a place to work        | `WORKSPACE_PROVIDER`    | `clarify-requirements` → `owner-decision` |
| Get a logo and brand basics | `PROFESSIONAL_SERVICES` | `clarify-requirements` → `owner-decision` |
| Set up bookkeeping          | `PROFESSIONAL_SERVICES` | `clarify-requirements` → `owner-decision` |
| Equip the team              | `COMMERCE_MARKETPLACE`  | full                                      |
| Hire a freelancer           | `TALENT_MARKETPLACE`    | full                                      |

So for three of the five, the plan went straight from "write down the requirements" to a task titled **"Owner reviews the shortlist and decides what to commit to"** — and nothing in the plan had been planned to produce a shortlist. The owner was asked to decide on work the planner had silently declined to plan. Nothing failed, nothing warned; the plan was simply missing its middle.

## The fix

PayFlow already has the discovery for both families — M51 workspace discovery and M54 service packages — so the planner now plans it:

| Approved provider       | Tasks added                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `WORKSPACE_PROVIDER`    | `find-workspaces` → `compare-workspaces` ("a monthly rate is not the cost: the deposit and the minimum term are part of it") |
| `PROFESSIONAL_SERVICES` | `find-services` → `compare-services` ("two packages at the same price can deliver very different things")                    |

`owner-decision` now waits on whichever comparisons exist, instead of falling back to `clarify-requirements` whenever it recognised nothing. The change is additive: a contract that approves only a commerce marketplace produces the same four tasks it did before, which is why the existing M27 and M55 suites are unchanged.

Each new discovery task is honestly classified. With no provider commissioned they are `PREPARED_HANDOFF` with `NO_CONNECTOR_COMMISSIONED`, exactly as `source-offers` already was — the planner plans the work and does not pretend it can be done unattended.

## How the templates are now held to it

`tests/m58-templates.integration.test.ts` generates one test **per template**, driving each through the real Gateway: the contract the wizard would build → mission accepted → template plan → assertions that the plan contains at least one discovery task and that `owner-decision` waits on something that was actually planned.

The templates are typed data in the test, and the first test checks that copy against the shipped `app-ui/app.js` field by field — key, pack, objective, outcome, budget, per-purchase limit, approval threshold, category, provider types — and asserts the file ships exactly five. A template changed in the app and not here fails loudly, rather than leaving the suite quietly testing something nobody ships. A sixth template added to the app fails too, instead of going untested.

Evaluating the array out of the source was tried first and rejected: `new Function` on repository source is its own hazard, and the lint rule that forbids it is right.

## Evidence

Run with the planner suites it could have disturbed — `m27-mission-planning` and `m55-plan-run`:

- five per-template tests, the drift guard, and one end-to-end run
- the three previously-broken templates now plan discovery; the two that already worked are unchanged

The end-to-end test takes the workspace template — the one that used to plan nothing — gives it an agent holding the needed capabilities, and drives it through a plan run: the plan is exactly `clarify-requirements`, `find-workspaces`, `compare-workspaces`, `owner-decision`; `find-workspaces` is `PREPARED_HANDOFF` for want of a provider; the run advances what it can, leaves a worklist, and `mission_ledger_items` is unchanged.

## Still not done

- A template cannot yet start a plan run in one step; the owner creates the mission, then plans, then runs. Each is a real control.
- The amounts in every template remain starting points, not estimates. No template consults any provider for a price, and none can until a provider is commissioned (blocker B-5).
