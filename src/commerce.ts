import { createHash } from "node:crypto";
import { z } from "zod";
import { MoneySchema } from "./domain.js";

export const COMMERCE_LIMITS = Object.freeze({
  identifier: 96,
  sku: 64,
  title: 160,
  families: 5,
  offers: 20,
  availableQuantity: 100000,
});
export const DEMO_MERCHANT_ID = "payflow.demo.merchant";
export const DEMO_MERCHANT_NAME = "PayFlow Demo Merchant — Sandbox";
export const DEMO_CHECKOUT_SOURCE_ID = "payflow.demo.checkout";
export const DEMO_CATALOG_SOURCE_ID = "payflow.demo.catalog";

// Exact ASCII identifiers; no display-name folding or Unicode equivalence.
const identifier = z
  .string()
  .min(1)
  .max(COMMERCE_LIMITS.identifier)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision = z.number().int().safe().positive();
const title = z.string().min(1).max(COMMERCE_LIMITS.title);
const availableQuantity = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(COMMERCE_LIMITS.availableQuantity);

// Reuse the financial money shape, but do not alter the Foundation schema.
// This is the supported currency set already used by intent compilation.
export const CommerceMoneySchema = MoneySchema.extend({
  currency: z.enum(["USD", "EUR", "GBP", "AUD", "CAD", "JPY"]),
  minor: MoneySchema.shape.minor.positive(),
});
export const CommerceConditionSchema = z.enum([
  "NEW",
  "USED",
  "REFURBISHED",
  "OPEN_BOX",
  "UNKNOWN",
]);
export const KeyboardVariantSchema = z
  .object({
    switchType: z.enum(["BROWN", "RED"]),
    finish: z.enum(["BLACK", "GREY"]),
    layout: z.literal("ANSI"),
  })
  .strict();
export const MerchantBindingSchema = z
  .object({
    version: z.literal("payflow.merchant-binding.v1"),
    logicalMerchantId: z.literal(DEMO_MERCHANT_ID),
    checkoutSourceId: z.literal(DEMO_CHECKOUT_SOURCE_ID),
    bindingRevision: revision,
    environment: z.literal("sandbox"),
    // Expected account identifier, NOT provider-verified recipient evidence.
    expectedPayPalMerchantId: z.string().regex(/^[A-Z0-9]{13}$/),
    active: z.boolean(),
  })
  .strict();
export type MerchantBinding = Readonly<z.infer<typeof MerchantBindingSchema>>;

export const ProductFamilySchema = z
  .object({
    version: z.literal("payflow.product-family.v1"),
    id: identifier,
    category: z.literal("KEYBOARD"),
    title,
  })
  .strict();
export const ControlledOfferSchema = z
  .object({
    version: z.literal("payflow.controlled-offer.v1"),
    sourceId: z.literal(DEMO_CATALOG_SOURCE_ID),
    productFamilyId: identifier,
    offerId: identifier,
    merchantId: z.literal(DEMO_MERCHANT_ID),
    sku: z
      .string()
      .min(1)
      .max(COMMERCE_LIMITS.sku)
      .regex(/^PF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/),
    variant: KeyboardVariantSchema,
    condition: CommerceConditionSchema,
    unitPrice: CommerceMoneySchema,
    availableQuantity,
    catalogRevision: revision,
    title,
  })
  .strict();
export type ControlledOfferData = Readonly<
  z.infer<typeof ControlledOfferSchema>
>;

/** A schema-valid observation remains untrusted, including merchant claims. */
export const DiscoveryOfferSchema = z
  .object({
    version: z.literal("payflow.discovery-offer.v1"),
    trust: z.literal("UNTRUSTED_DISCOVERY"),
    sourceId: identifier,
    offerId: identifier,
    productFamilyId: identifier,
    merchantClaim: z.object({ id: identifier, displayName: title }).strict(),
    condition: CommerceConditionSchema,
    unitPrice: CommerceMoneySchema,
    availableQuantity,
    title,
  })
  .strict();
export type DiscoveryOffer = Readonly<z.infer<typeof DiscoveryOfferSchema>>;

export const ControlledCatalogSchema = z
  .object({
    version: z.literal("payflow.controlled-catalog.v1"),
    catalogRevision: revision,
    families: z.array(ProductFamilySchema).min(1).max(COMMERCE_LIMITS.families),
    offers: z.array(ControlledOfferSchema).min(1).max(COMMERCE_LIMITS.offers),
  })
  .strict()
  .superRefine((catalog, context) => {
    const families = new Set(catalog.families.map((family) => family.id));
    const ids = new Set<string>();
    const skus = new Set<string>();
    if (families.size !== catalog.families.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_PRODUCT_FAMILY" });
    for (const offer of catalog.offers) {
      if (
        !families.has(offer.productFamilyId) ||
        offer.catalogRevision !== catalog.catalogRevision ||
        ids.has(offer.offerId) ||
        skus.has(offer.sku)
      )
        context.addIssue({
          code: "custom",
          message: "INVALID_CATALOG_RELATION",
        });
      ids.add(offer.offerId);
      skus.add(offer.sku);
    }
  });

// Fixed projection/order avoids locale-dependent sorting. Parsing bounds all
// fields before JSON serialization or hashing. Titles are display-only.
export function canonicalControlledOffer(raw: unknown): string {
  const offer = ControlledOfferSchema.parse(raw);
  return JSON.stringify({
    version: offer.version,
    sourceId: offer.sourceId,
    productFamilyId: offer.productFamilyId,
    offerId: offer.offerId,
    merchantId: offer.merchantId,
    sku: offer.sku,
    variant: {
      switchType: offer.variant.switchType,
      finish: offer.variant.finish,
      layout: offer.variant.layout,
    },
    condition: offer.condition,
    unitPrice: {
      currency: offer.unitPrice.currency,
      minor: offer.unitPrice.minor,
    },
    availableQuantity: offer.availableQuantity,
    catalogRevision: offer.catalogRevision,
  });
}
export function controlledOfferFingerprint(raw: unknown): string {
  const canonical = canonicalControlledOffer(raw);
  return createHash("sha256")
    .update("payflow:commerce-offer:v1\n", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}
export function merchantBindingFingerprint(raw: unknown): string {
  const binding = MerchantBindingSchema.parse(raw);
  return createHash("sha256")
    .update("payflow:merchant-binding:v1\n", "utf8")
    .update(
      JSON.stringify({
        version: binding.version,
        logicalMerchantId: binding.logicalMerchantId,
        checkoutSourceId: binding.checkoutSourceId,
        bindingRevision: binding.bindingRevision,
        environment: binding.environment,
        expectedPayPalMerchantId: binding.expectedPayPalMerchantId,
        active: binding.active,
      }),
      "utf8",
    )
    .digest("hex");
}
