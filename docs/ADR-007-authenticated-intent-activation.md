# ADR-007 — Authenticated intent review and mandate activation

Status: implementation under verification (Milestone 3C).

“The AI interprets your intention. It does not grant itself permission.”

## Trust transition

The model and compiler continue producing `UNTRUSTED_MANDATE_DRAFT`. Neither a draft nor its fingerprint authenticates a human. `IntentActivationService` separately recompiles an interpretation against trusted server intake bounds, performs the existing semantic checks, and persists a review. It never activates a client-supplied mandate or accepts a client-supplied principal identity.

A review retains the source/provenance and exact interpretation, compiler context, fingerprint, security snapshots, principal and passport binding, and timestamps. Recompilation reconstructs the canonical terms rather than trusting a projection returned by a client. The reviewed-document hash also binds creation/expiry and security snapshots. The display draft retains exclusive-price provenance and the corresponding minor-unit ceiling. Source text is sensitive user data, stored only in the review document; evidence contains IDs/hashes, not source text or hidden model reasoning. Deployments must apply access controls, retention and deletion policies to review data.

## Authentication interface and explicit action

`HumanActionAuthenticator` is a trusted dependency supplied by the host application. There is deliberately no permissive production authenticator. Tests provide a deterministic authenticator; it is not exported as production authentication.

The external boundary must verify an authenticated HUMAN, audience and session validity, explicit `CONFIRM_EXACT_TERMS` action, and the exact review ID, agent ID, fingerprint, reviewed hash and challenge hash. Its proof must be bound to these values, not merely authenticate a bearer while trusting an arbitrary request body. The future web layer must provide session authentication, CSRF/origin protection, account ownership, secure cookies/token handling, accessible presentation of all canonical terms and a separate explicit confirmation action. Agents and model output must never be accepted as human authentication. This domain milestone does not supply an identity provider, browser/session server or UI.

`HumanConfirmationBoundary` validates the verifier result and seals an opaque, frozen context in a private per-instance WeakMap. Cloned, serialized, fabricated, cross-boundary and expired contexts fail. Principal identity comes only from the trusted verifier. Authentication may involve network requests; verification finishes before the PostgreSQL activation transaction starts. Possessing a review challenge alone is not authentication.

## Durability, expiry and stale state

Reviews last at most five minutes, additionally bounded by the authenticated context, passport and intent expiry. Cryptographically random challenges are stored only as hashes. A PENDING review is consumed once, guarded by PostgreSQL row locking and affected-row checks; its unique mandate relationship prevents duplicate activation across restarts or application instances.

Principal status, passport state and trusted activation policy carry monotonic security epochs. Any relevant update conservatively invalidates an existing review, including revoke-then-restore. Passport and policy hashes additionally detect changed contents. Activation checks current ownership, ACTIVE statuses, capabilities, current time, policy bounds, exact durable document hash and fingerprint. Unknown activation requirements remain failures.

Trusted operator-provisioned activation policy bounds currencies, money, quantity, capabilities, lifetime and known restricted merchant IDs; it supplies merchant risk policy independently of the model. Policy provisioning is a trusted administrative domain operation and must never be exposed to untrusted callers.

## Atomic activation and locks

Creation locks passport, principal, then policy. Activation first locks the review, then passport, principal, then policy. Shared authority lock order is passport before principal. The transaction constructs a new strict trusted mandate with server-generated ID, nonce, version and creation time; consumes the review; links provenance; and appends human-confirmation and activation evidence in the existing ledger. Every expected transition must affect one row. Failures roll back the mandate, confirmation and success evidence together. Rejected activation is separately recorded with a sanitized code. Time and the authenticated context are checked again after ledger writes before commit. No transaction spans authentication, Groq or PayPal network calls.

Activation winning authority locks may commit first; a subsequent revocation prevents new financial dispatch under the existing execution-boundary rules. Revocation that commits first prevents activation. The existing transactional dispatch-handoff revocation linearization point is unchanged; completed external effects remain truthfully reconcilable.

## Quantity and logical merchant enforcement

New activated mandates explicitly contain `quantityLimit` and `merchantScope`. New proposals under quantity-limited mandates must specify an integer quantity; no singular-noun or legacy default invents quantity. PostgreSQL authorization holds the mandate lock while summing reservations. AUTHORIZED, EXECUTING and COMMITTED consume quantity; RELEASED, FAILED and EXPIRED restore it according to existing authority release rules. UNKNOWN payment outcomes retain EXECUTING authority. Reservation quantity must exactly equal the proposal quantity. Corrupt, missing or overconsumed accounting fails closed.

The deterministic kernel checks remaining quantity and exact merchant membership. Grant issuance, claim and PayPal authority checks revalidate commerce restrictions. Mandate fingerprints include optional quantity/merchant terms; proposal digests include optional quantity, binding them through existing signed grants and durable snapshots.

Merchant identifiers are exact, case-sensitive ASCII identifiers; allowlists are canonical sorted sets. ONLY requires a nonempty allowlist of policy-known IDs. ANY permits logical merchants under the remaining policy rules. Display names do not authorize merchants. This is logical merchant binding, not verified PayPal payee routing; the existing Sandbox rail does not acquire a new payee-routing guarantee.

Migration 005 is additive. Historical mandates without these optional fields preserve their historical fingerprints and semantics; historical reservations retain NULL quantity. They are not silently reinterpreted. Quantity accounting is enforced only for explicit quantity-limited mandates.

## Evidence and model isolation

`INTENT_REVIEW_CREATED`, `HUMAN_CONFIRMATION_ACCEPTED`, `INTENT_MANDATE_ACTIVATED` and `INTENT_ACTIVATION_REJECTED` extend the existing ledger. Rejection codes distinguish expiry, stale authority, replay, identity/binding failures and unsupported requirements. Existing policy receipts record quantity/merchant checks and denial reasons; reservation evidence includes quantity. A ledger is not tamper-proof against privileged database administrators.

The 3B model dependency graph remains isolated: no activation, authentication, accounting, grant, key or PayPal imports are reachable from model modules. No live model call is required for review or activation.

## Remaining limits

External authentication correctness is a trusted host obligation. Source-span and conservative semantic checks do not formally verify arbitrary natural language; the human must review exact terms. PostgreSQL and PayPal cannot share an atomic transaction. Provider idempotency retention and UNKNOWN investigation obligations remain unchanged; no exactly-once distributed execution claim is made. No consumer UI, product discovery, live PayPal, Channel3 or autonomous shopping is introduced.
