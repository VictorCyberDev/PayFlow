import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { PostgresTrustRepository } from "../src/persistence.js";
import { DurableCheckoutService } from "../src/checkout.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
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
import { mandateFingerprint } from "../src/canonical.js";
class Provider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  order?: PayPalOrderView;
  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.createCalls++;
    const r = input.commerce!;
    this.order = {
      id: "M4E-ORDER-1",
      status: "APPROVED",
      purchaseUnits: [
        {
          referenceId: input.merchantReference,
          amountValue: input.amountValue,
          currency: input.currency,
          payeeMerchantId: r.payee.merchant_id,
          customId: r.custom_id,
          items: r.items,
          breakdown: r.breakdown,
        },
      ],
      captures: [],
    };
    return this.order;
  }
  async getOrder(id: string): Promise<PayPalOrderView> {
    await Promise.resolve();
    expect(id).toBe(this.order!.id);
    return this.order!;
  }
  async captureOrder(id: string): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.captureCalls++;
    expect(id).toBe(this.order!.id);
    this.order = {
      ...this.order!,
      status: "COMPLETED",
      captures: [
        {
          id: "M4E-CAPTURE-1",
          status: "COMPLETED",
          amountValue: this.order!.purchaseUnits[0]!.amountValue!,
          currency: this.order!.purchaseUnits[0]!.currency!,
          orderId: id,
        },
      ],
    };
    return this.order;
  }
}
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M4E durable discovery provenance (real PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository, other: PostgresTrustRepository;
    let source: FakeControlledCommerceSource,
      checkout: DurableCheckoutService,
      resolver: ControlledDiscoveryResolver,
      engine: CommerceDiscoveryEngine,
      service: DiscoveryCheckoutService;
    let authorizer: DurableAuthorizationService,
      issuer: ExecutionGrantIssuer,
      boundary: ExecutionBoundary,
      provider: Provider;
    let time: Date, observations: ReturnType<typeof discoveryOffer>[];
    const clock = () => new Date(time),
      keys = generateKeyPairSync("ed25519");
    const ranker = new FakeCommerceRanker();
    let counters: ReturnType<typeof instruments>;
    function instruments() {
      return {
        promotion: vi.spyOn(resolver, "resolve"),
        quote: vi.spyOn(checkout, "issueQuote"),
        manifest: vi.spyOn(checkout, "sealManifest"),
        proposal: vi.spyOn(checkout, "compileManifestProposal"),
        authorization: vi.spyOn(authorizer, "authorizeProposal"),
        grant: vi.spyOn(issuer, "issue"),
        create: vi.spyOn(provider, "createOrder"),
        capture: vi.spyOn(provider, "captureOrder"),
      };
    }
    function zero(afterPromotion = false) {
      for (const [name, counter] of Object.entries(counters))
        if (name !== "promotion" || !afterPromotion)
          expect(counter, `${name} calls`).not.toHaveBeenCalled();
    }
    async function emptyFinancial() {
      for (const table of [
        "commerce_quotes",
        "checkout_manifests",
        "transaction_proposals",
        "decision_receipts",
        "authorization_reservations",
        "execution_grants",
        "payment_attempts",
      ]) {
        const name = table;
        expect(
          await repo.sql.unsafe(`select * from ${name}`),
          name,
        ).toHaveLength(0);
      }
    }
    async function pipeline(rankerOverride: CommerceRanker = ranker) {
      const id = await service.selectForCheckout(
        "commerce-m",
        discoveryQuery,
        rankerOverride,
      );
      const q = await service.quoteSelection(id),
        m = await checkout.sealManifest(q.quoteId),
        p = await checkout.compileManifestProposal(m.manifestId);
      const auth = await authorizer.authorizeProposal(
        p.id,
        "LOW",
        clock().toISOString(),
      );
      if (auth.receipt.decision !== "ALLOW") return { q, p, auth };
      const token = await issuer.issue(
        auth.reservation!.id,
        clock().toISOString(),
      );
      await boundary.execute(token, clock().toISOString());
      return { q, p, auth };
    }
    function worker(
      db: PostgresTrustRepository,
      catalog = demoCommerceCatalog(),
      mappings: unknown[] = discoveryMappings(),
      providerOffers: unknown[] = observations,
    ) {
      const s = new FakeControlledCommerceSource(checkoutBinding, catalog),
        c = new DurableCheckoutService(db, s, clock),
        r = new ControlledDiscoveryResolver(s, mappings),
        e = new CommerceDiscoveryEngine(
          [new FakeDiscoveryProvider("demo.discovery", providerOffers)],
          r,
          clock,
        );
      return {
        service: new DiscoveryCheckoutService(db, e, r, c, clock),
        checkout: c,
        resolver: r,
        engine: e,
        source: s,
      };
    }
    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      other = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        if (name.startsWith("008")) {
          const f = checkoutAuthority();
          await repo.savePrincipal({
            id: f.mandate.principalId,
            displayName: "Upgrade human",
          });
          await repo.saveAgent(f.agent);
          await repo.saveMandate(f.mandate);
        }
        await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
      }
      expect(mandateFingerprint((await repo.getMandate("commerce-m"))!)).toBe(
        mandateFingerprint(checkoutAuthority().mandate),
      );
      expect(
        await repo.sql`select * from commerce_discovery_selections`,
      ).toHaveLength(0);
    });
    afterAll(async () => {
      await repo?.close();
      await other?.close();
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      time = new Date(checkoutNow);
      observations = [discoveryOffer()];
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      const f = checkoutAuthority();
      await repo.savePrincipal({
        id: f.mandate.principalId,
        displayName: "Human",
      });
      await repo.saveAgent(f.agent);
      await repo.saveMandate(f.mandate);
      ({ source, checkout, resolver, engine, service } = worker(repo));
      await checkout.registerMerchantBinding();
      authorizer = new DurableAuthorizationService(repo);
      issuer = new ExecutionGrantIssuer(repo, "m4e", keys.privateKey);
      provider = new Provider();
      boundary = new ExecutionBoundary(
        repo,
        new StaticPublicKeyRing(new Map([["m4e", keys.publicKey]])),
        new PayPalExecutionRail(repo, provider, () => clock().toISOString()),
      );
      counters = instruments();
    });
    it("selected $84 NEW observation traverses the existing quote/Kernel/grant/PayPal boundary with valid evidence", async () => {
      const result = await pipeline();
      expect(result.p.amount.minor).toBe(8400);
      expect(result.auth.receipt.decision).toBe("ALLOW");
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
      const evidence = await repo.evidence();
      expect(PostgresTrustRepository.verifyEvidence(evidence)).toBe(true);
      expect(evidence.map((e) => e.type)).toContain(
        "COMMERCE_DISCOVERY_SELECTED",
      );
      expect(evidence.map((e) => e.type)).toContain(
        "COMMERCE_DISCOVERY_RESOLVED",
      );
      expect(JSON.stringify(evidence)).not.toContain(
        "deterministic operator demo fixture",
      );
      expect(JSON.stringify(evidence)).not.toMatch(
        /access_token|client_secret|authenticationAssertion/,
      );
    });
    it.each([
      "invented",
      "extras",
      "malformed",
      "oversized",
      "error",
      "cross-request",
      "ineligible",
    ])(
      "%s AI result stops before promotion and all financial boundaries",
      async (attack) => {
        let otherId = "a".repeat(64);
        if (attack === "cross-request")
          otherId = (
            await engine.select(
              checkoutAuthority().mandate,
              discoveryQuery,
              ranker,
            )
          ).candidate.candidateId;
        const malicious: CommerceRanker = {
          rank: async (input) => {
            await Promise.resolve();
            if (attack === "error") throw new Error("provider unavailable");
            if (attack === "extras")
              return {
                candidateId: input.candidates[0]!.candidateId,
                authorized: true,
                amount: 1,
                merchant: "attacker",
                sku: "attacker",
                condition: "NEW",
              };
            if (attack === "malformed") return "{";
            if (attack === "oversized") return "x".repeat(65536);
            return { candidateId: otherId };
          },
        };
        await expect(pipeline(malicious)).rejects.toThrow(/COMMERCE_/);
        zero();
        await emptyFinancial();
        expect(
          await repo.sql`select * from commerce_discovery_selections`,
        ).toHaveLength(0);
      },
    );
    it("USED offer is absent before the ranker runs; malicious preference cannot promote it", async () => {
      observations.push(discoveryOffer(2));
      ({ source, checkout, resolver, engine, service } = worker(repo));
      counters = instruments();
      const rank = vi.fn<CommerceRanker["rank"]>(async (i) => {
        await Promise.resolve();
        expect(i.candidates.map((c) => c.offer.condition)).toEqual(["NEW"]);
        expect(
          i.candidates.some((c) => c.offer.offerId === "discovered.2"),
        ).toBe(false);
        return { candidateId: "b".repeat(64) };
      });
      await expect(pipeline({ rank })).rejects.toThrow(
        "COMMERCE_CANDIDATE_NOT_IN_REQUEST",
      );
      expect(rank).toHaveBeenCalledTimes(1);
      zero();
      await emptyFinancial();
    });
    it("external retailer remains discovery-only; matching Demo name/SKU/price without mapping cannot promote", async () => {
      observations[0] = { ...discoveryOffer(), offerId: "unmapped" };
      ({ source, checkout, resolver, engine, service } = worker(repo));
      counters = instruments();
      const recommendation = await service
        .recommend("commerce-m", discoveryQuery, ranker)
        .catch(() => null);
      expect(recommendation).toBeNull(); // ONLY merchant authority needs an independently supported relationship.
      await expect(pipeline()).rejects.toThrow(
        "NO_ELIGIBLE_DISCOVERY_CANDIDATES",
      );
      zero();
      await emptyFinancial();
    });
    it("observation survives restart identically and provider refresh cannot replace its price or identity", async () => {
      const id = await service.selectForCheckout(
        "commerce-m",
        discoveryQuery,
        ranker,
      );
      const [before] =
        await repo.sql`select document from commerce_discovery_selections where id=${id}`;
      observations[0] = {
        ...discoveryOffer(1),
        priceObservation: { minor: 1, currency: "EUR" },
        conditionClaim: "USED",
        merchantClaim: { id: "other", displayName: "other" },
        availableQuantity: 0,
      };
      await other.close();
      other = PostgresTrustRepository.connect(url!);
      const next = worker(other);
      const q = await next.service.quoteSelection(id);
      const [after] =
        await other.sql`select document from commerce_discovery_selections where id=${id}`;
      expect(after!.document).toEqual(before!.document);
      expect(q.totalMinor).toBe(8400);
      expect(q.sku).toBe(discoveryOffer().skuClaim);
      expect(await next.service.quoteSelection(id)).toEqual(q);
      expect(await repo.sql`select * from commerce_quotes`).toHaveLength(1);
      expect(await repo.sql`select * from checkout_manifests`).toHaveLength(0);
    });
    const corruptions = [
      ["providerId", ["offer", "providerId"], "other.provider"],
      ["offerId", ["offer", "offerId"], "other.offer"],
      ["candidateId", ["candidateId"], "a".repeat(64)],
      ["condition", ["offer", "condition"], "USED"],
      ["price", ["offer", "priceObservation", "minor"], 1],
      ["currency", ["offer", "priceObservation", "currency"], "EUR"],
      ["merchant", ["offer", "merchantClaim", "id"], "attacker"],
      ["variant", ["offer", "variantClaims", "switchType"], "RED"],
      ["fingerprint", ["discoveryFingerprint"], "a".repeat(64)],
      ["mapping", ["mappingId"], "other.mapping"],
      ["mappingRevision", ["mappingRevision"], 2],
      ["controlledOffer", ["controlledOffer", "offerId"], "other.offer"],
      ["request", ["requestId"], "00000000-0000-4000-8000-000000000099"],
      ["principal", ["principalId"], "other.principal"],
      ["promotion", ["promotionStatus"], "DISCOVERY_ONLY"],
      ["quantity", ["quantity"], 10],
    ] as const;
    it.each(corruptions)(
      "detects persisted %s corruption before quote/manifest/proposal/authority/provider",
      async (_name, path, value) => {
        const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        );
        vi.clearAllMocks();
        await repo.sql.begin(async (tx) => {
          await tx`alter table commerce_discovery_selections disable trigger immutable_discovery_selection`;
          await tx`update commerce_discovery_selections set document=jsonb_set(document,${[...path]}::text[],${tx.json(value)}) where id=${id}`;
          await tx`alter table commerce_discovery_selections enable trigger immutable_discovery_selection`;
        });
        await expect(service.quoteSelection(id)).rejects.toThrow(
          "DISCOVERY_SELECTION_CORRUPT",
        );
        zero();
        await emptyFinancial();
      },
    );
    it.each(["request_id", "candidate_id", "document_hash"])(
      "detects redundant durable column corruption %s",
      async (column) => {
        const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        );
        vi.clearAllMocks();
        const value =
          column === "request_id"
            ? "00000000-0000-4000-8000-000000000099"
            : "c".repeat(64);
        await repo.sql.begin(async (tx) => {
          await tx`alter table commerce_discovery_selections disable trigger immutable_discovery_selection`;
          await tx.unsafe(
            `update commerce_discovery_selections set ${column}=$1 where id=$2`,
            [value, id],
          );
          await tx`alter table commerce_discovery_selections enable trigger immutable_discovery_selection`;
        });
        await expect(service.quoteSelection(id)).rejects.toThrow(
          "DISCOVERY_SELECTION_CORRUPT",
        );
        zero();
        await emptyFinancial();
      },
    );
    it("persisted candidate A cannot enter request B after process restart", async () => {
      const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        ),
        [row] =
          await repo.sql`select candidate_id from commerce_discovery_selections where id=${id}`;
      const next = worker(other);
      const promotion = vi.spyOn(next.resolver, "resolve"),
        quote = vi.spyOn(next.checkout, "issueQuote");
      vi.clearAllMocks();
      await expect(
        next.service.selectForCheckout("commerce-m", discoveryQuery, {
          rank: () =>
            Promise.resolve({ candidateId: String(row!.candidate_id) }),
        }),
      ).rejects.toThrow("COMMERCE_CANDIDATE_NOT_IN_REQUEST");
      expect(promotion).not.toHaveBeenCalled();
      expect(quote).not.toHaveBeenCalled();
      zero();
      await emptyFinancial();
      expect(
        await repo.sql`select * from commerce_discovery_selections`,
      ).toHaveLength(1);
    });
    it("immutable snapshots and quote links reject updates/deletes", async () => {
      const id = await service.selectForCheckout(
        "commerce-m",
        discoveryQuery,
        ranker,
      );
      await service.quoteSelection(id);
      await expect(
        repo.sql`delete from commerce_discovery_selections where id=${id}`,
      ).rejects.toThrow("DISCOVERY_PROVENANCE_IMMUTABLE");
      await expect(
        repo.sql`update commerce_discovery_quote_links set mapping_fingerprint=${"a".repeat(64)} where selection_id=${id}`,
      ).rejects.toThrow("DISCOVERY_PROVENANCE_IMMUTABLE");
    });
    it("two independent PostgreSQL workers resume one selection into one linked quote", async () => {
      const id = await service.selectForCheckout(
        "commerce-m",
        discoveryQuery,
        ranker,
      );
      vi.clearAllMocks();
      const next = worker(other),
        otherQuote = vi.spyOn(next.checkout, "issueQuote");
      const [a, b] = await Promise.all([
        service.quoteSelection(id),
        next.service.quoteSelection(id),
      ]);
      expect(a).toEqual(b);
      expect(
        counters.quote.mock.calls.length + otherQuote.mock.calls.length,
      ).toBe(1);
      expect(
        await repo.sql`select * from commerce_discovery_quote_links`,
      ).toHaveLength(1);
      expect(await repo.sql`select * from commerce_quotes`).toHaveLength(1);
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
    });
    it("concurrent selections of one observation retain independent request identities and the same pinned promotion", async () => {
      const next = worker(other),
        [a, b] = await Promise.all([
          service.selectForCheckout("commerce-m", discoveryQuery, ranker),
          next.service.selectForCheckout("commerce-m", discoveryQuery, ranker),
        ]);
      const rows =
        await repo.sql`select document,request_id,candidate_id from commerce_discovery_selections where id in (${a},${b})`;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.request_id).not.toBe(rows[1]!.request_id);
      expect(rows[0]!.candidate_id).not.toBe(rows[1]!.candidate_id);
      const left = rows[0]!.document as Record<string, unknown>,
        right = rows[1]!.document as Record<string, unknown>;
      expect(left.discoveryFingerprint).toBe(right.discoveryFingerprint);
      expect(left.mappingFingerprint).toBe(right.mappingFingerprint);
      await emptyFinancial();
    });
    it("old selection cannot be reinterpreted by a new operator mapping revision", async () => {
      const id = await service.selectForCheckout(
        "commerce-m",
        discoveryQuery,
        ranker,
      );
      vi.clearAllMocks();
      const mappings = discoveryMappings();
      mappings[0]!.revision = 2;
      const next = worker(other, demoCommerceCatalog(), mappings),
        quote = vi.spyOn(next.checkout, "issueQuote");
      await expect(next.service.quoteSelection(id)).rejects.toThrow(
        "DISCOVERY_RELATIONSHIP_CHANGED",
      );
      expect(quote).not.toHaveBeenCalled();
      await emptyFinancial();
    });
    it("mapping replacement race between ranking and persistence fails without a promotion record or quote", async () => {
      const mappings = discoveryMappings();
      mappings[0]!.revision = 2;
      const replacement = new ControlledDiscoveryResolver(source, mappings);
      const mismatched = new DiscoveryCheckoutService(
        repo,
        engine,
        replacement,
        checkout,
        clock,
      );
      await expect(
        mismatched.selectForCheckout("commerce-m", discoveryQuery, ranker),
      ).rejects.toThrow("DISCOVERY_CHECKOUT_UNAVAILABLE");
      expect(
        await repo.sql`select * from commerce_discovery_selections`,
      ).toHaveLength(0);
      await emptyFinancial();
    });
    it.each(["sku", "variant", "offer"])(
      "trusted source %s substitution fails closed on restart",
      async (attack) => {
        const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        );
        vi.clearAllMocks();
        const catalog = demoCommerceCatalog();
        if (attack === "sku") catalog.offers[0]!.sku = "PF-KB-OTHER-SKU";
        if (attack === "variant") catalog.offers[0]!.variant.switchType = "RED";
        if (attack === "offer") catalog.offers[0]!.offerId = "OTHER-OFFER";
        const next = worker(other, catalog),
          quote = vi.spyOn(next.checkout, "issueQuote");
        await expect(next.service.quoteSelection(id)).rejects.toThrow(
          "DISCOVERY_RELATIONSHIP_CHANGED",
        );
        expect(quote).not.toHaveBeenCalled();
        await emptyFinancial();
      },
    );
    it("fresh trusted $89 quote replaces neither the immutable $84 observation nor its identity", async () => {
      const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        ),
        catalog = demoCommerceCatalog();
      catalog.offers[0]!.unitPrice.minor = 8900;
      const next = worker(other, catalog),
        q = await next.service.quoteSelection(id),
        m = await next.checkout.sealManifest(q.quoteId),
        p = await next.checkout.compileManifestProposal(m.manifestId);
      expect(q.totalMinor).toBe(8900);
      expect(p.amount.minor).toBe(8900);
      const result = await authorizer.authorizeProposal(
        p.id,
        "LOW",
        checkoutNow,
      );
      expect(result.receipt.amount.minor).toBe(8900);
      expect(result.receipt.decision).toBe("ALLOW");
      const [row] =
        await repo.sql`select document from commerce_discovery_selections where id=${id}`;
      expect(
        (row!.document as { offer: { priceObservation: { minor: number } } })
          .offer.priceObservation.minor,
      ).toBe(8400);
    });
    it("discovery $84 / trusted $184 hits existing M4B budget rejection; no manifest/proposal/provider", async () => {
      const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        ),
        catalog = demoCommerceCatalog();
      catalog.offers[0]!.unitPrice.minor = 18400;
      const next = worker(other, catalog);
      await expect(next.service.quoteSelection(id)).rejects.toThrow(
        "AMOUNT_EXCEEDS_LIMIT",
      );
      await emptyFinancial();
      expect(provider.captureCalls).toBe(0);
    });
    it("under a sufficient mandate the actual quote/proposal/authorization sees $184, never observed $84", async () => {
      const f = checkoutAuthority();
      Object.assign(f.mandate, {
        maxSingleTransactionMinor: 20000,
        cumulativeLimitMinor: 20000,
        autonomousPurchaseThresholdMinor: 20000,
        humanApprovalThresholdMinor: 20000,
      });
      f.mandate = {
        ...f.mandate,
        id: "commerce-wide",
        nonce: "commerce-wide-nonce",
      };
      await repo.saveMandate(f.mandate);
      const id = await service.selectForCheckout(
          "commerce-wide",
          discoveryQuery,
          ranker,
        ),
        catalog = demoCommerceCatalog();
      catalog.offers[0]!.unitPrice.minor = 18400;
      const next = worker(other, catalog),
        q = await next.service.quoteSelection(id),
        m = await next.checkout.sealManifest(q.quoteId),
        p = await next.checkout.compileManifestProposal(m.manifestId),
        result = await authorizer.authorizeProposal(p.id, "LOW", checkoutNow);
      expect(q.totalMinor).toBe(18400);
      expect(p.amount.minor).toBe(18400);
      expect(result.receipt.amount.minor).toBe(18400);
      expect(provider.captureCalls).toBe(0);
    });
    it.each(["expiry", "revocation"])(
      "selected observation cannot survive authority/freshness %s into a new quote",
      async (attack) => {
        const id = await service.selectForCheckout(
          "commerce-m",
          discoveryQuery,
          ranker,
        );
        vi.clearAllMocks();
        if (attack === "expiry") time = new Date("2026-10-11T00:05:00.000Z");
        else await repo.revokeMandate("commerce-m", checkoutNow);
        await expect(service.quoteSelection(id)).rejects.toThrow();
        zero();
        await emptyFinancial();
      },
    );
  },
);
