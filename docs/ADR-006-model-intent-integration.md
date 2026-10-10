# ADR-006: Groq interpretation outside the financial trust boundary (3B)

## Decision and provider verification

The AI interprets your intention. It does not grant itself permission.

Groq is the first `IntentModelProvider`, using the fixed server-side endpoint
`https://api.groq.com/openai/v1/chat/completions` and model
`openai/gpt-oss-20b`. No SDK or production dependency was added: native Node fetch,
existing Zod and Node primitives suffice. Environment configuration selects
`INTENT_MODEL_PROVIDER=groq`, `INTENT_MODEL_NAME=openai/gpt-oss-20b` and an external
`GROQ_API_KEY`. Unsupported models/providers and absent keys return
MODEL_CONFIGURATION_ERROR without a request. No silent paid-provider fallback.

Official Groq documentation checked 2026-10-10:

- [Structured outputs](https://console.groq.com/docs/structured-outputs): GPT-OSS
  20B supports strict constrained-decoding JSON Schema, including anyOf; all object
  properties must be required and objects must disallow additional properties.
- [Models](https://console.groq.com/docs/models): context 131,072 tokens and maximum
  completion 65,536 tokens. PayFlow uses much smaller limits.
- [Rate limits](https://console.groq.com/docs/rate-limits): the free-plan table lists
  20B at 30 requests/minute, 1,000/day, 8,000 tokens/minute, 200,000/day. Actual
  account limits/availability can differ. No purchase of credits is required by
  this adapter; account provisioning and provider availability remain external.
- [Reasoning](https://console.groq.com/docs/reasoning): GPT-OSS uses
  include_reasoning rather than reasoning_format. We request include_reasoning=false
  and reasoning_effort=low; no hidden reasoning is requested or retained.

A live Groq request was NOT run during 3B because the runtime credential was
unavailable. This is an explicit verification limitation, not a simulated success.

## Contract and data flow

Source + reference -> provider -> unknown candidate -> strict local
IntentInterpretationSchema -> compileIntentDraft with independent context ->
conservative semantic checks -> deterministic questions / untrusted review draft.

The adapter requests response_format=json_schema, strict=true, one non-streaming
choice. `intent-model-schema.ts` describes the structural subset of the existing
payflow.intent.v1 contract using closed required objects and anyOf discriminants.
It does NOT transform a provider projection, default missing values, remove
fields or relax the canonical schema. Range, precision, cardinality, timestamps,
source spans and local policy are still enforced locally. The provider structural
schema deliberately omits local refinements; a schema-shaped response is not a
valid PayFlow interpretation until Zod and the compiler validate it.

EXPLICIT/PROPOSED/MISSING/AMBIGUOUS are preserved. EXPLICIT is an untrusted claim
of source support. The model cannot authenticate the speaker. It gets no review
bounds, database records, other users' data, mandates, receipts, grants, signing
keys or PayPal credentials. It has no tool access. The service snapshots parsed
independent context before awaiting the provider and freezes the source copy,
preventing caller mutation during interpretation from widening bounds.

## Instruction and source isolation

`payflow.intent-instruction.v1` is a versioned static system instruction. The
source is a separate user-role JSON envelope, never interpolated into the system
instruction. It describes extraction, exact UTF-16 spans, explicit versus inferred
constraints, negation, ambiguity and no financial permission. The returned
non-secret diagnostic records the instruction version; it stores no provider
response metadata, raw errors, prompt text or reasoning. No evidence is persisted
by this module. Source/provenance remain in the non-authoritative result as in 3A.

Prompts improve reliability; they are NOT security controls. Even a model that
ignores the instruction cannot cross the dependency boundary or create financial
authority. No confidence threshold upgrades a state or bypasses validation.

## Semantic conservatism and limitations

3A source/reference/span verification and reviewBounds remain unchanged. Bounds
must be independently supplied by trusted intake/human controls; copying model
output into them is forbidden. The model cannot bound itself.

3B adds deliberately small English support checks for explicit critical values:
recognized maximum phrases and exact decimal values/bounds, literal currency
codes, explicit numeric/small-word quantities, condition enums, exact merchant
IDs, a small set of autonomy/confirmation phrases, absolute canonical expiry and
literal capability names. Recognized contradictions, vague prices/quantities,
merchant similarity, unclear conditions, vague expiry and common negations
produce NEEDS_CLARIFICATION. Unsupported phrasing also requires clarification;
checks never replace a model value or promote a proposed/missing value.

Under/less than remain exclusive (one minor unit below the decimal ceiling).
At most/maximum/no more than remain inclusive. Exactly is not treated as a
maximum. Around/about/roughly/near do not become precise financial limits. Money
normalization uses 3A's BigInt decimal conversion, never fractional Number math.
A dollar symbol does not establish USD; singular nouns do not establish one item.
The primary keyboard example therefore requires clarification for missing
currency, quantity, category, merchant scope, expiry and capabilities.

This is NOT formal semantic verification of arbitrary language, omission,
negation, languages other than the supported small English grammar or adversarial
quotation. Item/category meaning still needs human review; arbitrary omitted
restrictions may escape the limited checks. Independent bounds and eventual
human review remain essential. A valid draft is not authenticated confirmation,
a trusted mandate or a financial authorization. No second-model review or repair
loop is used; another model would remain untrusted anyway.

## Clarification and failure taxonomy

Questions are fixed local templates selected from deterministic unresolved field
codes, deduplicated in schema field order. Model explanations cannot request a
secret or change the choices/security meaning. The model cannot satisfy a
clarification: updated user input must pass interpretation, validation and
compilation again. There is no conversation state or confirmation endpoint.

INTERPRETED wraps the compiler's VALID_DRAFT / NEEDS_CLARIFICATION / REJECTED.
These are not financial ALLOW/DENY/ESCALATE decisions. Failures are:

- INVALID_INTENT_INPUT: invalid context or source limit exceeded;
- MODEL_CONFIGURATION_ERROR: absent/invalid configuration or HTTP 401/403;
- MODEL_RATE_LIMITED: HTTP 429;
- MODEL_UNAVAILABLE: network/body transport failure or HTTP 5xx;
- MODEL_TIMEOUT / MODEL_CANCELLED: bounded deadline or caller cancellation;
- MODEL_REJECTED: other unsuccessful HTTP responses or explicit refusal/filter;
- INVALID_MODEL_OUTPUT: malformed/duplicate/deep JSON, schema violation, empty,
  wrong-role/cardinality, tool call, truncated, unsupported or oversized response.

Errors contain fixed states only, never raw provider bodies/headers/exceptions.
Redirects are rejected rather than forwarding the credential elsewhere. API keys
are private in-memory fields and are never returned or logged. User source can
itself contain sensitive data: trusted intake must minimize it before sending to
Groq. This module does not promise to detect every secret a human types. Provider
retention/privacy terms remain an external consideration before deployment.

## Resource bounds

One request per interpretation; zero automatic retries, zero recursive repair,
zero second-model calls. Source is at most 2,000 UTF-16 code units and 4,000 UTF-8
bytes (reference at most 200 characters). Completion budget is 2,048 tokens;
content at most 32,768 bytes; whole response at most 65,536 bytes, read with a
bounded stream and cancelled on overflow. Timeout is 15 seconds across headers
and body. Caller cancellation aborts the request; a deadline race also bounds
transports that ignore abort. JSON nesting is limited to 24 levels; duplicate
keys and prototype-like keys are rejected before canonical schema parsing.

Provider-side token usage, quotas and request acceptance remain external; declared
bounds prevent uncontrolled application loops, not organization-wide abuse.
Production authentication, request-rate controls and per-user allocation remain
future work. Do not expose this server module or its key to a browser.

## Tests and activation blockers

FakeIntentModelProvider returns unknown candidates through the SAME local service
validation/compiler/semantic path. Mocked HTTP exercises real request construction
and response handling. Standard tests require zero Groq credentials and make zero
Groq requests. Architectural tests traverse an explicit transitive import allowlist
and forbid financial modules, filesystem/process access, dynamic imports and eval.

Optional smoke: configure the runtime secret securely and run
`RUN_GROQ_SMOKE_TEST=true npm run test:groq:smoke`. Missing credentials on explicit
opt-in fail with a fixed diagnostic. Normal CI skips it. The smoke exercises real
Groq, local schema, compiler and the missing-field clarification outcome; no
trusted mandate, execution grant or PayPal request is possible. It never prints
raw output or credentials, including on failure.

QUANTITY_ENFORCEMENT and MERCHANT_ALLOWLIST_ENFORCEMENT remain draft activation
blockers because M2 does not enforce those restrictions. No activation function
exists. Do not copy the term projection into MandateSchema and drop restrictions.
M1/M2/3A tests and financial semantics are unchanged. No migration is required.

## Deferred work

3C must be separately scoped/reviewed: authenticated confirmation, binding the
exact reviewed draft, enforcement gaps, safe provenance persistence and production
intake/abuse controls are NOT implemented here. No product discovery, Channel3,
autonomous shopping, final UI or live PayPal. No semantic perfection or
exactly-once distributed-execution claim is made.
