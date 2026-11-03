# Discovery Interview Guide

Purpose: learn whether a real team has the problem PayFlow addresses, before pitching. Listen more than present. Do not describe PayFlow as production-ready, certified, or in use by customers (it is not). Say once: "PayFlow is a developer preview, PayPal Sandbox only."

Rules: ask for specific past events, not opinions about the future. Record verbatim quotes. Never lead the interviewee to an answer. Get consent before recording.

## Part A. Problem and control questions

1. What economic actions can your agents perform today (pay, refund, buy, transfer, commit spend)? Which are planned?
2. Where are limits enforced: in the model prompt, application code, the payment provider, a card, or a human step?
3. Can the agent change its own limits, or the configuration that holds them? Who can?
4. How do humans approve an action? What does the approver actually see? How long does it take?
5. What happens when the payment provider returns an unknown, timed-out, or ambiguous outcome? Walk through the last time.
6. How do you prevent the same action being executed twice (retries, replays, duplicate webhooks)? Has it happened?
7. Who owns responsibility when an agent moves money wrongly: engineering, finance, security, the business owner?
8. How do security and finance inspect what agents did? How long to answer "what happened on this payment"?
9. How do you prove, after the fact, that an action was authorized at the moment it ran?
10. What incident would make you disable autonomous execution? Has one nearly occurred?
11. What would a pilot need: environment, data, people, security review, legal terms, timeline?

## Part B. Willingness to pay (ask only after Part A)

1. Would you pay for this? What would have to be true?
2. Which team owns the budget?
3. What budget category would it come from?
4. What do you pay for today as an alternative (tools, headcount, insurance, manual review)?
5. What does one failure cost you (money, time, audit, reputation)?
6. Pricing preference: per volume, per agent, per platform, or per spend governed? Why?
7. What would be a reasonable pilot price, including free?
8. What is your approval process and typical timeline for a purchase of this size?

Interpretation rule: "interesting" is not willingness to pay. Only record a payment signal when the interviewee names a budget owner, a number, or a process step.

## Evidence log template

**The log is EMPTY. No interviews have been held (conversations = 0).** Entries may only be added from real conversations. Do not invent or backfill rows.

| date | interviewee role | company | verbatim quote | interpretation | source type |
| ---- | ---------------- | ------- | -------------- | -------------- | ----------- |
|      |                  |         |                |                |             |

Source type values: interview, call transcript, written reply, public statement, other (explain).
