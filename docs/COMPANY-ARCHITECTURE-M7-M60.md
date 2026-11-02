# PayFlow company architecture — M7–M60

## Category

Financial authority for autonomous systems.

PayFlow owns the boundary:

`Intent → Identity Context → Financial Authority → Runtime Revalidation → Execution → Reconciliation → Verifiable Financial Truth`

## Product planes

**Authority** serves principals/organizations: create, review, activate, inspect, suspend, revoke, amend and delegate bounded Authority.

**Gateway** serves agents/developers: scoped external access, exact action request, deterministic Trust Kernel decision and bounded execution capability.

**Verify** serves merchants/platforms/auditors: signed Authority/Proof validation, freshness, revocation, audience and action-fit checks; no execution function.

**Proof** is the financial-truth plane: authorization, delegation, reservation, execution grant, provider effect, effect count, ambiguity, reconciliation and terminal outcome.

**Enterprise Control Plane** adds organizations, roles, sponsors, agent inventory/lifecycle, separation of duties, templates, integrations, retention and audit.

**Rail adapters** sit below Authority. They require an exact valid grant, preserve idempotency and normalize provider truth without redefining authorization.

## Developer and network plane

OpenAPI, TypeScript/Python client foundations, MCP, A2A, framework adapters, merchant SDK, standalone verifier, public schema, issuer/key directory, federation trust profiles and conformance tools expose the same semantics to external systems.

## Trust boundaries

Model output, browser state, protocol payloads, ERP/AP records, commerce sessions, external issuer assertions and provider callbacks are all untrusted until the relevant signature/schema/freshness/identity/Authority checks pass.

The M60 local demonstrator crosses external platform → identity provider → cryptographically verified external Authority issuer → independent verifier evidence → replaceable rail → reconciliation → portable Proof while preserving one set of financial-authority semantics.

## Product memory system

Frame = bounded financial Authority. Gate = execution boundary. Flow = proposed action approaching the boundary. Proof = durable financial truth. The canonical motion grammar is `Bound → Gate → Commit → Verify`; `UNKNOWN` never visually resolves early.
