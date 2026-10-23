/**
 * OPERATOR-ONLY M6 live PayPal SANDBOX acceptance: one fresh $84 USD delegated purchase.
 *
 *   RUN_M6_SANDBOX_ACCEPTANCE=true DATABASE_URL=... PAYPAL_ENVIRONMENT=sandbox \
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_DELEGATED_VAULT_ID=... \
 *   PAYPAL_EXPECTED_MERCHANT_ID=<13-char Sandbox merchant id> PAYFLOW_M6_SIGNING_KEY="<PEM>" \
 *     npm run acceptance:m6:sandbox
 *
 * It uses the isolated acceptance database (REFUSES one with payment history, so no historical
 * order or capture is ever reused), provisions one owner/agent/Authority, runs the real delegated
 * pipeline with no human step, then proves exactly one capture, a replay with zero further
 * captures, and a verified Trace. It prints identifiers and counts only, never a credential.
 * It is Sandbox-only by construction: any other PayPal environment is refused.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { mandateFingerprint } from "../../src/canonical.js";
import { DemoShoppingAgent } from "../../src/delegated-demo.js";
import { OperationTraceService } from "../../src/operation-trace.js";
import {
  paypalDelegatedProviderFromEnv,
  type PaymentProvider,
} from "../../src/paypal.js";
import { PostgresTrustRepository } from "../../src/persistence.js";

const need = [
  "RUN_M6_SANDBOX_ACCEPTANCE",
  "DATABASE_URL",
  "PAYPAL_ENVIRONMENT",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_DELEGATED_VAULT_ID",
  "PAYPAL_EXPECTED_MERCHANT_ID",
  "PAYFLOW_M6_SIGNING_KEY",
];
const missing = need.filter((k) => !process.env[k]);
if (missing.length || process.env.RUN_M6_SANDBOX_ACCEPTANCE !== "true") {
  console.error("REFUSED: missing configuration: " + missing.join(", "));
  process.exit(2);
}
if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") {
  console.error("REFUSED: PayPal SANDBOX only");
  process.exit(2);
}
const merchantId = process.env.PAYPAL_EXPECTED_MERCHANT_ID!;
if (
  !/^[A-Z0-9]{13}$/.test(merchantId) ||
  merchantId.startsWith("DEMOACCOUNT")
) {
  console.error(
    "REFUSED: PAYPAL_EXPECTED_MERCHANT_ID must be the real 13-character Sandbox merchant id",
  );
  process.exit(2);
}

/** Counts money-moving calls so the report cannot depend on the system under test's own claims. */
function counting(inner: PaymentProvider) {
  const calls = { createOrder: 0, captureOrder: 0, getOrder: 0 };
  const provider: PaymentProvider = {
    createOrder: (i) => (calls.createOrder++, inner.createOrder(i)),
    captureOrder: (id, key) => (
      calls.captureOrder++,
      inner.captureOrder(id, key)
    ),
    getOrder: (id) => (calls.getOrder++, inner.getOrder(id)),
  };
  return { provider, calls };
}

