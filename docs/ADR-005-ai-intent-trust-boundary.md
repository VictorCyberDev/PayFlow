# ADR-005: Untrusted intent and deterministic mandate drafts (Milestone 3A)

## Decision

The AI interprets your intention. It does not grant itself permission.

3A defines an interpretation contract and a pure deterministic compiler. It does
not connect an LLM, interpret source language itself, authenticate humans, persist
confirmation, issue a trusted mandate, authorize a proposal, issue grants or call
PayPal. M1/M2 execution and database semantics are unchanged.

The future flow is source intake -> untrusted interpretation -> compileIntentDraft
-> human review -> separately authenticated confirmation -> existing mandate,
proposal and execution boundary. No confirm/activate operation is exported in 3A.
A future confirmMandateDraft operation must bind the exact reviewed fingerprint,
trusted principal/agent, current policy and time, revalidate the draft and satisfy
all activation requirements. A model-provided approval boolean is never sufficient.

## Interpretation contract

IntentInterpretationSchema is strict at every structured level. Its version is
payflow.intent.v1. It contains a source reference, item, category, decimal maximum
and inclusive/exclusive bound, currency, conditions, merchant scope, quantity,
autonomous-purchase permission, additional-confirmation requirement, expiry and
capabilities. Every constraint has one of four explicit discriminants:

- EXPLICIT: a proposed value and exact quoted source spans;
- PROPOSED: an inferred candidate and short user-facing explanation;
- MISSING: no value, with a reason;
- AMBIGUOUS: candidate values and a reason.

EXPLICIT is an untrusted model assertion, not a verified grant. Confidence scores,
unknown fields, hidden reasoning, instructions to override policy, principal IDs,
execution grants and activation fields are not accepted by this contract.
Assumptions, ambiguities and unsupported constraints have separate structured lists.

compileIntentDraft accepts unknown interpretation and a separately supplied strict
context: authoritative source text/reference, trusted current UTC time and
independent structured reviewBounds. Review bounds must come from trusted intake
or human controls, not be copied from the model. They restrict a draft but are not
an authorization credential. No field is defaulted to financial permission.

## Compilation and widening

Results are VALID_DRAFT, NEEDS_CLARIFICATION or REJECTED, never ALLOW/DENY/ESCALATE.
All constraints must be explicit for a valid draft. Proposed/missing/ambiguous
constraints, assumptions and unresolved ambiguity produce clarification with no
draft. Unsupported constraints, malformed payloads, forged spans and unknown
security fields fail closed. Known but out-of-scope capabilities (refund,
subscription, dispute) are rejected. Autonomous purchase needs create and capture;
capture alone is incompatible. Contradictory confirmation instructions are rejected.

Money is an ASCII decimal string, converted by BigInt into positive safe integer
minor units for USD/EUR/GBP/AUD/CAD/JPY. Negative, zero, fractional-JPY, excessive
precision, scientific notation, separators, confusable digits and overflow fail.
An exclusive maximum subtracts one minor unit; an empty result is rejected.
The proposed cumulative budget is conservatively bounded by the same maximum,
never multiplied by quantity. No trusted monetary value uses fractional Number
arithmetic. Expiry must be a valid future canonical UTC millisecond instant;
invalid calendar dates are rejected rather than normalized into future dates.

Independent bounds prohibit larger budgets/quantities, currency substitution,
condition/merchant expansion, capability escalation, later expiry, autonomous
permission expansion and removal of required confirmation. Removing a condition
or currency instead produces clarification. Source text is inert data, so prompt
injection cannot change these checks or export financial privileges.

An exact quote proves provenance, NOT semantic faithfulness. A model can lie about
what a genuine span means, omit a source restriction or label an inference as
explicit. 3A cannot semantically prove arbitrary natural language. Without
independent structured bounds, such a lie can reach an UNTRUSTED_MANDATE_DRAFT;
a human must review it against the preserved source before any authority exists.
This limitation is explicit in executable tests, not hidden behind confidence.

## Draft and activation separation

MandateDraft has kind UNTRUSTED_MANDATE_DRAFT, humanConfirmationRequired=true,
canonical display constraints, proposedMandateTerms and activationRequirements.
It lacks trusted identity, mandate ID/nonce, risk policy and activation credentials;
both the draft and its term projection fail the existing MandateSchema.

Conditions, limits, thresholds, capabilities, purpose/category and expiry map to
existing mandate terms. Non-autonomous purchase sets the proposed autonomous
threshold to zero, preserving the existing human ESCALATE path. Draft confirmation
is distinct from transaction-level approval and remains required even if the user
proposes autonomous purchases after activation.

M2 has no quantity or merchant-allowlist enforcement. Drafts preserve both instead
of dropping them. QUANTITY_ENFORCEMENT is always an activation requirement;
MERCHANT_ALLOWLIST_ENFORCEMENT is additionally required for restricted merchants.
No caller may activate these drafts by simply copying the term projection into a
mandate. Resolving unsupported enforcement belongs to separately reviewed future
work; 3A does not modify the kernel or pretend these restrictions are enforced.

## Provenance, normalization and fingerprint

The compiler validates reference equality and exact UTF-16 start/end/quote spans
against independently supplied source text. Output preserves the original source,
validated interpretation and explicit deterministic-normalization records. Text
uses trimmed NFC form; security enums/IDs do not use confusable folding. Sets are
sorted/deduplicated and timestamps canonicalized. Deep copies are frozen so later
caller mutation cannot alter the draft.

SHA-256 covers canonical draft content INCLUDING structured provenance. Object-key
ordering is stable; changing source or interpretation changes the fingerprint,
even if proposed financial terms remain equivalent. The fingerprint is a review
binding, not a signature or authorization credential. Eventual confirmation must
record exactly the reviewed version and fingerprint; no such record exists yet.

The compiler neither logs nor persists source, interpretation or secrets. No
chain-of-thought is requested or stored. Explanation fields are bounded,
user-facing structured summaries only. Future intake/persistence must apply
appropriate data minimization and secret redaction; arbitrary source text can
contain sensitive information and must not be automatically copied into evidence.

## Remaining scope

3B/3C still require separately reviewed model integration, semantic fidelity and
clarification workflows, authenticated human confirmation, any quantity/merchant
enforcement gap and safe provenance persistence. Product discovery, Channel3,
autonomous shopping, final UI, live PayPal and other financial rails are absent.
M2's revocation handoff, UNKNOWN quarantine, provider idempotency dependency and
transactional finalization continue unchanged; no exactly-once claim is added.
