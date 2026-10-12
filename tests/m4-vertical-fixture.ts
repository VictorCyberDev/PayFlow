import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { PostgresTrustRepository } from "../src/persistence.js";
import { DurableCheckoutService } from "../src/checkout.js";
import { DiscoveryCheckoutService } from "../src/discovery-checkout.js";
import {
  CommerceDiscoveryEngine,
  ControlledDiscoveryResolver,
  FakeDiscoveryProvider,
  FakeCommerceRanker,
  type CommerceRanker,
} from "../src/commerce-discovery.js";
import { FakeControlledCommerceSource } from "../src/controlled-commerce.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import {
  PayPalExecutionRail,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { OperationTraceService } from "../src/operation-trace.js";
import { HumanConfirmationBoundary } from "../src/intent-activation.js";
import { PaymentResumeService } from "../src/payment-resume.js";
import {
  checkoutAuthority,
  checkoutBinding,
  checkoutNow,
} from "./checkout-fixture.js";
import {
  discoveryOffer,
  discoveryMappings,
  discoveryQuery,
} from "./discovery-fixture.js";
export class VerticalProvider implements PaymentProvider {
  orderId = "VERTICAL-ORDER";
  createCalls = 0;
  captureCalls = 0;
  uniqueOrders = 0;
  loseCreate = false;
  loseCapture = false;
  payer = true;
  mismatch?: "recipient" | "amount" | "currency" | "sku" | "quantity";
  order?: PayPalOrderView;
  createKeys: string[] = [];
  captureKeys: string[] = [];
  async createOrder(
    i: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.createCalls++;
    this.createKeys.push(i.requestId);
    if (!this.order) {
      this.uniqueOrders++;
      const r = i.commerce!;
      this.order = {
        id: this.orderId,
        status: this.payer ? "PAYER_ACTION_REQUIRED" : "APPROVED",
        ...(this.payer
          ? {
              payerActionUrl:
                "https://www.sandbox.paypal.com/checkoutnow?token=" +
                this.orderId,
            }
          : {}),
        purchaseUnits: [
          {
            referenceId: i.merchantReference,
            amountValue: i.amountValue,
            currency: i.currency,
            payeeMerchantId: r.payee.merchant_id,
            customId: r.custom_id,
            items: r.items,
            breakdown: r.breakdown,
          },
        ],
        captures: [],
      };
    }
    if (this.loseCreate) {
      this.loseCreate = false;
      throw new Error("RESPONSE_LOST");
    }
    return this.view();
  }
  private view(): PayPalOrderView {
    const copy = structuredClone(this.order!);
    if (this.mismatch) {
      const u = copy.purchaseUnits[0]!;
      if (this.mismatch === "recipient") u.payeeMerchantId = "DEMOACCOUNT02";
      if (this.mismatch === "amount") u.amountValue = "184.00";
      if (this.mismatch === "currency") u.currency = "EUR";
      if (this.mismatch === "sku")
        u.items = [{ ...u.items![0]!, sku: "PF-KB-OTHER" }];
      if (this.mismatch === "quantity")
        u.items = [{ ...u.items![0]!, quantity: "2" }];
    }
    return copy;
  }
  async getOrder(id: string): Promise<PayPalOrderView> {
    await Promise.resolve();
    if (id !== this.order!.id) throw new Error("ORDER_SUBSTITUTION");
    return this.view();
  }
  async captureOrder(id: string, key: string): Promise<PayPalOrderView> {
    await Promise.resolve();
    if (id !== this.order!.id) throw new Error("ORDER_SUBSTITUTION");
    this.captureCalls++;
    this.captureKeys.push(key);
    const o = this.order!;
    this.order = {
      id: o.id,
      status: "COMPLETED",
      purchaseUnits: o.purchaseUnits,
      captures: [
        {
          id: "VERTICAL-CAPTURE",
          status: "COMPLETED",
          amountValue: o.purchaseUnits[0]!.amountValue!,
          currency: o.purchaseUnits[0]!.currency!,
          orderId: id,
        },
      ],
    };
    if (this.loseCapture) {
      this.loseCapture = false;
      throw new Error("RESPONSE_LOST");
    }
    return this.view();
  }
  approve() {
    const o = this.order!;
    this.order = {
      id: o.id,
      status: "APPROVED",
      purchaseUnits: o.purchaseUnits,
      captures: o.captures,
    };
  }
}
export class VerticalSession {
  time = checkoutNow;
  keys = generateKeyPairSync("ed25519");
  provider = new VerticalProvider();
  source: FakeControlledCommerceSource;
  checkout: DurableCheckoutService;
  discovery: DiscoveryCheckoutService;
  resolver: ControlledDiscoveryResolver;
  engine: CommerceDiscoveryEngine;
  authorizer: DurableAuthorizationService;
  issuer: ExecutionGrantIssuer;
  rail: PayPalExecutionRail;
  boundary: ExecutionBoundary;
  trace: OperationTraceService;
  selectionId?: string;
  quoteId?: string;
  proposalId?: string;
  token?: string;
  attemptId?: string;
  secret?: string;
  constructor(
    readonly repo: PostgresTrustRepository,
    observations: unknown[] = [
      discoveryOffer(),
      discoveryOffer(2),
      { ...discoveryOffer(), offerId: "unknown", conditionClaim: "UNKNOWN" },
      {
        ...discoveryOffer(),
        offerId: "external",
        merchantClaim: { id: "external", displayName: "External retailer" },
      },
    ],
    catalog = demoCommerceCatalog(),
    mappings: unknown[] = discoveryMappings(),
    readonly mandateId = "commerce-m",
    signingKeys?: { publicKey: KeyObject; privateKey: KeyObject },
  ) {
    if (signingKeys) this.keys = signingKeys;
    this.source = new FakeControlledCommerceSource(checkoutBinding, catalog);
    this.checkout = new DurableCheckoutService(
      repo,
      this.source,
      () => new Date(this.time),
    );
    this.resolver = new ControlledDiscoveryResolver(this.source, mappings);
    this.engine = new CommerceDiscoveryEngine(
      [new FakeDiscoveryProvider("demo.discovery", observations)],
      this.resolver,
      () => new Date(this.time),
    );
    this.discovery = new DiscoveryCheckoutService(
      repo,
      this.engine,
      this.resolver,
      this.checkout,
      () => new Date(this.time),
    );
    this.authorizer = new DurableAuthorizationService(repo);
    this.issuer = new ExecutionGrantIssuer(repo, "m4f", this.keys.privateKey);
    this.rail = new PayPalExecutionRail(repo, this.provider, () => this.time);
    const ring = new StaticPublicKeyRing(
      new Map([["m4f", this.keys.publicKey]]),
    );
    this.boundary = new ExecutionBoundary(repo, ring, this.rail);
    this.trace = new OperationTraceService(repo, ring);
  }
  async provision() {
    const f = checkoutAuthority();
    await this.repo.savePrincipal({
      id: f.mandate.principalId,
      displayName: "Human",
    });
    await this.repo.saveAgent(f.agent);
    await this.repo.saveMandate(f.mandate);
    await this.checkout.registerMerchantBinding();
  }
  async select(ranker: CommerceRanker = new FakeCommerceRanker()) {
    this.selectionId = await this.discovery.selectForCheckout(
      this.mandateId,
      discoveryQuery,
      ranker,
    );
    return this.selectionId;
  }
  async seal() {
    if (!this.selectionId) await this.select();
    const q = await this.discovery.quoteSelection(this.selectionId!);
    this.quoteId = q.quoteId;
    const m = await this.checkout.sealManifest(q.quoteId),
      p = await this.checkout.compileManifestProposal(m.manifestId);
    this.proposalId = p.id;
    return p;
  }
  async authorize() {
    const p = this.proposalId
      ? await this.repo.getProposal(this.proposalId)
      : await this.seal();
    const r = await this.authorizer.authorizeProposal(p!.id, "LOW", this.time);
    if (r.reservation)
      this.token = await this.issuer.issue(r.reservation.id, this.time);
    return r;
  }
  async execute() {
    if (!this.token) await this.authorize();
    try {
      return await this.boundary.execute(this.token!, this.time);
    } finally {
      const [a] = await this.repo
        .sql`select id from payment_attempts where proposal_id=${this.proposalId!}`;
      if (a) this.attemptId = String(a.id);
    }
  }
  human(repository = this.repo, rail = this.rail) {
    return new PaymentResumeService(
      repository,
      new HumanConfirmationBoundary(
        {
          verify: async (proof) => {
            await Promise.resolve();
            return {
              principalId:
                proof === "human-fixture-assertion"
                  ? "commerce-p"
                  : "foreign-principal",
              actor: "HUMAN",
              authenticatedAt: this.time,
              expiresAt: new Date(Date.parse(this.time) + 300000).toISOString(),
            };
          },
        },
        () => new Date(this.time),
      ),
      rail,
      () => new Date(this.time),
    );
  }
  async prepare() {
    const p = await this.human().prepare(
      this.attemptId!,
      "human-fixture-assertion",
    );
    this.secret = p.resumeSecret;
    return p;
  }
  async resume(
    raw: unknown = { resumeSecret: this.secret },
    assertion: unknown = "human-fixture-assertion",
  ) {
    return this.human().resume(raw, assertion);
  }
  project() {
    return this.trace.project(
      this.proposalId
        ? { proposalId: this.proposalId }
        : this.quoteId
          ? { quoteId: this.quoteId }
          : { selectionId: this.selectionId! },
      this.time,
    );
  }
}
