> **2026-10-29 company launch correction:** PayFlow remains a developer preview. M6 is unaccepted; PR #18 remains draft. The company website and new protocol work are local, not a public launch. See [Company RC](docs/PAYFLOW-COMPANY-LAUNCH-RC.md), [corrected milestone audit](docs/COMPANY-LAUNCH-MILESTONE-AUDIT.md), [protocol commissioning](docs/PROTOCOL-COMMISSIONING.md), and [security review](docs/COMPANY-LAUNCH-SECURITY-REVIEW.md). Historical reports below are not current launch certifications.

# PayFlow

**Financial authority for autonomous systems.**

> Any agent. Any rail. One authority truth.

PayFlow is the financial-authority boundary between autonomous intent and consequential financial action. A model, agent, commerce protocol or payment rail may carry context; none of them becomes permission. The deterministic Trust Kernel decides whether the exact action is authorized now, execution uses bounded one-time capability, ambiguous provider outcomes remain `UNKNOWN`, and Proof preserves what actually happened.

## Current repository state

This repository deliberately separates accepted history from active development.

- `main` remains the accepted pre-M6 baseline for the current stack.
- M6 — delegated / human-not-present commerce — exists on draft PR #16 and remains **unmerged and not accepted** because live PayPal Sandbox acceptance and independent M6 review are still open.
- `m7-m60-master-execution` is a separate integration branch stacked on the exact M6 head so later work can be reviewed without rewriting M6 history.
- Draft PR #18 contains M7–M60 company/network work. It must not be interpreted as M6 acceptance or as a production/global-adoption claim.
- No M7–M60 work in this branch claims a live second/third rail capture, real merchant/PSP/design partner, independent audit, certification, standards-body participation, ChatGPT publication or global production adoption unless separate real evidence is added.

See `docs/M7-M60-EXECUTION-LEDGER.md` and `docs/OVERNIGHT-M7-M60-HANDOFF.md` for exact milestone status when present.

## The conserved authority chain

```text
Intent / commerce context / protocol message
        ↓              (untrusted input)
Trusted identity context
        ↓
Bounded Authority + delegation path
        ↓
Deterministic Trust Kernel
        ↓
Durable reservation
        ↓
One-time exact-bound execution grant
        ↓
Immediate runtime revalidation
        ↓
Replaceable financial rail
        ↓
SUCCEEDED / FAILED / UNKNOWN
        ↓
Lookup-only reconciliation when ambiguous
        ↓
Portable verifiable Proof
```

## What the product exposes

**Authority** — people and organizations create, inspect, suspend, revoke and delegate bounded financial Authority.

**Gateway** — agents request authorization for an exact action through REST, TypeScript/Python SDK foundations, MCP, A2A and framework adapters. External assertions cannot widen Authority.

**Verify** — merchants, platforms and auditors verify signed Authority/Proof material without a money-moving capability.

**Proof** — durable financial truth about authorization, delegation, reservation, execution-grant state, provider effect, effect count, `UNKNOWN`, reconciliation and final outcome.

**Enterprise control plane** — organizations, roles, agent lifecycle, delegation, separation of duties, templates, integrations, retention and audit controls.

**Rail adapters** — provider-neutral execution contract with exact action digest, idempotency, one-time grant, normalized evidence and reconciliation.

## Core invariants

- model output remains untrusted input;
- browser/client state is never financial truth;
- delegation may attenuate but may not silently widen;
- Authority is durably revalidated before irreversible provider effect;
- execution grants are exact-bound, short-lived and replay resistant;
- reservations happen before irreversible Authority consumption;
- duplicate execution must be prevented or remain safely unresolved;
- `UNKNOWN` is first-class truth and routes to reconciliation, not blind retry;
- verification cannot move money;
- protocol/identity/payment providers cannot redefine financial Authority;
- UI never claims success before durable financial truth exists;
- historical migrations/evidence are not rewritten to make a demo look cleaner.

## Repository map

```text
apps/console/       personal, developer, enterprise and verifier product surfaces
api/                bounded API/deployment entry points
db/migrations/      forward-only PostgreSQL migrations
examples/            integration examples
hosting/             hosted demo/operator adapters from accepted milestones
openapi/             versioned public API contract
packages/            SDK/verifier/merchant package foundations
plugins/             plugin/MCP packaging metadata
spec/                public financial-authority schema
src/                 Trust Kernel plus network/control/protocol modules
tests/               unit, adversarial, integration, concurrency and product tests
docs/                ADRs, architecture, security, operations and evidence
```

## Local development

Requirements: Node.js 20+ and PostgreSQL 17 for integration tests. Normal validation uses local/sandbox fixtures and does not require a live provider.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
```

Console:

```bash
cd apps/console
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database for root integration tests. See `docs/QUICKSTART-M7-M60.md` for the network-level conceptual path.

## External provider tests

Provider tests are explicit opt-in and must use sandbox credentials unless the owner separately authorizes production. Credentials alone do not enable a live test. Never commit database URLs, provider tokens, OAuth secrets, private signing keys, webhook secrets or payment credentials.

M6 live PayPal acceptance remains separate from M7–M60 development. Nothing in this branch fabricates `M6 SANDBOX ACCEPTANCE: PASS`.

## Commercial boundary

PayFlow is not a bank, wallet/custodian, card issuer, lender, proprietary LLM, generic agent orchestrator or payment rail. The company category is **Financial authority for autonomous systems**.

The commercial model is developer sandbox → platform usage/subscription → enterprise control plane/integrations, with verification kept low-friction where strategically useful. The repository does not fabricate pricing validation, revenue or customers.

## License

PayFlow is released under the [MIT License](LICENSE).

## Safety note

The active M7–M60 branch contains local/sandbox network primitives and product surfaces. It is not a claim of production banking infrastructure, regulatory certification, independent audit or global merchant acceptance.
