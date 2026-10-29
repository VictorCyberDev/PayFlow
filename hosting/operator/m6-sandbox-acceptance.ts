/**
 * OPERATOR-ONLY M6 live PayPal SANDBOX acceptance: one fresh $84 USD delegated purchase.
 *
 * Prerequisite: the owner has already completed the one-time PayPal Sandbox wallet bootstrap on
 * the isolated hosted M6 console. The browser never exposes the provider setup token or vault id.
 * This runner reuses that encrypted, owner-bound instrument from PostgreSQL.
 *
 *   RUN_M6_SANDBOX_ACCEPTANCE=true DATABASE_URL=... PAYPAL_ENVIRONMENT=sandbox \
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
 *   PAYPAL_EXPECTED_MERCHANT_ID=<13-char Sandbox merchant id> \
 *   PAYFLOW_M5_PRINCIPAL_ID=... PAYFLOW_M5_AGENT_ID=... PAYFLOW_M5_BOOTSTRAP_KEY=... \
 *   PAYFLOW_M6_SIGNING_KEY="<PEM>" npm run acceptance:m6:sandbox
 *
 * It REFUSES a database with prior financial history, uses the exact hosted owner/Agent identity,
 * runs the real delegated pipeline with no human step, then proves exactly one capture, durable
 * COMMITTED/CONSUMED terminal state, replay with zero further capture, and a VERIFIED Trace.
 * It prints identifiers and bounded evidence only, never credentials or decrypted vault material.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { mandateFingerprint } from "../../src/canonical.js";
import { deriveHostKeys } from "../../src/console-session-durable.js";
import { DemoShoppingAgent } from "../../src/delegated-demo.js";
import { OperationTraceService } from "../../src/operation-trace.js";
import {
  PayPalExecutionRail,
  PayPalOAuthClient,
  type PaymentProvider,
} from "../../src/paypal.js";
import {
  PayPalVaultStore,
  StoredPayPalPaymentProvider,
} from "../../src/paypal-vault-bootstrap.js";
import { PostgresTrustRepository } from "../../src/persistence.js";

const need = [
  "RUN_M6_SANDBOX_ACCEPTANCE",
  "DATABASE_URL",
  "PAYPAL_ENVIRONMENT",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_EXPECTED_MERCHANT_ID",
  "PAYFLOW_M5_PRINCIPAL_ID",
  "PAYFLOW_M5_AGENT_ID",
  "PAYFLOW_M5_BOOTSTRAP_KEY",
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

/** Counts provider calls independently from PayFlow's own outcome projection. */
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

  const principalId = process.env.PAYFLOW_M5_PRINCIPAL_ID!;
  const agentId = process.env.PAYFLOW_M5_AGENT_ID!;
  const keys = deriveHostKeys(process.env.PAYFLOW_M5_BOOTSTRAP_KEY!);
  const vault = new PayPalVaultStore(repo.sql, keys.paymentInstrument);
  if (!(await vault.has(principalId))) {
    console.error(
      "REFUSED: owner has no approved PayPal Sandbox instrument; complete one-time hosted wallet approval first",
    );
    process.exit(4);
  }

  const [principal] =
    await repo.sql`select id from principals where id=${principalId}`;
  const [passport] =
    await repo.sql`select id,status from agent_passports where id=${agentId} and principal_id=${principalId}`;
  if (!principal || !passport || passport.status !== "ACTIVE") {
    console.error(
      "REFUSED: hosted principal/Agent identity is missing or inactive in the isolated acceptance database",
    );
    process.exit(4);
  }

  const now = () => new Date();
  const start = now();
  const id = "m6-" + start.getTime().toString(36);
  const mandate = {
    id: `${id}-mandate`,
    principalId,
    authorizedAgentId: agentId,
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
  await repo.saveMandate(mandate);

  const privateKey = createPrivateKey(process.env.PAYFLOW_M6_SIGNING_KEY!);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    console.error("REFUSED: PAYFLOW_M6_SIGNING_KEY must be Ed25519 PKCS#8");
    process.exit(2);
  }
  const real = new StoredPayPalPaymentProvider(
    new PayPalOAuthClient(
      process.env.PAYPAL_CLIENT_ID!,
      process.env.PAYPAL_CLIENT_SECRET!,
    ),
    vault,
    principalId,
  );
  const { provider, calls } = counting(real);
  const agent = new DemoShoppingAgent({
    repo,
    provider,
    paymentReady: () => real.connected(),
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
    await repo.sql`select id,status,provider_order_id,provider_capture_id,amount_minor,currency,grant_id,reservation_id from payment_attempts`;
  const firstCaptureCalls = calls.captureOrder;

  // A second delegated request under the exhausted one-item/$100 Authority must not capture again.
  const second = await agent.run(mandate.id, "VALID_PURCHASE");
  if (attempt?.id)
    await new PayPalExecutionRail(repo, provider, () =>
      now().toISOString(),
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
  const [res] = attempt?.reservation_id
    ? await repo.sql`select status,amount_minor from authorization_reservations where id=${String(attempt.reservation_id)}`
    : [];
  const [grant] = attempt?.grant_id
    ? await repo.sql`select status from execution_grants where id=${String(attempt.grant_id)}`
    : [];
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
    captureCallsAfterFirstAttempt: calls.captureOrder - firstCaptureCalls,
    createOrderCalls: calls.createOrder,
    secondAttempt: second.status,
    reservation: res
      ? { status: String(res.status), amountMinor: Number(res.amount_minor) }
      : null,
    grantStatus: grant ? String(grant.status) : null,
    traceStatus: trace?.status ?? null,
    traceOutcome: trace?.financialOutcome ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
  const pass =
    report.outcome === "COMPLETED" &&
    report.askedHuman === false &&
    report.amount === "84.00 USD" &&
    report.paymentAttemptStatus === "CAPTURED" &&
    report.providerOrderStatus === "COMPLETED" &&
    report.providerCaptures === 1 &&
    report.createOrderCalls === 1 &&
    report.captureOrderCalls === 1 &&
    report.captureCallsAfterFirstAttempt === 0 &&
    report.secondAttempt !== "COMPLETED" &&
    report.reservation?.status === "COMMITTED" &&
    report.reservation.amountMinor === 8400 &&
    report.grantStatus === "CONSUMED" &&
    report.traceStatus === "VERIFIED";
  console.log(
    pass ? "M6 SANDBOX ACCEPTANCE: PASS" : "M6 SANDBOX ACCEPTANCE: FAIL",
  );
  process.exit(pass ? 0 : 1);
} finally {
  await repo.close();
}
