import {
  merchantBindingFingerprint,
  controlledOfferFingerprint,
} from "../src/commerce.js";
import {
  CheckoutQuoteSchema,
  CheckoutManifestSchema,
} from "../src/checkout-contracts.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import { mandateFingerprint } from "../src/canonical.js";
import type { AgentPassport, Mandate } from "../src/domain.js";
export const checkoutBinding = {
  version: "payflow.merchant-binding.v1",
  logicalMerchantId: "payflow.demo.merchant",
  checkoutSourceId: "payflow.demo.checkout",
  bindingRevision: 1,
  environment: "sandbox",
  expectedPayPalMerchantId: "DEMOACCOUNT01",
  active: true,
};
export const checkoutNow = "2026-10-11T00:00:00.000Z";
export function checkoutAuthority(): {
  mandate: Mandate;
  agent: AgentPassport;
} {
  const mandate: Mandate = {
    id: "commerce-m",
    principalId: "commerce-p",
    authorizedAgentId: "commerce-a",
    purpose: "One controlled keyboard",
    category: "KEYBOARD",
    currency: "USD",
    maxSingleTransactionMinor: 9999,
    cumulativeLimitMinor: 9999,
    quantityLimit: 1,
    merchantScope: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "LOW",
    autonomousPurchaseThresholdMinor: 9999,
    humanApprovalThresholdMinor: 9999,
    allowedCapabilities: ["CAPTURE_PAYMENT"],
    version: 1,
    nonce: "commerce-mandate-nonce",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
  };
  return {
    mandate,
    agent: {
      id: mandate.authorizedAgentId,
      principalId: mandate.principalId,
      displayName: "Demo Agent",
      issuedAt: mandate.createdAt,
      expiresAt: mandate.expiresAt,
      status: "ACTIVE",
      capabilities: ["CAPTURE_PAYMENT"],
    },
  };
}
export function checkoutFixture() {
  const offer = demoCommerceCatalog().offers[0]!;
  const quote = CheckoutQuoteSchema.parse({
    version: "payflow.checkout-quote.v1",
    quoteId: "00000000-0000-4000-8000-000000000001",
    checkoutSourceId: checkoutBinding.checkoutSourceId,
    logicalMerchantId: checkoutBinding.logicalMerchantId,
    merchantBindingRevision: 1,
    merchantBindingFingerprint: merchantBindingFingerprint(checkoutBinding),
    controlledOfferFingerprint: controlledOfferFingerprint(offer),
    productFamilyId: offer.productFamilyId,
    offerId: offer.offerId,
    catalogRevision: offer.catalogRevision,
    sku: offer.sku,
    variant: offer.variant,
    condition: offer.condition,
    quantity: 1,
    unitAmountMinor: 8400,
    subtotalMinor: 8400,
    taxMinor: 0,
    shippingMinor: 0,
    customerDiscountMinor: 0,
    customerFeeMinor: 0,
    totalMinor: 8400,
    currency: "USD",
    quotedAt: checkoutNow,
    expiresAt: "2026-10-11T00:05:00.000Z",
    provenanceReference: offer.sourceId + "/" + offer.offerId,
  });
  const { expiresAt, version, ...rest } = quote;
  const { mandate } = checkoutAuthority();
  const manifest = CheckoutManifestSchema.parse({
    ...rest,
    version: "payflow.checkout-manifest.v1",
    manifestId: "00000000-0000-4000-8000-000000000002",
    quoteVersion: version,
    quoteExpiresAt: expiresAt,
    environment: "sandbox",
    expectedPayPalMerchantId: checkoutBinding.expectedPayPalMerchantId,
    owner: {
      principalId: mandate.principalId,
      agentId: mandate.authorizedAgentId,
      mandateId: mandate.id,
      mandateFingerprint: mandateFingerprint(mandate),
    },
  });
  return { offer, quote, manifest };
}
