import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import { DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME } from "../src/commerce.js";
import { checkoutNow } from "./checkout-fixture.js";
export function discoveryOffer(index = 0) {
  const o = demoCommerceCatalog().offers[index]!;
  return {
    offerId: `discovered.${index}`,
    productFamilyId: o.productFamilyId,
    merchantClaim: { id: DEMO_MERCHANT_ID, displayName: DEMO_MERCHANT_NAME },
    title: o.title,
    categoryClaim: "KEYBOARD",
    conditionClaim: o.condition,
    variantClaims: { ...o.variant },
    skuClaim: o.sku,
    priceObservation: { ...o.unitPrice },
    availableQuantity: o.availableQuantity,
    observedAt: checkoutNow,
    provenance: "deterministic operator demo fixture",
  };
}
export function discoveryMappings() {
  return demoCommerceCatalog().offers.map((o, index) => ({
    mappingId: `demo.mapping.${index}`,
    revision: 1,
    providerId: "demo.discovery",
    offerId: `discovered.${index}`,
    productFamilyId: o.productFamilyId,
    merchantClaimId: DEMO_MERCHANT_ID,
    controlledOfferId: o.offerId,
    sku: o.sku,
    variant: { ...o.variant },
    condition: o.condition,
  }));
}
export const discoveryQuery = { text: "Quiet keyboard", quantity: 1 };
