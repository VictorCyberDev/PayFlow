# M7–M60 developer quickstart

The five-minute concept is: **create bounded Authority → ask Gateway about one exact action → execute only with a bounded grant → verify Proof → reconcile ambiguity without retrying money movement.**

## 1. Install

```bash
npm ci
```

Use Node.js 20+; PostgreSQL 17 is required for durable integration tests. Normal unit/network tests do not require PayPal or another paid provider.

## 2. Run deterministic validation

```bash
npm run typecheck
npm test
```

Key local examples live in `tests/m7-gateway.test.ts`, `tests/m8-verify.test.ts`, `tests/m26-m30-rails-actions.test.ts`, `tests/m31-m35-enterprise.test.ts`, `tests/m36-m40-assurance.test.ts`, `tests/m51-m55-federation.test.ts` and `tests/m56-m60-global-network.test.ts`.

## 3. Understand the objects

- Principal/Organization: who benefits and owns Authority.
- Agent: the acting machine identity, always sponsor/principal bound.
- Authority: explicit action, money, counterparty, quantity/time and delegation bounds.
- Gateway request: the exact proposed action. It cannot supply a trusted mandate fingerprint or merchant-risk truth.
- Execution grant: short-lived, action-digest/idempotency bound and one-time.
- Rail evidence: `SUCCEEDED`, `FAILED` or `UNKNOWN` plus effect count `1`, `0` or `null`.
- Proof: portable signed evidence of terminal truth.

## 4. External-agent path

`src/network/gateway.ts` loads Authority and Agent state server-side, claims a replay key, computes the current mandate fingerprint and passes the exact action into the existing Trust Kernel. `openapi/payflow-v1.yaml` defines the preview REST shape. `packages/sdk-typescript` and `packages/sdk-python` contain small client foundations.

## 5. Verify path

`src/network/verify.ts` validates signed presentations using audience, challenge, expiry, lifecycle, fingerprint and replay binding. `packages/merchant-sdk` exposes the read-only merchant client and Gate Mark state model. `packages/verifier` verifies portable Proof without any money-moving API.

## 6. Protocol path

`src/protocols/mcp.ts` exposes five tools; `src/protocols/a2a.ts` exposes A2A discovery/delegation. OpenAI/Anthropic/Gemini adapters share the same vocabulary. Protocol messages are untrusted input until normalized and evaluated.

## 7. Rail and ambiguity path

`src/network/rail.ts` is provider neutral. `DeterministicFakeRail` models success, decline, timeout-before-effect and timeout-after-effect for local conformance only. It is not real provider evidence. Reconciliation calls `lookup`, never a replacement `execute`.

## 8. Durable tests

```bash
TEST_DATABASE_URL=postgres://... npm run test:integration
```

Use a disposable test database. Migrations are forward-only and historical migrations remain immutable.

## 9. Full release gate

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
```

Then run console lint/typecheck/tests/build and browser E2E. Do not deploy simply to discover a local build error.
