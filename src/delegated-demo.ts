import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { DurableCheckoutService } from "./checkout.js";
import {
  CommerceDiscoveryEngine,
  ControlledDiscoveryResolver,
  FakeCommerceRanker,
  FakeDiscoveryProvider,
} from "./commerce-discovery.js";
import { DEMO_MERCHANT_ID, DEMO_MERCHANT_NAME } from "./commerce.js";
import { FakeControlledCommerceSource } from "./controlled-commerce.js";
import { demoCommerceCatalog } from "./demo-commerce-catalog.js";
import {
  DelegatedCommerceService,
  type DelegatedOutcome,
} from "./delegated-commerce.js";
import { DiscoveryCheckoutService } from "./discovery-checkout.js";
import { DurableAuthorizationService } from "./durable-service.js";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  StaticPublicKeyRing,
} from "./execution-grant.js";
import { PayPalExecutionRail, type PaymentProvider } from "./paypal.js";
import type { PostgresTrustRepository } from "./persistence.js";

export const DemoScenarioSchema = z.enum(["VALID_PURCHASE", "PRICE_DRIFT"]);
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;

/** Operator-provisioned grant signing key. Public keys are retained so Activity can verify history. */
export interface DemoSigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/**
 * NON-PRODUCTION demonstration of an Agent shopping under an existing Authority.
 *
 * The Agent here is a fixed, server-side simulation: it "discovers" the controlled demo catalog and
 * proposes. Everything after that is the real M1–M5 pipeline through DelegatedCommerceService. The
 * Agent never decides, widens or bypasses anything. The browser can only name a scenario.
 *
 * PRICE_DRIFT models a merchant whose trusted price changed after discovery ($84 observed, $184
 * trusted). VALID_PURCHASE needs a connected Sandbox payment rail; without one it is refused
 * before any record is written.
 */
export class DemoShoppingAgent {
  readonly keys: StaticPublicKeyRing;
  constructor(
    private readonly deps: Readonly<{
      repo: PostgresTrustRepository;
      /** null = no payment rail is configured: purchases cannot run, blocked scenarios still can. */
      provider: PaymentProvider | null;
      /** Optional durable readiness check (for example, an owner-vaulted Sandbox instrument). */
      paymentReady?: () => Promise<boolean>;
      signing: DemoSigningKey;
      expectedPayPalMerchantId: string;
      clock: () => Date;
    }>,
  ) {
    this.keys = new StaticPublicKeyRing(
      new Map([[deps.signing.kid, deps.signing.publicKey]]),
    );
  }
  /** Backwards-compatible configuration signal. Hosted status uses paymentAvailable(). */
  get paymentConnected(): boolean {
    return this.deps.provider !== null;
  }
  async paymentAvailable(): Promise<boolean> {
    if (!this.deps.provider) return false;
    return this.deps.paymentReady ? this.deps.paymentReady() : true;
  }
  private binding() {
    return {
      version: "payflow.merchant-binding.v1",
      logicalMerchantId: DEMO_MERCHANT_ID,
      checkoutSourceId: "payflow.demo.checkout",
      bindingRevision: 1,
      environment: "sandbox",
      expectedPayPalMerchantId: this.deps.expectedPayPalMerchantId,
      active: true,
    };
  }
  private observations() {
    const observedAt = this.deps.clock().toISOString();
    return demoCommerceCatalog().offers.map((o, i) => ({
      offerId: `discovered.${i}`,
      productFamilyId: o.productFamilyId,
      merchantClaim: { id: DEMO_MERCHANT_ID, displayName: DEMO_MERCHANT_NAME },
      title: o.title,
      categoryClaim: "KEYBOARD",
      conditionClaim: o.condition,
      variantClaims: { ...o.variant },
      skuClaim: o.sku,
      priceObservation: { ...o.unitPrice },
      availableQuantity: o.availableQuantity,
      observedAt,
      provenance: "controlled demo discovery",
    }));
  }
  private mappings() {
    return demoCommerceCatalog().offers.map((o, i) => ({
      mappingId: `demo.mapping.${i}`,
      revision: 1,
      providerId: "demo.discovery",
      offerId: `discovered.${i}`,
      productFamilyId: o.productFamilyId,
      merchantClaimId: DEMO_MERCHANT_ID,
      controlledOfferId: o.offerId,
      sku: o.sku,
      variant: { ...o.variant },
      condition: o.condition,
    }));
  }
  private stack(catalog: ReturnType<typeof demoCommerceCatalog>) {
    const { repo, clock } = this.deps;
    const source = new FakeControlledCommerceSource(this.binding(), catalog);
    const checkout = new DurableCheckoutService(repo, source, clock);
    const resolver = new ControlledDiscoveryResolver(source, this.mappings());
    const engine = new CommerceDiscoveryEngine(
      [new FakeDiscoveryProvider("demo.discovery", this.observations())],
      resolver,
      clock,
    );
    const discovery = new DiscoveryCheckoutService(
      repo,
      engine,
      resolver,
      checkout,
      clock,
    );
    return { checkout, discovery };
  }

