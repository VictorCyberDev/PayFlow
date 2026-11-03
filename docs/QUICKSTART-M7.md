# Quickstart — your first safe action

> **Status: developer preview, PayPal Sandbox only. No real money moves.**
> The "under five minutes" target is a goal. It has **not been measured**; do not quote it
> until a timed run with a developer who did not build PayFlow is recorded here.

You will: get a sandbox credential, install the SDK, send an allowed purchase, break the
Authority on purpose to see a `$0 moved` refusal, and inspect the Proof.

## 0. Fastest path: the self-serve sandbox (simulated rail)

On a host that sets `PAYFLOW_PUBLIC_SANDBOX=true`, no account or admin is needed:

```bash
curl -sS -X POST "$PAYFLOW_URL/v1/sandbox/start"
```

You receive a one-hour `token`, an `authority` ($100, one keyboard), your `agentId`, and `rail: "SIMULATED"`.
Skip to step 4. **No money moves and no payment provider is contacted**; responses and Proofs say
`SIMULATED`. Limited to 5 per address per hour. **No public host is live yet.** Steps 1-3 below describe the
real PayPal Sandbox rail, which needs an administrator-issued credential.

## 1. Get a sandbox credential (real PayPal Sandbox rail)

Two different secrets are involved, and they are not interchangeable:

- the **platform operator token** (`PAYFLOW_GATEWAY_ADMIN_TOKEN`) can only bootstrap the first OWNER of an existing organization and run platform operations;
- an **organization member token** (`pf_act_…`) carries a role. OWNER and DEVELOPER may issue credentials.

```bash
# once per organization, by the operator: create the first OWNER (the token is shown once)
curl -sS -X POST "$PAYFLOW_URL/v1/admin/members" \
  -H "authorization: Bearer $PAYFLOW_OPERATOR_TOKEN" -H "content-type: application/json" \
  -d '{"organizationId":"<org>","environment":"SANDBOX","displayName":"you","role":"OWNER"}'

# then, as that member: issue a scoped, expiring credential for one agent (the secret is shown once)
curl -sS -X POST "$PAYFLOW_URL/v1/admin/credentials" \
  -H "authorization: Bearer $PAYFLOW_MEMBER_TOKEN" -H "content-type: application/json" \
  -d '{"agentId":"<agent id>","scopes":["action:request","proof:read"],"ttlSeconds":3600,"label":"quickstart"}'
```

PayFlow stores only a digest of each token. Keep the returned `token` (`pf_sbx_…`) in `PAYFLOW_TOKEN`. Revoke it any time with
`POST /v1/admin/credentials/<credentialId>/revoke` as a member whose role allows it; the next request fails closed.

## 2. Install the SDK

```bash
# TypeScript: build from packages/sdk-typescript (not yet published to npm)
pip install ./packages/sdk-python   # Python
```

## 3. Use an Authority

An Authority is the boundary a person set for your agent. The sandbox sample is the
**Keyboard Authority**: one new keyboard, approved merchant only, up to **$100**. Its id and the
agent id are shown in the sandbox console. You need its Authority id, agent id and the owner's
connected sandbox wallet (the owner connects it once).

## 4. Send an allowed action

```ts
import { PayFlowClient } from "@payflow/authority-sdk";

const payflow = new PayFlowClient({
  baseUrl: process.env.PAYFLOW_URL!,
  accessToken: process.env.PAYFLOW_TOKEN!,
});

const result = await payflow.actions.execute({
  authority: "<authority id>",
  agent: "<agent id>",
  item: "Quiet keyboard",
  amount: 8400, // $84.00, in cents. Checked against the trusted price, never trusted.
  currency: "USD",
  merchant: "payflow.demo.merchant",
  nonce: "order-0001-attempt-1", // idempotency key, min 16 chars
});
```

```python
from payflow import PayFlowClient
payflow = PayFlowClient(PAYFLOW_URL, PAYFLOW_TOKEN)
result = payflow.actions.execute(authority="…", agent="…", item="Quiet keyboard",
                                 amount=8400, currency="USD",
                                 merchant="payflow.demo.merchant", nonce="order-0001-attempt-1")
```

## 5. Read the outcome

Switch on `result.status`:

| status           | meaning                                | `effectCount` |
| ---------------- | -------------------------------------- | ------------- |
| `COMPLETED`      | **$84 paid once**                      | `1`           |
| `DENIED`         | refused, **$0 moved**; read `reason`   | `0`           |
| `NEEDS_APPROVAL` | above what the agent may do alone      | `0`           |
| `UNRESOLVED`     | we're confirming whether money moved   | `null`        |
| `REJECTED`       | bad credential, scope or shape         | `0`           |
| `INDETERMINATE`  | transport/server failure after sending | `null`        |

`effectCount: null` means **unknown, not zero**. Do not retry; read the Proof later. Reusing
a `nonce` is always safe: a repeat is denied with `REPLAY_DETECTED` and never pays twice.

## 6. Break the Authority on purpose

Ask for more than the trusted price or a merchant the Authority does not include:

```ts
const blocked = await payflow.actions.execute({
  /* …same… */ amount: 18400,
  nonce: "order-0002-attempt-1",
});
// { status: "DENIED", effectCount: 0, reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
//   recoverable: true, nextAction: "REFRESH_QUOTE_AND_RETRY_WITH_NEW_NONCE",
//   humanSummary: "The amount or merchant in the request does not match the trusted price." }
```

Nothing was reserved, no grant was issued and PayPal was never called. `recoverable` and
`nextAction` tell an agent how to recover; they never let it widen its own Authority.

## 7. Inspect the Proof

```ts
const proof = await payflow.proofs.get(result.proof!.proposalId!);
```

The Proof is the durable operation trace: Principal → Agent → Authority → quote → manifest →
decision → Reservation → one-time grant → payment attempt → provider capture → outcome.
It contains no credentials.

## 8. Verify it independently (optional)

A merchant or auditor can check the outcome without your session or any PayFlow server access:

```bash
curl -H "authorization: Bearer $PAYFLOW_TOKEN" "$PAYFLOW_URL/v1/proofs/<proposalId>/portable" > proof.json
curl "$PAYFLOW_URL/v1/keys"      # public keys only
payflow-verify proof.json public-jwk.json   # exit 0 = authentic; add --max-age 3600 to require freshness
```

An `UNKNOWN` outcome is signed as `UNKNOWN` with `effectCount: null`; it can never verify as a success.

## What is real and what is not

- Execution runs through PayFlow's Trust Kernel and the PayPal **Sandbox** rail.
- Credentials are PayFlow bearer tokens (preview). OAuth/OIDC is a later production path.
- The catalog and merchant are a controlled demo merchant.
