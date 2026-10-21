import {
  ControlledCatalogSchema,
  DEMO_CATALOG_SOURCE_ID,
  DEMO_MERCHANT_ID,
} from "./commerce.js";

/** Fictional controlled Sandbox catalog. No recipient, credentials, quote,
 * shipping/tax assertion, physical inventory proof or financial authority.
 */
export function demoCommerceCatalog() {
  const base = {
    version: "payflow.controlled-offer.v1",
    sourceId: DEMO_CATALOG_SOURCE_ID,
    productFamilyId: "pf.keyboard.quiet",
    merchantId: DEMO_MERCHANT_ID,
    catalogRevision: 1,
  };
  return ControlledCatalogSchema.parse({
    version: "payflow.controlled-catalog.v1",
    catalogRevision: 1,
    families: [
      {
        version: "payflow.product-family.v1",
        id: "pf.keyboard.quiet",
        category: "KEYBOARD",
        title: "PayFlow Demo Quiet Keyboard",
      },
    ],
    offers: [
      {
        ...base,
        offerId: "pf.offer.brown.black.new",
        sku: "PF-KB-QUIET-BROWN-BLACK",
        variant: { switchType: "BROWN", finish: "BLACK", layout: "ANSI" },
        condition: "NEW",
        unitPrice: { minor: 8400, currency: "USD" },
        availableQuantity: 10,
        title: "PayFlow Demo Keyboard — Brown / Black — NEW",
      },
      {
        ...base,
        offerId: "pf.offer.red.grey.new",
        sku: "PF-KB-QUIET-RED-GREY",
        variant: { switchType: "RED", finish: "GREY", layout: "ANSI" },
        condition: "NEW",
        unitPrice: { minor: 8900, currency: "USD" },
        availableQuantity: 5,
        title: "PayFlow Demo Keyboard — Red / Grey — NEW",
      },
      {
        ...base,
        offerId: "pf.offer.brown.black.used",
        sku: "PF-KB-QUIET-BROWN-BLACK-USED",
        variant: { switchType: "BROWN", finish: "BLACK", layout: "ANSI" },
        condition: "USED",
        unitPrice: { minor: 4900, currency: "USD" },
        availableQuantity: 1,
        title: "PayFlow Demo Keyboard — Brown / Black — USED",
      },
    ],
  });
}
