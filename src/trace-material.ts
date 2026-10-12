import { CheckoutQuoteSchema } from "./checkout-contracts.js";
import { ControlledOfferSchema } from "./commerce.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
import { AgentPassportSchema, MerchantRiskSchema } from "./domain.js";
import type { PostgresTrustRepository } from "./persistence.js";
import type { PaymentProvider, PayPalOrderView } from "./paypal.js";
export const AuthorizationMaterialSchema = z
  .object({
    agent: AgentPassportSchema,
    context: z
      .object({
        now: z.string().datetime(),
        merchantRisk: MerchantRiskSchema,
        cumulativeSpentMinor: z.number().int().safe().nonnegative(),
        consumedQuantity: z.number().int().safe().nonnegative().optional(),
        replaySeen: z.boolean(),
      })
      .strict(),
  })
  .strict();
export function authorizationMaterialFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update("payflow:authorization-material:v1\n")
    .update(JSON.stringify(AuthorizationMaterialSchema.parse(raw)))
    .digest("hex");
}
const id = z.string().min(1).max(128),
  money = z.string().min(1).max(32),
  currency = z.string().max(3);
const amount = z.object({ currency_code: currency, value: money }).strict();
const item = z
  .object({
    name: id,
    description: z.string().max(256),
    sku: id,
    quantity: z.string().max(8),
    unit_amount: amount,
    category: z.literal("PHYSICAL_GOODS"),
  })
  .strict();
export const ProviderObservationSchema = z
  .object({
    id,
    status: z.string().min(1).max(64),
    purchaseUnits: z
      .array(
        z
          .object({
            referenceId: id,
            amountValue: money.optional(),
            currency: currency.optional(),
            payeeMerchantId: id.optional(),
            customId: id.optional(),
            items: z.array(item).max(10).optional(),
            breakdown: z
              .record(z.string().max(64), amount)
              .refine((v) => Object.keys(v).length <= 10)
              .optional(),
          })
          .strict(),
      )
      .max(10),
    captures: z
      .array(
        z
          .object({
            id,
            status: z.string().max(64),
            amountValue: money,
            currency,
            orderId: id.optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export function providerObservationFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update("payflow:provider-observation:v1\n")
    .update(JSON.stringify(ProviderObservationSchema.parse(raw)))
    .digest("hex");
}
export async function saveAuthorizationMaterial(
  db: Sql,
  receiptId: string,
  raw: unknown,
): Promise<void> {
  const [exists] =
    await db`select to_regclass('authorization_verification_material') present`;
  if (exists?.present) {
    const document = AuthorizationMaterialSchema.parse(raw);
    await db`insert into authorization_verification_material(receipt_id,document,fingerprint) values(${receiptId},${db.json(document)},${authorizationMaterialFingerprint(document)})`;
  }
}
/** Observability only: returned provider objects and existing rail decisions are
 * unchanged. A storage failure after an effect follows the rail's existing UNKNOWN
 * path. No credentials/URLs/raw payloads are retained. */
export class RecordingPaymentProvider implements PaymentProvider {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly delegate: PaymentProvider,
    private readonly clock: () => string,
  ) {}
  private async record(
    phase: "CREATE" | "GET" | "CAPTURE",
    key: string,
    order: PayPalOrderView,
  ): Promise<void> {
    const [exists] = await this.repo
      .sql`select to_regclass('paypal_provider_observations') present`;
    if (!exists?.present) return;
    const [attempt] =
      phase === "CREATE"
        ? await this.repo
            .sql`select id from payment_attempts where create_order_request_id=${key}`
        : phase === "CAPTURE"
          ? await this.repo
              .sql`select id from payment_attempts where capture_request_id=${key}`
          : await this.repo
              .sql`select id from payment_attempts where provider_order_id=${key}`;
    if (!attempt) return;
    // Adapter output is already bounded. Guard top-level arrays before projection.
    if (
      !order ||
      !Array.isArray(order.purchaseUnits) ||
      order.purchaseUnits.length > 10 ||
      !Array.isArray(order.captures) ||
      order.captures.length > 10 ||
      order.purchaseUnits.some(
        (u: PayPalOrderView["purchaseUnits"][number]) =>
          (u.items !== undefined &&
            (!Array.isArray(u.items) || u.items.length > 10)) ||
          (u.breakdown !== undefined && Object.keys(u.breakdown).length > 10),
      )
    )
      return;
    const parsed = ProviderObservationSchema.safeParse({
      id: order.id,
      status: order.status,
      purchaseUnits: order.purchaseUnits,
      captures: order.captures,
    });
    if (!parsed.success) return; // Existing rail still validates/quarantines the original.
    const document = parsed.data,
      fingerprint = providerObservationFingerprint(document),
      observationId = randomUUID(),
      now = this.clock();
    await this.repo.sql.begin(async (tx) => {
      await tx`insert into paypal_provider_observations(id,payment_attempt_id,phase,document,fingerprint,observed_at) values(${observationId},${String(attempt.id)},${phase},${tx.json(document)},${fingerprint},${now})`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYPAL_PROVIDER_OBSERVED",
        {
          paymentAttemptId: String(attempt.id),
          observationId,
          fingerprint,
          phase,
        },
        now,
      );
    });
  }
  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    const r = await this.delegate.createOrder(input);
    await this.record("CREATE", input.requestId, r);
    return r;
  }
  async getOrder(id: string): Promise<PayPalOrderView> {
    const r = await this.delegate.getOrder(id);
    await this.record("GET", id, r);
    return r;
  }
  async captureOrder(id: string, key: string): Promise<PayPalOrderView> {
    const r = await this.delegate.captureOrder(id, key);
    await this.record("CAPTURE", key, r);
    return r;
  }
}

export const QuoteRefusalSchema = z
  .object({
    quote: CheckoutQuoteSchema,
    offer: ControlledOfferSchema,
    reason: z.literal("AMOUNT_EXCEEDS_LIMIT"),
  })
  .strict();
export function quoteRefusalFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update("payflow:quote-refusal:v1\n")
    .update(JSON.stringify(QuoteRefusalSchema.parse(raw)))
    .digest("hex");
}
