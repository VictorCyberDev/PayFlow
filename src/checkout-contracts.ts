import { createHash } from "node:crypto";
import { z } from "zod";
import { ProductConditionSchema } from "./domain.js";
import {
  CommerceMoneySchema,
  ControlledOfferSchema,
  DEMO_CHECKOUT_SOURCE_ID,
  DEMO_MERCHANT_ID,
  KeyboardVariantSchema,
} from "./commerce.js";

export const CHECKOUT_QUOTE_TTL_MS = 5 * 60_000;
export const COMMERCE_METADATA_PREFIX = "payflow.commerce.";
export const COMMERCE_METADATA_KEYS = Object.freeze({
  id: "payflow.commerce.manifestId",
  version: "payflow.commerce.manifestVersion",
  fingerprint: "payflow.commerce.manifestFingerprint",
});
export function hasCommerceMetadata(
  metadata: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(metadata).some((key) =>
    key.startsWith(COMMERCE_METADATA_PREFIX),
  );
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative();
const positive = integer.positive();
const timestamp = z
  .string()
  .datetime()
  .refine(
    (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
    "NON_CANONICAL_CHECKOUT_TIME",
  );
const ownerId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const CheckoutOwnerSchema = z
  .object({
    principalId: ownerId,
    agentId: ownerId,
    mandateId: ownerId,
    mandateFingerprint: hash,
  })
  .strict();
export type CheckoutOwner = Readonly<z.infer<typeof CheckoutOwnerSchema>>;

const terms = {
  checkoutSourceId: z.literal(DEMO_CHECKOUT_SOURCE_ID),
  logicalMerchantId: z.literal(DEMO_MERCHANT_ID),
  merchantBindingRevision: positive,
  merchantBindingFingerprint: hash,
  controlledOfferFingerprint: hash,
  productFamilyId: ControlledOfferSchema.shape.productFamilyId,
  offerId: ControlledOfferSchema.shape.offerId,
  catalogRevision: positive,
  sku: ControlledOfferSchema.shape.sku,
  variant: KeyboardVariantSchema,
  // The current Foundation cannot authorize OPEN_BOX/UNKNOWN. Do not reinterpret.
  condition: ProductConditionSchema,
  quantity: positive.max(1000),
  unitAmountMinor: positive,
  subtotalMinor: positive,
  taxMinor: integer,
  shippingMinor: integer,
  customerDiscountMinor: integer,
  customerFeeMinor: integer,
  totalMinor: positive,
  currency: CommerceMoneySchema.shape.currency,
  provenanceReference: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
};
type Arithmetic = {
  quantity: number;
  unitAmountMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  customerDiscountMinor: number;
  customerFeeMinor: number;
  totalMinor: number;
};
function arithmetic(v: Arithmetic, context: z.RefinementCtx): void {
  const values = [
    v.quantity,
    v.unitAmountMinor,
    v.subtotalMinor,
    v.taxMinor,
    v.shippingMinor,
    v.customerDiscountMinor,
    v.customerFeeMinor,
    v.totalMinor,
  ];
  if (!values.every(Number.isSafeInteger)) return;
  const subtotal = BigInt(v.unitAmountMinor) * BigInt(v.quantity);
  const gross =
    subtotal +
    BigInt(v.taxMinor) +
    BigInt(v.shippingMinor) +
    BigInt(v.customerFeeMinor);
  const total = gross - BigInt(v.customerDiscountMinor);
  if (
    subtotal !== BigInt(v.subtotalMinor) ||
    total !== BigInt(v.totalMinor) ||
    total <= 0n ||
    subtotal > BigInt(Number.MAX_SAFE_INTEGER) ||
    gross > BigInt(Number.MAX_SAFE_INTEGER)
  )
    context.addIssue({
      code: "custom",
      message: "CHECKOUT_ARITHMETIC_INVALID",
    });
}
function freshness(start: string, end: string, context: z.RefinementCtx): void {
  const duration = Date.parse(end) - Date.parse(start);
  if (!(duration > 0 && duration <= CHECKOUT_QUOTE_TTL_MS))
    context.addIssue({
      code: "custom",
      message: "CHECKOUT_QUOTE_LIFETIME_INVALID",
    });
}
export const CheckoutQuoteSchema = z
  .object({
    version: z.literal("payflow.checkout-quote.v1"),
    quoteId: z.string().uuid(),
    ...terms,
    quotedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((v, c) => {
    arithmetic(v, c);
    freshness(v.quotedAt, v.expiresAt, c);
  });
export type CheckoutQuote = Readonly<z.infer<typeof CheckoutQuoteSchema>>;
export const CheckoutManifestSchema = z
  .object({
    version: z.literal("payflow.checkout-manifest.v1"),
    manifestId: z.string().uuid(),
    quoteVersion: z.literal("payflow.checkout-quote.v1"),
    quoteId: z.string().uuid(),
    ...terms,
    expectedPayPalMerchantId: z.string().regex(/^[A-Z0-9]{13}$/),
    environment: z.literal("sandbox"),
    quotedAt: timestamp,
    quoteExpiresAt: timestamp,
    owner: CheckoutOwnerSchema,
  })
  .strict()
  .superRefine((v, c) => {
    arithmetic(v, c);
    freshness(v.quotedAt, v.quoteExpiresAt, c);
  });
export type CheckoutManifest = Readonly<z.infer<typeof CheckoutManifestSchema>>;

function canonicalTerms(v: z.infer<typeof CheckoutQuoteSchema>) {
  return {
    checkoutSourceId: v.checkoutSourceId,
    logicalMerchantId: v.logicalMerchantId,
    merchantBindingRevision: v.merchantBindingRevision,
    merchantBindingFingerprint: v.merchantBindingFingerprint,
    controlledOfferFingerprint: v.controlledOfferFingerprint,
    productFamilyId: v.productFamilyId,
    offerId: v.offerId,
    catalogRevision: v.catalogRevision,
    sku: v.sku,
    variant: {
      switchType: v.variant.switchType,
      finish: v.variant.finish,
      layout: v.variant.layout,
    },
    condition: v.condition,
    quantity: v.quantity,
    unitAmountMinor: v.unitAmountMinor,
    subtotalMinor: v.subtotalMinor,
    taxMinor: v.taxMinor,
    shippingMinor: v.shippingMinor,
    customerDiscountMinor: v.customerDiscountMinor,
    customerFeeMinor: v.customerFeeMinor,
    totalMinor: v.totalMinor,
    currency: v.currency,
    provenanceReference: v.provenanceReference,
  };
}
export function canonicalCheckoutQuote(raw: unknown): string {
  const v = CheckoutQuoteSchema.parse(raw);
  return JSON.stringify({
    version: v.version,
    quoteId: v.quoteId,
    ...canonicalTerms(v),
    quotedAt: v.quotedAt,
    expiresAt: v.expiresAt,
  });
}
export function checkoutQuoteFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update("payflow:checkout-quote:v1\n" + canonicalCheckoutQuote(raw), "utf8")
    .digest("hex");
}
export function canonicalCheckoutManifest(raw: unknown): string {
  const v = CheckoutManifestSchema.parse(raw);
  return JSON.stringify({
    version: v.version,
    manifestId: v.manifestId,
    quoteVersion: v.quoteVersion,
    quoteId: v.quoteId,
    ...canonicalTerms({
      ...v,
      version: v.quoteVersion,
      expiresAt: v.quoteExpiresAt,
    }),
    expectedPayPalMerchantId: v.expectedPayPalMerchantId,
    environment: v.environment,
    quotedAt: v.quotedAt,
    quoteExpiresAt: v.quoteExpiresAt,
    owner: {
      principalId: v.owner.principalId,
      agentId: v.owner.agentId,
      mandateId: v.owner.mandateId,
      mandateFingerprint: v.owner.mandateFingerprint,
    },
  });
}
export function checkoutManifestFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update(
      "payflow:checkout-manifest:v1\n" + canonicalCheckoutManifest(raw),
      "utf8",
    )
    .digest("hex");
}
export function freezeCheckout<T extends CheckoutQuote | CheckoutManifest>(
  v: T,
): T {
  Object.freeze(v.variant);
  if ("owner" in v) Object.freeze(v.owner);
  return Object.freeze(v);
}
