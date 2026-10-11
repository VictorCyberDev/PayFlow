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

const url = process.env.TEST_DATABASE_URL;
class Provider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  input?: Parameters<PaymentProvider["createOrder"]>[0];
  order?: PayPalOrderView;
  getCalls = 0;
  captureKeys: string[] = [];
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
      status: "PAYER_ACTION_REQUIRED",
      payerActionUrl:
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
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
    this.getCalls++;
    expect(id).toBe(this.order!.id);
    return this.order!;
  }
  async captureOrder(id: string, requestId: string): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.captureCalls++;
    this.captureKeys.push(requestId);
    expect(id).toBe(this.order!.id);
    const previous = { ...this.order! };
    delete previous.payerActionUrl;
    this.order = {
      ...previous,
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
import {
  PaymentResumeService,
  paymentResumeDigest,
} from "../src/payment-resume.js";
import {
  HumanConfirmationBoundary,
  type HumanActionBinding,
} from "../src/intent-activation.js";
(url ? describe : describe.skip)("M4D PostgreSQL secure payer resume", () => {
  let repo: PostgresTrustRepository, other: PostgresTrustRepository;
  let checkout: DurableCheckoutService,
    provider: Provider,
    rail: PayPalExecutionRail,
    boundary: ExecutionBoundary;
  let token: string, proposalId: string;
  let time: string;
  let attemptId: string, secret: string, expiresAt: string;
  let service: PaymentResumeService;
  let bindings: HumanActionBinding[];
  function human(repository = repo, selectedRail = rail) {
    const boundary = new HumanConfirmationBoundary(
      {
        verify: async (proof, binding) => {
          await Promise.resolve();
          bindings.push(binding);
          if (proof !== "commerce-p" && proof !== "foreign-principal")
            throw new Error("AUTHENTICATION_REQUIRED");
          return {
            principalId: proof,
            actor: "HUMAN",
            authenticatedAt: time,
            expiresAt: new Date(Date.parse(time) + 300000).toISOString(),
          };
        },
      },
      () => new Date(time),
    );
    return new PaymentResumeService(
      repository,
      boundary,
      selectedRail,
      () => new Date(time),
    );
  }
  function approve() {
    const previous = { ...provider.order! };
    delete previous.payerActionUrl;
    provider.order = {
      ...previous,
      status: "APPROVED",
    };
  }
  async function resume(
    raw: unknown = { resumeSecret: secret },
    proof: unknown = "commerce-p",
  ) {
    return service.resume(raw, proof);
  }
  async function unchanged() {
    const [a] =
      await repo.sql`select * from payment_attempts where id=${attemptId}`;
    expect(provider.createCalls).toBe(1);
    expect(a!.provider_order_id).toBe("ORDER-1");
    expect(a!.create_order_request_id).toBe(provider.input!.requestId);
    expect(provider.captureKeys.every((k) => k === a!.capture_request_id)).toBe(
      true,
    );
    expect(
      (await repo.sql`select count(*)::int n from payment_attempts`)[0]!.n,
    ).toBe(1);
    expect(
      (await repo.sql`select count(*)::int n from execution_grants`)[0]!.n,
    ).toBe(1);
    expect(
      (
        await repo.sql`select count(*)::int n from authorization_reservations`
      )[0]!.n,
    ).toBe(1);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  }
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
  beforeEach(async (context) => {
    vi.restoreAllMocks();
    time = checkoutNow;
    await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
    bindings = [];
    const f = checkoutAuthority();
    if (context.task.name.includes("expired mandate"))
      f.mandate = { ...f.mandate, expiresAt: "2026-10-11T00:04:30.000Z" };
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
    const p = await checkout.compileManifestProposal(m.manifestId);
    proposalId = p.id;
    const result = await new DurableAuthorizationService(
      repo,
      context.task.name.includes("expired reservation") ? 270000 : 900000,
    ).authorizeProposal(p.id, "LOW", time);
    expect(result.receipt.decision).toBe("ALLOW");
    time = "2026-10-11T00:04:00.000Z";
    token = await new ExecutionGrantIssuer(
      repo,
      "m4c",
      keys.privateKey,
      context.task.name.includes("expired grant") ? 30000 : 120000,
    ).issue(result.reservation!.id, time);
    provider = new Provider();
    rail = new PayPalExecutionRail(repo, provider, clock);
    boundary = new ExecutionBoundary(repo, ring, rail);
    await expect(boundary.execute(token, time)).rejects.toThrow(
      "PAYER_ACTION_REQUIRED",
    );
    const [a] = await repo.sql`select id from payment_attempts`;
    attemptId = String(a!.id);
    service = human();
    const prepared = await service.prepare(attemptId, "commerce-p");
    secret = prepared.resumeSecret;
    expiresAt = prepared.expiresAt;
    expect(provider.captureCalls).toBe(0);
  });

  it("normal secure resume retrieves provider approval and commits existing authority", async () => {
    approve();
    expect(
      await resume({ resumeSecret: secret, returnedOrderId: "ORDER-1" }),
    ).toBe("CAPTURED");
    expect(provider.getCalls).toBe(1);
    expect(provider.captureCalls).toBe(1);
    expect(bindings.at(-1)).toMatchObject({
      action: "RESUME_PAYMENT",
      paymentAttemptId: attemptId,
      proposalId,
      paypalOrderId: "ORDER-1",
      agentId: "commerce-a",
      challengeHash: paymentResumeDigest(secret),
    });
    await unchanged();
  });
  it.each(["CREATED", "PAYER_ACTION_REQUIRED", "SAVED"])(
    "browser return cannot approve server-side %s",
    async (status) => {
      provider.order = { ...provider.order!, status };
      expect(await resume()).toBe("PAYER_ACTION_REQUIRED");
      expect(provider.getCalls).toBe(1);
      expect(provider.captureCalls).toBe(0);
      await unchanged();
    },
  );
  it.each([
    "approved",
    "status",
    "amount",
    "currency",
    "merchant",
    "sku",
    "PayerID",
    "token",
    "manifestId",
    "proposalId",
  ])("rejects browser financial field %s before dispatch", async (field) => {
    await expect(
      resume({
        resumeSecret: secret,
        [field]: field === "approved" ? true : "COMPLETED",
      }),
    ).rejects.toThrow("SECURE_RESUME_REJECTED");
    expect(provider.getCalls).toBe(0);
    expect(provider.captureCalls).toBe(0);
    await unchanged();
  });
  it.each([
    "revoked mandate",
    "disabled principal",
    "suspended agent",
    "expired mandate",
    "expired grant",
    "expired reservation",
    "expired quote",
    "changed binding",
    "removed capability",
  ])("approved provider cannot resurrect %s", async (attack) => {
    if (attack === "revoked mandate")
      await repo.revokeMandate("commerce-m", time);
    if (attack === "disabled principal")
      await repo.sql`update principals set status='DISABLED'`;
    if (attack === "suspended agent")
      await repo.sql`update agent_passports set status='SUSPENDED'`;
    if (attack === "removed capability")
      await repo.sql`update agent_passports set capabilities='["CREATE_ORDER"]'::jsonb`;
    if (attack === "expired mandate" || attack === "expired reservation")
      time = "2026-10-11T00:04:31.000Z";
    if (attack === "expired quote") time = "2026-10-11T00:05:01.000Z";
    if (attack === "expired grant") time = "2026-10-11T00:04:31.000Z";
    if (attack === "changed binding")
      await new DurableCheckoutService(
        other,
        new FakeControlledCommerceSource(
          { ...checkoutBinding, bindingRevision: 2 },
          demoCommerceCatalog(),
        ),
        () => new Date(time),
      ).registerMerchantBinding();
    approve();
    await expect(resume()).rejects.toThrow("SECURE_RESUME_REJECTED");
    expect(provider.getCalls).toBe(1);
    expect(provider.captureCalls).toBe(0);
    await expect(
      new PayPalExecutionRail(other, provider, clock).reconcile(
        attemptId,
        time,
      ),
    ).rejects.toThrow();
    expect(provider.captureCalls).toBe(0);
    expect(
      (await repo.sql`select status from payment_attempts`)[0]!.status,
    ).toBe("PAYER_ACTION_REQUIRED");
    expect(
      (await repo.evidence()).some(
        (e) => e.type === "PAYPAL_APPROVAL_OBSERVED",
      ),
    ).toBe(true);
    expect(
      (await repo.evidence()).some(
        (e) =>
          e.type === "PAYMENT_RESUME_REJECTED" &&
          e.data.providerStatus === "APPROVED",
      ),
    ).toBe(true);
    await unchanged();
  });
  it.each(["recipient", "sku", "amount", "currency"])(
    "M4C %s provider conflict quarantines secure resume",
    async (attack) => {
      approve();
      const unit = { ...provider.order!.purchaseUnits[0]! };
      if (attack === "recipient") unit.payeeMerchantId = "DEMOACCOUNT02";
      if (attack === "sku") unit.items = [{ ...unit.items![0]!, sku: "OTHER" }];
      if (attack === "amount") unit.amountValue = "184.00";
      if (attack === "currency") unit.currency = "EUR";
      provider.order = { ...provider.order!, purchaseUnits: [unit] };
      await expect(resume()).rejects.toThrow("SECURE_RESUME_REJECTED");
      await expect(resume()).rejects.toThrow("SECURE_RESUME_REJECTED");
      expect(provider.captureCalls).toBe(0);
      expect(provider.getCalls).toBe(1);
      expect(
        String(
          (
            await repo.sql`select failure_classification from payment_attempts`
          )[0]!.failure_classification,
        ),
      ).toMatch(/^COMMERCE_/);
      await unchanged();
    },
  );
  it("sequential duplicate and browser refresh reuse the existing capture", async () => {
    approve();
    expect(await resume()).toBe("CAPTURED");
    expect(await resume()).toBe("CAPTURED");
    expect(await resume()).toBe("CAPTURED");
    expect(provider.captureCalls).toBe(1);
    await unchanged();
  });
  it("independent PostgreSQL resume workers serialize capture without arbitrary sleeps", async () => {
    approve();
    const otherService = human(
      other,
      new PayPalExecutionRail(other, provider, clock),
    );
    expect(
      await Promise.all([
        resume(),
        otherService.resume({ resumeSecret: secret }, "commerce-p"),
      ]),
    ).toEqual(["CAPTURED", "CAPTURED"]);
    expect(provider.captureCalls).toBe(1);
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(1);
    await unchanged();
  });
  it.each([
    "tampered",
    "stale",
    "foreign principal",
    "substituted order",
    "missing authentication",
  ])("rejects %s resume material", async (attack) => {
    approve();
    let raw = { resumeSecret: secret, returnedOrderId: "ORDER-1" };
    let proof: unknown = "commerce-p";
    if (attack === "tampered") raw = { ...raw, resumeSecret: "0".repeat(64) };
    if (attack === "stale") time = expiresAt;
    if (attack === "foreign principal") proof = "foreign-principal";
    if (attack === "substituted order")
      raw = { ...raw, returnedOrderId: "ORDER-2" };
    if (attack === "missing authentication") proof = { approved: true };
    await expect(resume(raw, proof)).rejects.toThrow("SECURE_RESUME_REJECTED");
    expect(provider.getCalls).toBe(0);
    expect(provider.captureCalls).toBe(0);
    await unchanged();
  });
  it("restart while waiting and after provider approval uses durable digest and exact order", async () => {
    const restarted = human(
      other,
      new PayPalExecutionRail(other, provider, clock),
    );
    expect(await restarted.resume({ resumeSecret: secret }, "commerce-p")).toBe(
      "PAYER_ACTION_REQUIRED",
    );
    approve();
    expect(await restarted.resume({ resumeSecret: secret }, "commerce-p")).toBe(
      "CAPTURED",
    );
    expect(provider.captureCalls).toBe(1);
    await unchanged();
  });
  it("lost capture response reconciles already-existing capture after quote/grant expiry and revocation", async () => {
    approve();
    provider.loseCapture = true;
    expect(await resume()).toBe("CAPTURE_UNKNOWN");
    time = "2026-10-11T00:07:00.000Z";
    await repo.revokeMandate("commerce-m", time);
    expect(
      await human(
        other,
        new PayPalExecutionRail(other, provider, clock),
      ).resume({ resumeSecret: secret }, "commerce-p"),
    ).toBe("CAPTURED");
    expect(provider.captureCalls).toBe(1);
    expect(await resume()).toBe("CAPTURED");
    await unchanged();
  });
  it("does not renew resume material or authority", async () => {
    await expect(service.prepare(attemptId, "commerce-p")).rejects.toThrow(
      "PAYMENT_RESUME_ALREADY_PREPARED",
    );
    expect(provider.captureCalls).toBe(0);
    await unchanged();
  });
  it("persists only secret digest and bounded evidence", async () => {
    approve();
    await resume();
    const rows = await repo.sql`select * from payment_resume_capabilities`;
    expect(rows[0]!.secret_digest).toBe(paymentResumeDigest(secret));
    expect(JSON.stringify(rows)).not.toContain(secret);
    const evidence = JSON.stringify(await repo.evidence());
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("assertion");
    expect(evidence).not.toContain("checkoutnow");
    expect(evidence).not.toContain("Authorization");
    await unchanged();
  });
  it("two distinct product attempts reject cross-attempt return and exact-action substitution", async () => {
    const f = checkoutAuthority();
    await repo.saveMandate({
      ...f.mandate,
      id: "commerce-m2",
      nonce: "second-commerce-mandate-nonce",
    });
    const source = new FakeControlledCommerceSource(
      checkoutBinding,
      demoCommerceCatalog(),
    );
    const secondCheckout = new DurableCheckoutService(
      repo,
      source,
      () => new Date(time),
    );
    const quote = await secondCheckout.issueQuote(
      source.listControlledOffers()[1],
      "commerce-m2",
      1,
    );
    const manifest = await secondCheckout.sealManifest(quote.quoteId);
    const proposal = await secondCheckout.compileManifestProposal(
      manifest.manifestId,
    );
    const authorization = await new DurableAuthorizationService(
      repo,
    ).authorizeProposal(proposal.id, "LOW", time);
    const secondToken = await new ExecutionGrantIssuer(
      repo,
      "m4c",
      keys.privateKey,
    ).issue(authorization.reservation!.id, time);
    const secondProvider = new Provider();
    const original = secondProvider.createOrder.bind(secondProvider);
    vi.spyOn(secondProvider, "createOrder").mockImplementation(
      async (input) => {
        const order = await original(input);
        secondProvider.order = {
          ...order,
          id: "ORDER-2",
          payerActionUrl:
            "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-2",
        };
        return secondProvider.order;
      },
    );
    const secondRail = new PayPalExecutionRail(other, secondProvider, clock);
    await expect(
      new ExecutionBoundary(other, ring, secondRail).execute(secondToken, time),
    ).rejects.toThrow("PAYER_ACTION_REQUIRED");
    const [secondAttempt] =
      await repo.sql`select id from payment_attempts where proposal_id=${proposal.id}`;
    const material = await human(other, secondRail).prepare(
      String(secondAttempt!.id),
      "commerce-p",
    );
    approve();
    await expect(
      resume({ resumeSecret: secret, returnedOrderId: "ORDER-2" }),
    ).rejects.toThrow("SECURE_RESUME_REJECTED");
    await expect(
      resume({
        resumeSecret: material.resumeSecret,
        returnedOrderId: "ORDER-1",
      }),
    ).rejects.toThrow("SECURE_RESUME_REJECTED");
    const exactBoundary = new HumanConfirmationBoundary(
      {
        verify: async (_, binding) => {
          await Promise.resolve();
          // A host assertion/session action for A cannot authenticate B's capability.
          if (
            binding.paymentAttemptId !== attemptId ||
            binding.paypalOrderId !== "ORDER-1" ||
            binding.challengeHash !== paymentResumeDigest(secret)
          )
            throw new Error("AUTHENTICATION_REQUIRED");
          return {
            principalId: "commerce-p",
            actor: "HUMAN",
            authenticatedAt: time,
            expiresAt: new Date(Date.parse(time) + 300000).toISOString(),
          };
        },
      },
      () => new Date(time),
    );
    await expect(
      new PaymentResumeService(
        repo,
        exactBoundary,
        rail,
        () => new Date(time),
      ).resume({ resumeSecret: material.resumeSecret }, "assertion-for-A"),
    ).rejects.toThrow("SECURE_RESUME_REJECTED");
    expect(provider.captureCalls).toBe(0);
    expect(secondProvider.captureCalls).toBe(0);
    expect(provider.createCalls).toBe(1);
    expect(secondProvider.createCalls).toBe(1);
    expect(
      (
        await repo.sql`select provider_order_id from payment_attempts where id=${attemptId}`
      )[0]!.provider_order_id,
    ).toBe("ORDER-1");
  });
  it("migration 007 upgrades populated M4C state without changing financial or evidence rows", async () => {
    const before = JSON.stringify(
      await repo.sql`select * from payment_attempts order by id`,
    );
    const evidence = JSON.stringify(await repo.evidence());
    await repo.sql.begin(async (tx) => {
      await tx`drop table payment_resume_capabilities`;
      await tx`drop function immutable_payment_resume()`;
      await tx.unsafe(
        await readFile(
          "db/migrations/007_milestone_4d_payment_resume.sql",
          "utf8",
        ),
      );
      expect(
        JSON.stringify(await tx`select * from payment_attempts order by id`),
      ).toBe(before);
      expect(await tx`select * from payment_resume_capabilities`).toHaveLength(
        0,
      );
    });
    expect(JSON.stringify(await repo.evidence())).toBe(evidence);
    expect(provider.captureCalls).toBe(0);
    await unchanged();
  });
  it("immutable resume binding cannot replace durable order identity", async () => {
    await expect(
      repo.sql`update payment_resume_capabilities set paypal_order_id='ORDER-2'`,
    ).rejects.toThrow("PAYMENT_RESUME_IMMUTABLE");
    expect(provider.captureCalls).toBe(0);
    await unchanged();
  });
});