const repo = PostgresTrustRepository.connect(process.env.DATABASE_URL!);
try {
  const present = (
    await repo.sql`select to_regclass('public.principals') is not null as present`
  )[0]!.present as boolean;
  if (!present)
    for (const name of (await readdir("db/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await repo.migrate(await readFile("db/migrations/" + name, "utf8"));
  for (const t of [
    "payment_attempts",
    "authorization_reservations",
    "execution_grants",
    "transaction_proposals",
    "paypal_provider_observations",
  ]) {
    const [r] = await repo.sql.unsafe(`select count(*) n from ${t}`);
    if (Number(r!.n) > 0) {
      console.error(
        `REFUSED: ${t} is not empty; use a fresh isolated acceptance database`,
      );
      process.exit(3);
    }
  }
  const now = () => new Date();
  const start = now();
  const id = "m6-" + start.getTime().toString(36);
  const mandate = {
    id: `${id}-mandate`,
    principalId: `${id}-owner`,
    authorizedAgentId: `${id}-agent`,
    purpose: "One new mechanical keyboard",
    category: "KEYBOARD",
    currency: "USD",
    maxSingleTransactionMinor: 10000,
    cumulativeLimitMinor: 10000,
    quantityLimit: 1,
    merchantScope: { mode: "ONLY" as const, ids: ["payflow.demo.merchant"] },
    allowedConditions: ["NEW" as const],
    merchantRiskCeiling: "LOW" as const,
    autonomousPurchaseThresholdMinor: 10000,
    humanApprovalThresholdMinor: 10000,
    allowedCapabilities: ["CAPTURE_PAYMENT" as const],
    version: 1,
    nonce: `${id}-nonce-0001`,
    createdAt: new Date(start.getTime() - 60_000).toISOString(),
    expiresAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
  await repo.savePrincipal({
    id: mandate.principalId,
    displayName: "M6 acceptance owner",
  });
  await repo.saveAgent({
    id: mandate.authorizedAgentId,
    principalId: mandate.principalId,
    displayName: "Shopping Agent",
    issuedAt: mandate.createdAt,
    expiresAt: mandate.expiresAt,
    status: "ACTIVE",
    capabilities: ["CAPTURE_PAYMENT"],
  });
  await repo.saveMandate(mandate);
  const privateKey = createPrivateKey(process.env.PAYFLOW_M6_SIGNING_KEY!);
  const real = paypalDelegatedProviderFromEnv();
  const { provider, calls } = counting(real);
  const agent = new DemoShoppingAgent({
    repo,
    provider,
    signing: {
      kid: "m6-acceptance",
      privateKey,
      publicKey: createPublicKey(privateKey),
    },
    expectedPayPalMerchantId: merchantId,
    clock: now,
  });

  const out = await agent.run(mandate.id, "VALID_PURCHASE");
  const [attempt] =
    await repo.sql`select id,status,provider_order_id,provider_capture_id,amount_minor,currency from payment_attempts`;
  // Replay / duplicate attempts must add no capture.
  const second = await agent.run(mandate.id, "VALID_PURCHASE");
  if (attempt?.id)
    await new (await import("../../src/paypal.js")).PayPalExecutionRail(
      repo,
      provider,
      () => now().toISOString(),
    ).reconcile(String(attempt.id), now().toISOString());
  const live = attempt?.provider_order_id
    ? await real.getOrder(String(attempt.provider_order_id))
    : undefined;
  const trace = out.operationId
    ? await new OperationTraceService(repo, agent.keys).project(
        { proposalId: out.operationId },
        now().toISOString(),
      )
    : undefined;
  const [res] =
    await repo.sql`select status,amount_minor from authorization_reservations`;
  const report = {
    mandateFingerprint: mandateFingerprint(mandate).slice(0, 12),
    outcome: out.status,
    askedHuman: out.askedHuman,
    orderId: attempt?.provider_order_id
      ? String(attempt.provider_order_id)
      : null,
    captureId: attempt?.provider_capture_id
      ? String(attempt.provider_capture_id)
      : null,
    amount: attempt
      ? `${(Number(attempt.amount_minor) / 100).toFixed(2)} ${String(attempt.currency)}`
      : null,
    paymentAttemptStatus: attempt ? String(attempt.status) : null,
    providerOrderStatus: live?.status ?? null,
    providerCaptures: live?.captures.length ?? null,
    captureOrderCalls: calls.captureOrder,
    createOrderCalls: calls.createOrder,
    secondAttempt: second.status,
    reservation: res
      ? { status: String(res.status), amountMinor: Number(res.amount_minor) }
      : null,
    traceStatus: trace?.status ?? null,
    traceOutcome: trace?.financialOutcome ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
  const pass =
    report.outcome === "COMPLETED" &&
    report.amount === "84.00 USD" &&
    report.providerCaptures === 1 &&
    report.captureOrderCalls <= 1 &&
    report.secondAttempt !== "COMPLETED" &&
    report.traceStatus === "VERIFIED";
  console.log(
    pass ? "M6 SANDBOX ACCEPTANCE: PASS" : "M6 SANDBOX ACCEPTANCE: FAIL",
  );
  process.exit(pass ? 0 : 1);
} finally {
  await repo.close();
}
