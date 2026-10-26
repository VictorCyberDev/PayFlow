# M6 — Delegated / Human-Not-Present Commerce

Status: see `docs/M6-ACCEPTANCE-HANDOFF.md` for the live acceptance state and merge gate.

M6 proves that a human can create an authenticated, bounded **Authority**, approve a Sandbox PayPal wallet once, and later let an Agent complete an eligible purchase **without asking again** — only while the existing Authority permits that exact transaction. Wallet consent is a payment instrument; it never becomes PayFlow financial authority.

## Locked execution rule

M6 adds no second policy engine. Human-not-present commerce remains the accepted M1–M5 path:

```
selection -> trusted quote -> sealed manifest -> proposal
  -> authorizeProposal (kernel + durable reservation)
  -> one-time Ed25519 execution grant
  -> ExecutionBoundary immediate durable revalidation
  -> PayPal order/capture or UNKNOWN quarantine/reconciliation
  -> EvidenceLedger + verified OperationTrace
```

`ALLOW` can execute without a new human step. `ESCALATE` produces `NEEDS_HUMAN` and no delegated provider effect. `DENY` produces zero provider effect.

## One-time PayPal wallet bootstrap

The M6 acceptance host adds a payer-present setup flow used **once** before delegated execution:

1. Authenticated owner starts `/api/paypal-vault/start` with CSRF/origin/session enforcement.
2. PayFlow creates a PayPal Sandbox setup token server-side.
3. The browser receives only the PayPal approval URL and a random callback `state` embedded in the server-configured return URL.
4. The setup token is AES-256-GCM encrypted in PostgreSQL, bound to the authenticated console session and principal, expires after ten minutes, and can be claimed once.
5. On callback, the browser returns only `state`; it never stores or posts a setup token, vault id, client secret, or signing key.
6. PayFlow exchanges the server-held setup token for a PayPal payment token and stores the resulting vault id encrypted and owner-bound in `console_demo_payment_instruments`.
7. Later delegated orders load that encrypted instrument server-side at order-creation time. Observation and reconciliation of already-created orders do not depend on browser state.

This flow is deliberately separate from Authority creation. An approved wallet cannot widen merchant, amount, quantity, product, condition, capability, expiry, Agent, or budget constraints.

## Additive persistence

M6 adds two forward-only migrations:

- `011_m6_delegated_payment_instrument.sql` — encrypted owner-bound delegated payment instrument.
- `012_m6_paypal_vault_setup_state.sql` — encrypted, expiring, one-time PayPal setup-token state bound to a durable console session.

Historical migrations remain unchanged.

## Key implementation surfaces

- `src/delegated-commerce.ts` — composes the existing authorization and execution services; never creates a second permission model.
- `src/paypal.ts` — PayPal Sandbox delegated order shape using `payment_source.paypal.vault_id`, plus the accepted UNKNOWN/reconciliation semantics.
- `src/paypal-vault-bootstrap.ts` — server-owned setup state, encrypted vault storage, and `StoredPayPalPaymentProvider`.
- `src/delegated-demo.ts` / `src/console-demo-agent.ts` — non-production Shopping Agent with durable payment-readiness checks.
- `src/console-hosted.ts` — hosted composition wires the Agent to the encrypted owner instrument; no `PAYPAL_DELEGATED_VAULT_ID` environment variable is used by the hosted path.
- `hosting/m6/api/vault.ts` — isolated owner-authenticated vault bootstrap endpoint.
- `hosting/operator/m6-sandbox-acceptance.ts` — live acceptance reads the already-approved owner instrument from the isolated database and refuses if it is missing.

## Required acceptance outcomes

The final live Sandbox gate must prove in one fresh financial-history-free acceptance database:

- one `$84.00 USD` delegated purchase completes without a human approval step during execution;
- exactly one PayPal order and one capture are created;
- the payment attempt ends `CAPTURED`;
- the reservation ends `COMMITTED` for 8400 minor units;
- the execution grant ends `CONSUMED`;
- a second attempt cannot create another completed purchase or another capture;
- provider observation/reconciliation agrees with the terminal state;
- the Operation Trace is `VERIFIED`;
- the `$184` trusted-price drift case remains zero-effect;
- the runner terminates with `M6 SANDBOX ACCEPTANCE: PASS`.

## Regression coverage

Coverage includes state-only browser callback handling, no setup-token browser exposure, server-side stored-wallet order creation, refusal before provider create when no owner instrument exists, hosted owner isolation, deterministic `$84` completion, `$184` zero-effect drift, replay/concurrency/revocation/expiry defenses, provider ambiguity reconciliation, Activity projection, Trust Trace verification, and Chromium E2E.

## Non-regression boundary

M6 does not replace the accepted Trust Kernel, Mandate, AgentPassport, durable reservation/accounting, Ed25519 one-time grants, payment-attempt state machine, trusted quote/sealed manifest, payer-return revalidation, EvidenceLedger, OperationTraceService, Authority projections, or owner/session controls. Browser state and provider redirects are notifications/evidence, never financial authority.

M7 remains out of scope until M6 has a live Sandbox PASS, an independent clean review, and a merge decision.
