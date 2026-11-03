# CRM Schema

Template file: `crm-template.csv`. It lists the 20 prospects from PROSPECTS.md at stage RESEARCHED. Contact and response columns are intentionally blank: no outreach has occurred. Never fill a column with an inferred value; write `unverified`.

## Fields

| Field                   | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| account                 | Company name                                                      |
| contact_role            | Role type only until a person is publicly sourced and has engaged |
| source                  | Where this lead came from (URL or event)                          |
| website                 | Company site                                                      |
| agent_use_case          | The agent and economic action in question; mark hypotheses        |
| existing_payment_system | Their payment/rail stack, or `unverified`                         |
| pain                    | Pain in the contact's words if possible, else blank               |
| urgency                 | Stated urgency (none/low/med/high) only from contact statements   |
| economic_exposure       | Money at risk per failure, from interview only                    |
| objections              | Verbatim or paraphrased objections with date                      |
| stage                   | See below                                                         |
| last_contact            | ISO date of last real two-way or outbound contact                 |
| next_action             | One concrete step with date                                       |
| response                | Summary of reply; blank if none                                   |
| outcome                 | Final result (pilot, lost reason, nurture reason)                 |

## Stages

| Stage          | Entry criteria                                                          | Exit criteria                                                  |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| TARGET         | Company plausibly fits an ICP segment                                   | Public evidence of agent/economic use case recorded            |
| RESEARCHED     | Evidence URL opened and logged; use case hypothesis written             | First outreach approved by a human and sent                    |
| CONTACTED      | One approved message sent; date logged                                  | Reply received, or no reply after one follow-up (then NURTURE) |
| REPLIED        | Contact answered                                                        | Discovery call scheduled, or contact declines (LOST/NURTURE)   |
| DISCOVERY      | A discovery conversation held and logged in the evidence log            | Pain and economic exposure confirmed or refuted                |
| TECHNICAL      | Contact's engineer evaluates sandbox/SDK                                | Evaluation findings recorded; go/no-go                         |
| PILOT_PROPOSED | Written pilot scope sent (PILOT-PACK.md)                                | Signed or explicit written agreement, or decline               |
| PILOT          | Agreement in place and sandbox workspace provisioned                    | Pilot ends with outcome recorded                               |
| WON            | Written agreement to continue past the pilot, with the outcome recorded | Terminal; record what was agreed and what evidence supports it |
| LOST           | Explicit decline or fit refuted                                         | Terminal; record reason                                        |
| NURTURE        | No reply after one follow-up, or "not now"                              | Re-engage on a stated trigger date or inbound interest         |

Rules: do not skip stages. Stages move only on logged evidence. Opt-out requests move the account to LOST immediately with reason `opted out`, and no further contact.
