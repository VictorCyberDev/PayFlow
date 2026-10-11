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
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  StaticPublicKeyRing,
  type ExecutionGrantClaims,
} from "../src/execution-grant.js";
import {
  PayPalExecutionRail,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { FakeControlledCommerceSource } from "../src/controlled-commerce.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import {
  checkoutAuthority,
  checkoutBinding,
  checkoutNow,
} from "./checkout-fixture.js";
import { checkoutManifestFingerprint } from "../src/checkout-contracts.js";

const url = process.env.TEST_DATABASE_URL;
class Provider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  input?: Parameters<PaymentProvider["createOrder"]>[0];
  order?: PayPalOrderView;
  attack?: string;
  loseCapture = false;
  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.createCalls++;
    this.input = input;
    const r = input.commerce!;
    this.order = {
      id: "ORDER-1",
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
    if (this.attack) {
      const u = { ...this.order.purchaseUnits[0]! };
      if (this.attack === "amount") u.amountValue = "184.00";
      if (this.attack === "currency") u.currency = "EUR";
      if (this.attack === "recipient") u.payeeMerchantId = "DEMOACCOUNT02";
      if (this.attack === "sku")
        u.items = [{ ...u.items![0]!, sku: "PF-OTHER" }];
      if (this.attack === "quantity")
        u.items = [{ ...u.items![0]!, quantity: "10" }];
      if (this.attack === "missing") delete u.payeeMerchantId;
      this.order = { ...this.order, purchaseUnits: [u] };
    }
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
          id: "CAPTURE-1",
          status: "COMPLETED",
          amountValue: "84.00",
          currency: "USD",
          orderId: id,
        },
      ],
    };
    if (this.loseCapture) throw new Error("lost response");
    return this.order;
  }
}
(url ? describe : describe.skip)(
  "M4C real PostgreSQL execution conformance",
  () => {
    let repo: PostgresTrustRepository, other: PostgresTrustRepository;
    let checkout: DurableCheckoutService,
      provider: Provider,
      rail: PayPalExecutionRail,
      boundary: ExecutionBoundary;
    let token: string, manifestId: string, proposalId: string;
    let time: string;
    const keys = generateKeyPairSync("ed25519");
    const ring = new StaticPublicKeyRing(new Map([["m4c", keys.publicKey]]));
    const clock = () => time;
    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      other = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
    });
    afterAll(async () => {
      await repo?.close();
      await other?.close();
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      time = checkoutNow;
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      const f = checkoutAuthority();
      await repo.savePrincipal({
        id: f.mandate.principalId,
        displayName: "Human",
      });
      await repo.saveAgent(f.agent);
      await repo.saveMandate(f.mandate);
      const source = new FakeControlledCommerceSource(
        checkoutBinding,
        demoCommerceCatalog(),
      );
      checkout = new DurableCheckoutService(repo, source, () => new Date(time));
      await checkout.registerMerchantBinding();
      const q = await checkout.issueQuote(
        source.listControlledOffers()[0],
        f.mandate.id,
        1,
      );
      const m = await checkout.sealManifest(q.quoteId);
      manifestId = m.manifestId;
      const p = await checkout.compileManifestProposal(m.manifestId);
      proposalId = p.id;
      const result = await new DurableAuthorizationService(
        repo,
      ).authorizeProposal(p.id, "LOW", time);
      expect(result.receipt.decision).toBe("ALLOW");
      time = "2026-10-11T00:04:00.000Z";
      token = await new ExecutionGrantIssuer(
        repo,
        "m4c",
        keys.privateKey,
      ).issue(result.reservation!.id, time);
      provider = new Provider();
      rail = new PayPalExecutionRail(repo, provider, clock);
      boundary = new ExecutionBoundary(repo, ring, rail);
    });
    it("$84 NEW keyboard traverses the actual signed boundary and commits verified evidence", async () => {
      expect(await boundary.execute(token, time)).toEqual({
        executionId: "CAPTURE-1",
      });
      expect(provider.input).toMatchObject({
        amountValue: "84.00",
        currency: "USD",
        merchantReference: proposalId,
        commerce: {
          payee: { merchant_id: "DEMOACCOUNT01" },
          custom_id: manifestId,
          items: [
            {
              quantity: "1",
              sku: (await checkout.getManifest(manifestId)).sku,
            },
          ],
        },
      });
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
      expect(
        (await repo.sql`select status from authorization_reservations`)[0]!
          .status,
      ).toBe("COMMITTED");
      expect(
        PostgresTrustRepository.verifyEvidence(await repo.evidence()),
      ).toBe(true);
      await expect(boundary.execute(token, time)).rejects.toThrow(
        "EXECUTION_GRANT_CONSUMED",
      );
      expect(provider.captureCalls).toBe(1);
    });
    it.each([
      "fingerprint",
      "principal",
      "agent",
      "mandate",
      "recipient",
      "amount",
      "currency",
      "quantity",
      "condition",
      "sku",
      "variant",
      "offer",
      "family",
      "quote",
    ])("corrupt %s manifest cannot dispatch", async (attack) => {
      const m = { ...structuredClone(await checkout.getManifest(manifestId)) };
      if (attack === "principal") m.owner.principalId = "other";
      if (attack === "agent") m.owner.agentId = "other";
      if (attack === "mandate") m.owner.mandateId = "other";
      if (attack === "recipient") m.expectedPayPalMerchantId = "DEMOACCOUNT02";
      if (attack === "amount") {
        m.unitAmountMinor = 18400;
        m.subtotalMinor = 18400;
        m.totalMinor = 18400;
      }
      if (attack === "currency") m.currency = "EUR";
      if (attack === "quantity") {
        m.quantity = 10;
        m.subtotalMinor = 84000;
        m.totalMinor = 84000;
      }
      if (attack === "condition") m.condition = "USED";
      if (attack === "sku") m.sku = "PF-OTHER";
      if (attack === "variant") m.variant.switchType = "RED";
      if (attack === "offer") m.offerId = "other";
      if (attack === "family") m.productFamilyId = "other";
      if (attack === "quote")
        m.quoteId = "00000000-0000-4000-8000-000000000099";
      await repo.sql`alter table checkout_manifests disable trigger immutable_checkout_manifest`;
      try {
        await repo.sql`update checkout_manifests set document=${repo.sql.json(m)},document_hash=encode(sha256(convert_to(${repo.sql.json(m)}::jsonb::text,'UTF8')),'hex'),fingerprint=${attack === "fingerprint" ? "f".repeat(64) : checkoutManifestFingerprint(m)} where id=${manifestId}`;
      } finally {
        await repo.sql`alter table checkout_manifests enable trigger immutable_checkout_manifest`;
      }
      await expect(boundary.execute(token, time)).rejects.toThrow();
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
    });
    it.each([
      "expired",
      "binding",
      "disabled",
      "suspended",
      "revoked",
      "capability",
    ])("current %s state rejects with zero effects", async (attack) => {
      if (attack === "expired") time = "2026-10-11T00:05:00.000Z";
      if (attack === "binding") {
        const source = new FakeControlledCommerceSource(
          { ...checkoutBinding, bindingRevision: 2 },
          demoCommerceCatalog(),
        );
        await new DurableCheckoutService(
          other,
          source,
          () => new Date(time),
        ).registerMerchantBinding();
      }
      if (attack === "disabled")
        await repo.sql`update principals set status='DISABLED'`;
      if (attack === "suspended") {
        await repo.sql`update agent_passports set status='SUSPENDED'`;
      }
      if (attack === "revoked") await repo.revokeMandate("commerce-m", time);
      if (attack === "capability") {
        await repo.sql`update agent_passports set capabilities='["CREATE_ORDER"]'::jsonb`;
      }
      await expect(boundary.execute(token, time)).rejects.toThrow();
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
    });
    it.each(["amount", "currency", "recipient", "sku", "quantity", "missing"])(
      "provider %s conflict is durably quarantined with no capture/retry",
      async (attack) => {
        provider.attack = attack;
        await expect(boundary.execute(token, time)).rejects.toThrow();
        expect(provider.createCalls).toBe(1);
        expect(provider.captureCalls).toBe(0);
        const a = (
          await repo.sql`select id,failure_classification from payment_attempts`
        )[0]!;
        expect(String(a.failure_classification)).toMatch(/^COMMERCE_/);
        await expect(
          new PayPalExecutionRail(other, provider, clock).reconcile(
            String(a.id),
            time,
          ),
        ).rejects.toThrow("COMMERCE_PROVIDER_MISMATCH_QUARANTINED");
        expect(provider.createCalls).toBe(1);
        expect(provider.captureCalls).toBe(0);
        expect(
          PostgresTrustRepository.verifyEvidence(await repo.evidence()),
        ).toBe(true);
      },
    );
    it("lost capture recovers observed success after quote expiry without releasing or recapturing", async () => {
      provider.loseCapture = true;
      await expect(boundary.execute(token, time)).rejects.toThrow();
      const a = (await repo.sql`select id,status from payment_attempts`)[0]!;
      expect(a.status).toBe("CAPTURE_UNKNOWN");
      time = "2026-10-11T00:06:00.000Z";
      expect(
        await new PayPalExecutionRail(other, provider, clock).reconcile(
          String(a.id),
          time,
        ),
      ).toBe("CAPTURED");
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
    });
    it("two independent PostgreSQL boundaries cannot dispatch duplicate authority", async () => {
      const second = new ExecutionBoundary(
        other,
        ring,
        new PayPalExecutionRail(other, provider, clock),
      );
      const results = await Promise.allSettled([
        boundary.execute(token, time),
        second.execute(token, time),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
    });
    it.each([
      "manifest",
      "quote",
      "metadata",
      "category",
      "digest",
      "linked-manifest",
    ])("durable %s corruption cannot reach provider", async (attack) => {
      await repo.sql.begin(async (tx) => {
        await tx`set local session_replication_role='replica'`;
        if (attack === "manifest") await tx`delete from checkout_manifests`;
        if (attack === "quote") await tx`delete from commerce_quotes`;
        if (attack === "metadata")
          await tx`update transaction_proposals set document=jsonb_set(document,'{metadata}','{}')`;
        if (attack === "category")
          await tx`update transaction_proposals set document=jsonb_set(document,'{category}','"LAPTOP"')`;
        if (attack === "digest")
          await tx`update checkout_manifest_proposals set proposal_digest=${"f".repeat(64)}`;
        if (attack === "linked-manifest")
          await tx`update checkout_manifest_proposals set manifest_id='00000000-0000-4000-8000-000000000099'`;
      });
      await expect(boundary.execute(token, time)).rejects.toThrow();
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
    });
    it("restart after verified create preserves order and captures only that identity", async () => {
      const original = provider.createOrder.bind(provider);
      vi.spyOn(provider, "createOrder").mockImplementation(async (input) => {
        const order = await original(input);
        provider.order = { ...order, status: "CREATED" };
        return provider.order;
      });
      await expect(boundary.execute(token, time)).rejects.toThrow(
        "PAYER_ACTION_REQUIRED",
      );
      const a = (
        await repo.sql`select id,provider_order_id from payment_attempts`
      )[0]!;
      expect(a.provider_order_id).toBe("ORDER-1");
      provider.order = { ...provider.order!, status: "APPROVED" };
      expect(
        await new PayPalExecutionRail(other, provider, clock).reconcile(
          String(a.id),
          time,
        ),
      ).toBe("CAPTURED");
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
    });
    it("restart before provider handoff revalidates the claimed durable commerce", async () => {
      const append = repo.appendEvidenceInTransaction.bind(repo);
      vi.spyOn(repo, "appendEvidenceInTransaction").mockImplementation(
        async (...args) => {
          if (args[1] === "PAYPAL_OPERATION_DISPATCHED")
            throw new Error("restart");
          return append(...args);
        },
      );
      await expect(boundary.execute(token, time)).rejects.toThrow();
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
      vi.restoreAllMocks();
      const a = (await repo.sql`select id from payment_attempts`)[0]!;
      expect(
        await new PayPalExecutionRail(other, provider, clock).reconcile(
          String(a.id),
          time,
        ),
      ).toBe("CAPTURED");
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
    });
    it("recovery provider mismatch quarantines without another capture", async () => {
      provider.loseCapture = true;
      await expect(boundary.execute(token, time)).rejects.toThrow();
      const a = (await repo.sql`select id from payment_attempts`)[0]!;
      provider.order = {
        ...provider.order!,
        purchaseUnits: [
          {
            ...provider.order!.purchaseUnits[0]!,
            payeeMerchantId: "DEMOACCOUNT02",
          },
        ],
      };
      await expect(
        new PayPalExecutionRail(other, provider, clock).reconcile(
          String(a.id),
          time,
        ),
      ).rejects.toThrow("COMMERCE_RECIPIENT_MISMATCH");
      await expect(rail.reconcile(String(a.id), time)).rejects.toThrow(
        "COMMERCE_PROVIDER_MISMATCH_QUARANTINED",
      );
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
    });
    it("direct rail invocation cannot fabricate the durable claim", async () => {
      const claims = JSON.parse(
        Buffer.from(token.split(".")[0]!, "base64url").toString(),
      ) as ExecutionGrantClaims;
      await expect(rail.execute(claims)).rejects.toThrow(
        "PAYMENT_GRANT_NOT_CLAIMED",
      );
      expect(provider.createCalls).toBe(0);
      expect(provider.captureCalls).toBe(0);
    });
  },
);
