# ADR-017 — M7–M60 Financial Authority Network

Status: accepted for the `m7-m60-master-execution` integration branch; stacked on unaccepted M6 and not merged to `main`.

## Decision

PayFlow owns one primitive: **financial authority for autonomous systems**. The long-term network category is **The Financial Authority Network for AI Agents** with the line **Any agent. Any rail. One authority truth.**

All new surfaces wrap one deterministic Trust Kernel. REST, SDK, MCP, A2A, commerce protocols, identity systems, enterprise connectors, verifiers and rails are adapters. None is a parallel policy engine and none may widen Authority.

## Modules

The target architecture contains Principal/Organization, Agent Identity Bridge, Authority, Delegation Graph, Intent Compiler, Trust Kernel, Reservation Ledger, Execution Grant, Execution Boundary, Rail Adapter, Financial Attempt state, Reconciliation, Evidence/Proof, Verification, Gateway, Protocol Adapters, Enterprise Control Plane, Telemetry/Abuse Intelligence and Benchmark/Conformance.

Existing modules are refactored incrementally; folder names are not justification for destructive rewrites.

## Network semantics

1. An external system authenticates the principal/agent context.
2. PayFlow loads or verifies bounded Authority under an explicit trust profile.
3. The exact action is normalized and evaluated deterministically.
4. Authority is reserved and a one-time grant binds the exact action.
5. The rail validates the grant and preserves idempotency.
6. Provider effect returns `SUCCEEDED`, `FAILED` or `UNKNOWN`.
7. `UNKNOWN` is resolved by observation/lookup, never replacement execution.
8. Proof records the terminal financial truth.
9. Independent verification remains read-only.

## Cost and deployment

Development is local/CI-first. Vercel is not a debugging environment. Preview deployment is disabled during the integration run and no remote deploy is required unless every local/repository gate is green and remote validation is uniquely necessary.

## M6 dependency

The owner authorized M7+ development before M6 closure. This ADR does not change M6 acceptance meaning. Later work must remain stackable/reviewable against M6 and must label any final PayPal-dependent acceptance `BLOCKED_M6` until real M6 evidence exists.

## External outcomes

Customers, pilots, live second/third rails, independent audit, certification, app/registry publication, standards participation, multi-region production infrastructure and global adoption are external outcomes. The repository may contain complete prerequisite packages but never fabricated evidence.