  /**
   * System responsibility, not a customer control: resolve any payment whose outcome was uncertain
   * by asking the provider what actually happened (read-before-act). It can only finish an attempt
   * that already holds a grant; it never starts a purchase and never retries a lost call blindly.
   */
  async reconcileOutstanding(): Promise<number> {
    const { repo, provider, clock } = this.deps;
    if (!provider) return 0;
    const rail = new PayPalExecutionRail(repo, provider, () =>
      clock().toISOString(),
    );
    let resolved = 0;
    for (const id of await rail.reconciliationCandidates()) {
      try {
        await rail.reconcile(id, clock().toISOString());
        resolved++;
      } catch {
        /* stays quarantined; the next pass tries again */
      }
    }
    return resolved;
  }

  async run(
    mandateId: string,
    scenario: DemoScenario,
  ): Promise<DelegatedOutcome> {
    const { repo, provider, signing, clock } = this.deps;
    DemoScenarioSchema.parse(scenario);
    if (scenario === "VALID_PURCHASE" && !(await this.paymentAvailable()))
      return Object.freeze({
        status: "REFUSED",
        code: "PAYMENT_RAIL_NOT_CONNECTED",
        proposalId: null,
        operationId: null,
        askedHuman: false,
        providerEffect: "NONE",
      } as const);
    const normal = this.stack(demoCommerceCatalog());
    await normal.checkout.registerMerchantBinding();
    let discovery = normal.discovery;
    if (scenario === "PRICE_DRIFT") {
      const drifted = demoCommerceCatalog();
      drifted.offers[0]!.unitPrice.minor = 18400;
      const later = this.stack(drifted);
      // Selection happens against the discovered $84; the merchant's trusted quote says $184.
      discovery = {
        selectForCheckout: (
          ...a: Parameters<typeof normal.discovery.selectForCheckout>
        ) => normal.discovery.selectForCheckout(...a),
        quoteSelection: (id: string) => later.discovery.quoteSelection(id),
      } as typeof normal.discovery;
    }
    // A rail-less run can only reach the Gate; this guard makes a provider call impossible.
    const rail = new PayPalExecutionRail(
      repo,
      provider ?? refusingProvider,
      () => clock().toISOString(),
    );
    const service = new DelegatedCommerceService({
      discovery,
      checkout: normal.checkout,
      authorizer: new DurableAuthorizationService(repo),
      issuer: new ExecutionGrantIssuer(repo, signing.kid, signing.privateKey),
      boundary: new ExecutionBoundary(repo, this.keys, rail),
      merchantRisk: "LOW",
      clock: () => clock().toISOString(),
    });
    return service.attempt({
      mandateId,
      query: { text: "Quiet keyboard", quantity: 1 },
      ranker: new FakeCommerceRanker(),
    });
  }
}

/** Fails closed on any provider call. Used only when no payment rail is connected. */
const refusingProvider: PaymentProvider = {
  createOrder: () => Promise.reject(new Error("PAYMENT_RAIL_NOT_CONNECTED")),
  getOrder: () => Promise.reject(new Error("PAYMENT_RAIL_NOT_CONNECTED")),
  captureOrder: () => Promise.reject(new Error("PAYMENT_RAIL_NOT_CONNECTED")),
};
