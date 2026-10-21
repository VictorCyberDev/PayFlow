import {
  COMMERCE_LIMITS,
  ControlledCatalogSchema,
  DEMO_MERCHANT_NAME,
  DiscoveryOfferSchema,
  MerchantBindingSchema,
  controlledOfferFingerprint,
  merchantBindingFingerprint,
  type ControlledOfferData,
  type DiscoveryOffer,
  type MerchantBinding,
} from "./commerce.js";

declare const controlledOfferBrand: unique symbol;
export type ControlledOffer = ControlledOfferData & {
  readonly [controlledOfferBrand]: true;
};
export type CheckoutSupport =
  | {
      readonly status: "SUPPORTED_CHECKOUT";
      readonly offerFingerprint: string;
      readonly bindingFingerprint: string;
      readonly binding: MerchantBinding;
    }
  | {
      readonly status: "DISCOVERY_ONLY";
      readonly reason: "CHECKOUT_NOT_SUPPORTED" | "MERCHANT_BINDING_INACTIVE";
    };

function freezeOffer(offer: ControlledOfferData): ControlledOffer {
  Object.freeze(offer.variant);
  Object.freeze(offer.unitPrice);
  return Object.freeze(offer) as ControlledOffer;
}

/** Trusted HOST composition only. Inputs are operator-provisioned configuration,
 * never request/model/discovery input. Parsing validates shape, NOT provenance.
 * Per-instance membership prevents copied/parsed/foreign offers from promoting
 * themselves. This source has no authentication or financial operations.
 */
export class FakeControlledCommerceSource {
  readonly merchantDisplayName = DEMO_MERCHANT_NAME;
  readonly #binding: MerchantBinding;
  readonly #bindingFingerprint: string;
  readonly #catalog: ReturnType<typeof ControlledCatalogSchema.parse>;
  readonly #offers: ReadonlyMap<string, ControlledOffer>;
  readonly #issued = new WeakSet<object>();

  constructor(operatorBinding: unknown, operatorCatalog: unknown) {
    this.#binding = Object.freeze(MerchantBindingSchema.parse(operatorBinding));
    this.#bindingFingerprint = merchantBindingFingerprint(this.#binding);
    // Reject oversized collections before Zod visits individual elements.
    if (operatorCatalog !== null && typeof operatorCatalog === "object") {
      const raw = operatorCatalog as Record<string, unknown>;
      if (
        (Array.isArray(raw.families) &&
          raw.families.length > COMMERCE_LIMITS.families) ||
        (Array.isArray(raw.offers) &&
          raw.offers.length > COMMERCE_LIMITS.offers)
      )
        throw new Error("COMMERCE_CATALOG_LIMIT");
    }
    const catalog = ControlledCatalogSchema.parse(operatorCatalog);
    this.#catalog = catalog;
    this.#offers = new Map(
      catalog.offers.map((offer) => {
        const issued = freezeOffer(offer);
        this.#issued.add(issued);
        return [issued.offerId, issued];
      }),
    );
  }

  getControlledOffer(offerId: string): ControlledOffer | undefined {
    // Bounded exact lookup; product-family IDs and titles are not selectors.
    if (offerId.length > COMMERCE_LIMITS.identifier) return undefined;
    return this.#offers.get(offerId);
  }

  listControlledOffers(): readonly ControlledOffer[] {
    return Object.freeze([...this.#offers.values()]);
  }

  getMerchantBinding(): MerchantBinding {
    return this.#binding;
  }

  /** Trusted operator replacement only; old handles retain their old binding. */
  withMerchantBinding(operatorBinding: unknown): FakeControlledCommerceSource {
    const next = MerchantBindingSchema.parse(operatorBinding);
    if (next.bindingRevision <= this.#binding.bindingRevision)
      throw new Error("MERCHANT_BINDING_REVISION_REQUIRED");
    return new FakeControlledCommerceSource(next, this.#catalog);
  }

  resolveCheckoutSupport(candidate: unknown): CheckoutSupport {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !this.#issued.has(candidate)
    )
      return { status: "DISCOVERY_ONLY", reason: "CHECKOUT_NOT_SUPPORTED" };
    if (!this.#binding.active)
      return { status: "DISCOVERY_ONLY", reason: "MERCHANT_BINDING_INACTIVE" };
    return {
      status: "SUPPORTED_CHECKOUT",
      offerFingerprint: controlledOfferFingerprint(candidate),
      bindingFingerprint: this.#bindingFingerprint,
      binding: this.#binding,
    };
  }
}

/** Bounded fake discovery that exercises the same untrusted schema. */
export class FakeCommerceDiscoveryProvider {
  readonly #offers: readonly DiscoveryOffer[];
  constructor(observations: readonly unknown[]) {
    if (observations.length > COMMERCE_LIMITS.offers)
      throw new Error("COMMERCE_CATALOG_LIMIT");
    this.#offers = Object.freeze(
      observations.map((raw) => {
        const offer = DiscoveryOfferSchema.parse(raw);
        Object.freeze(offer.merchantClaim);
        Object.freeze(offer.unitPrice);
        return Object.freeze(offer);
      }),
    );
  }
  listOffers(): readonly DiscoveryOffer[] {
    return this.#offers;
  }
}
