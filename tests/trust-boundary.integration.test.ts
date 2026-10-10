import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  HumanConfirmationBoundary,
  IntentActivationService,
  reviewHash,
  type HumanActionBinding,
} from "../src/intent-activation.js";
import {
  FakeIntentModelProvider,
  interpretIntent,
} from "../src/intent-model.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionGrantIssuer,
  ExecutionBoundary,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import {
  PayPalExecutionRail,
  PayPalProviderError,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { mandateFingerprint } from "../src/canonical.js";
import type {
  Mandate,
  TransactionProposal,
  AgentPassport,
} from "../src/domain.js";
import { activationFixture } from "./activation-fixture.js";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("3D adversarial end-to-end trust boundary", () => {
  let repo: PostgresTrustRepository,
    peer: PostgresTrustRepository,
    activation: IntentActivationService,
    boundary: HumanConfirmationBoundary;
  let instant: Date;
  const clock = () => new Date(instant);
  const keys = generateKeyPairSync("ed25519");
  const policy = {
    version: "payflow.activation-policy.v1",
    maximumMinor: 10000,
    maximumQuantity: 5,
    currencies: ["USD"],
    capabilities: [
      "SEARCH_PRODUCTS",
      "EVALUATE_PRODUCTS",
      "CREATE_ORDER",
      "CAPTURE_PAYMENT",
    ],
    merchantIds: ["merchant_keyboard_store", "merchant_other"],
    merchantRiskCeiling: "LOW",
    maximumLifetimeSeconds: 86400 * 30,
  };
  const passport: AgentPassport = {
    id: "agent",
    principalId: "human",
    displayName: "Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-15T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: [
      "SEARCH_PRODUCTS",
      "EVALUATE_PRODUCTS",
      "CREATE_ORDER",
      "CAPTURE_PAYMENT",
    ],
  };
  function makeBoundary() {
    return new HumanConfirmationBoundary(
      {
        verify: async (assertion, binding) => {
          await Promise.resolve();
          const proof = assertion as {
            principalId: string;
            binding: HumanActionBinding;
            audience: string;
          };
          if (
            !proof ||
            proof.audience !== "payflow-human-confirmation" ||
            reviewHash(proof.binding) !== reviewHash(binding)
          )
            throw new Error("SYNTHETIC_AUTH_EXCEPTION_MARKER");
          return {
            principalId: proof.principalId,
            actor: "HUMAN",
            authenticatedAt: clock().toISOString(),
            expiresAt: new Date(instant.getTime() + 300000).toISOString(),
          };
        },
      },
      clock,
    );
  }
  function proof(binding: HumanActionBinding, principalId = "human") {
    return { principalId, binding, audience: "payflow-human-confirmation" };
  }
  function interpretation(quantity = 1) {
    const f = activationFixture();
    const replaced = JSON.stringify(f).replaceAll(
      "Amazon",
      "merchant_keyboard_store",
    );
    const changed: ReturnType<typeof activationFixture> = JSON.parse(
      replaced,
    ) as ReturnType<typeof activationFixture>;
    changed.context.source.text = changed.context.source.text.replace(
      "quantity 1",
      `quantity ${quantity}`,
    );
    changed.context.reviewBounds.quantity = quantity;
    Object.assign(changed.candidate.constraints.quantity, {
      value: quantity,
      evidence: [{ start: 0, end: 0, quote: `quantity ${quantity}` }],
    });
    for (const field of Object.values(changed.candidate.constraints)) {
      if (field.state === "EXPLICIT")
        for (const span of field.evidence) {
          span.start = changed.context.source.text.indexOf(span.quote);
          span.end = span.start + span.quote.length;
        }
    }
    return changed;
  }
  async function review(quantity = 1) {
    const f = interpretation(quantity);
    const interpreted = await interpretIntent(
      new FakeIntentModelProvider(f.candidate),
      f.context,
    );
    expect(interpreted.status).toBe("INTERPRETED");
    if (
      interpreted.status !== "INTERPRETED" ||
      interpreted.compilation.status !== "VALID_DRAFT"
    )
      throw new Error("CONTROL_DRAFT_INVALID");
    const b = { action: "CREATE_INTENT_REVIEW" as const, agentId: "agent" };
    const c = await boundary.authenticate(proof(b), b);
    return activation.createReview(c, "agent", f.candidate, f.context);
  }
  function request(r: Awaited<ReturnType<typeof review>>) {
    return {
      action: "CONFIRM_EXACT_TERMS" as const,
      reviewId: r.reviewId,
      agentId: "agent",
      draftFingerprint: r.draftFingerprint,
      reviewedHash: r.reviewedHash,
      challenge: r.challenge,
    };
  }
  function confirmProof(r: ReturnType<typeof request>, principalId = "human") {
    const { challenge, ...b } = r;
    return proof({ ...b, challengeHash: reviewHash(challenge) }, principalId);
  }
  async function activate(quantity = 1) {
    const r = await review(quantity),
      q = request(r),
      result = await activation.confirmReviewedIntent(q, confirmProof(q));
    expect(result.status).toBe("ACTIVATED");
    if (result.status !== "ACTIVATED")
      throw new Error("CONTROL_ACTIVATION_INVALID");
    return result.mandate;
  }
  function proposal(
    m: Mandate,
    id = "proposal",
    q = 1,
  ): Mutable<TransactionProposal> {
    return {
      id,
      agentId: "agent",
      mandateId: m.id,
      mandateFingerprint: mandateFingerprint(m),
      amount: { minor: 8900, currency: "USD" },
      quantity: q,
      merchant: {
        id: "merchant_keyboard_store",
        displayName: "Keyboard store",
      },
      category: "KEYBOARD",
      condition: "NEW",
      requestedCapability: "CREATE_ORDER",
      proposedAt: clock().toISOString(),
      nonce: `proposal-nonce-${id}`,
      metadata: {},
    };
  }
  class Provider implements PaymentProvider {
    creates = 0;
    effects = 0;
    gets = 0;
    lost = false;
    reject = false;
    keys: string[] = [];
    order?: PayPalOrderView;
    createOrder(
      input: Parameters<PaymentProvider["createOrder"]>[0],
    ): Promise<PayPalOrderView> {
      this.creates++;
      this.order = {
        id: "order",
        status: "APPROVED",
        purchaseUnits: [
          {
            referenceId: input.merchantReference,
            amountValue: input.amountValue,
            currency: input.currency,
          },
        ],
        captures: [],
      };
      return Promise.resolve(this.order);
    }
    getOrder(): Promise<PayPalOrderView> {
      this.gets++;
      if (!this.order) return Promise.reject(new Error("NO_ORDER"));
      return Promise.resolve(this.order);
    }
    captureOrder(_id: string, key: string): Promise<PayPalOrderView> {
      this.keys.push(key);
      if (this.reject)
        return Promise.reject(
          new PayPalProviderError(
            "DEFINITIVE_REJECTION",
            "SYNTHETIC_REJECTION",
          ),
        );
      if (!this.order) return Promise.reject(new Error("NO_ORDER"));
      if (!this.order.captures.length) {
        this.effects++;
        this.order = {
          ...this.order,
          status: "COMPLETED",
          captures: [
            {
              id: "capture",
              status: "COMPLETED",
              amountValue: this.order.purchaseUnits[0]!.amountValue!,
              currency: this.order.purchaseUnits[0]!.currency!,
            },
          ],
        };
      }
      if (this.lost)
        return Promise.reject(
          new PayPalProviderError("AMBIGUOUS", "SYNTHETIC_RESPONSE_LOSS"),
        );
      return Promise.resolve(this.order);
    }
  }
  function execution(provider: Provider, repository = repo) {
    return new ExecutionBoundary(
      repository,
      new StaticPublicKeyRing(new Map([["3d-key", keys.publicKey]])),
      new PayPalExecutionRail(repository, provider, () =>
        clock().toISOString(),
      ),
    );
  }
  async function issue(m: Mandate, p = proposal(m)) {
    await repo.saveProposal(p);
    const authorized = await new DurableAuthorizationService(
      repo,
    ).authorizeProposal(p.id, "LOW", clock().toISOString());
    expect(authorized.receipt.decision).toBe("ALLOW");
    const token = await new ExecutionGrantIssuer(
      repo,
      "3d-key",
      keys.privateKey,
    ).issue(authorized.reservation!.id, clock().toISOString());
    return { token, reservation: authorized.reservation!, proposal: { ...p } };
  }
  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    peer = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    for (const name of (await readdir("db/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
  });
  afterAll(async () => {
    await peer.close();
    await repo.close();
  });
  beforeEach(async () => {
    instant = new Date("2026-10-10T00:00:00.000Z");
    await repo.sql`truncate principals cascade`;
    await repo.sql`truncate evidence_events restart identity`;
    await repo.savePrincipal({ id: "human", displayName: "Human" });
    await repo.savePrincipal({ id: "other", displayName: "Other" });
    await repo.saveAgent(passport);
    boundary = makeBoundary();
    activation = new IntentActivationService(repo, boundary, clock);
    await activation.provisionPolicy("human", policy);
  });
  it("valid full chain commits one payment and truthful evidence", async () => {
    const m = await activate(),
      { token } = await issue(m),
      provider = new Provider();
    await execution(provider).execute(token, clock().toISOString());
    expect(provider.creates).toBe(1);
    expect(provider.effects).toBe(1);
    expect(await repo.quantityAccounting(m, repo.sql)).toBe(1);
    const events = await repo.evidence();
    expect(events.filter((e) => e.type === "PAYMENT_COMMITTED")).toHaveLength(
      1,
    );
    expect(PostgresTrustRepository.verifyEvidence(events)).toBe(true);
  });
  it("forged-context rejection never persists client-controlled credentials disguised as review IDs", async () => {
    await review();
    const marker = "UNTRUSTED_SESSION_CREDENTIAL_MARKER",
      b = {
        action: "CONFIRM_EXACT_TERMS" as const,
        reviewId: marker,
        agentId: "agent",
        draftFingerprint: "a".repeat(64),
        reviewedHash: "b".repeat(64),
        challengeHash: "c".repeat(64),
      };
    expect(
      await activation.activateReviewedIntent({ confirmed: true }, b),
    ).toEqual({ status: "REJECTED", code: "AUTHENTICATION_REQUIRED" });
    expect(JSON.stringify(await repo.evidence())).not.toContain(marker);
  });
  it.each([
    ["price", "AMOUNT_EXCEEDS_LIMIT"],
    ["condition", "CONDITION_DENIED"],
    ["merchant", "MERCHANT_NOT_ALLOWED"],
    ["quantity", "QUANTITY_EXHAUSTED"],
  ])(
    "rejects end-to-end %s substitution before reservation and provider",
    async (field, code) => {
      const m = await activate(),
        p = proposal(m),
        provider = new Provider();
      if (field === "price") p.amount.minor = 12900;
      if (field === "condition") p.condition = "REFURBISHED";
      if (field === "merchant") p.merchant.id = "merchant_other";
      if (field === "quantity") p.quantity = 2;
      await repo.saveProposal(p);
      const denied = await new DurableAuthorizationService(
        repo,
      ).authorizeProposal(p.id, "LOW", clock().toISOString());
      expect(denied.receipt.decision).toBe("DENY");
      expect(denied.receipt.reasonCodes).toContain(code);
      expect(denied.reservation).toBeNull();
      expect(
        await repo.sql`select id from authorization_reservations`,
      ).toHaveLength(0);
      expect(await repo.sql`select id from execution_grants`).toHaveLength(0);
      expect(provider.effects).toBe(0);
      expect(provider.creates).toBe(0);
    },
  );
  it.each([
    [1, 1, 2, 1],
    [2, 1, 3, 2],
    [5, 3, 2, 1],
  ])(
    "bounds concurrent quantity %i with proposal quantity %i across %i workers",
    async (limit, quantity, workers, winners) => {
      const m = await activate(limit);
      const proposals = Array.from({ length: workers }, (_, i) => {
        const p = proposal(m, `parallel-${i}`, quantity);
        p.amount.minor = 100;
        return p;
      });
      for (const p of proposals) await repo.saveProposal(p);
      const results = await Promise.all(
        proposals.map((p, i) =>
          new DurableAuthorizationService(
            i % 2 ? peer : repo,
          ).authorizeProposal(p.id, "LOW", clock().toISOString()),
        ),
      );
      expect(
        results.filter((r) => r.receipt.decision === "ALLOW"),
      ).toHaveLength(winners);
      expect(
        results
          .filter((r) => r.receipt.decision === "DENY")
          .every((r) => r.receipt.reasonCodes.includes("QUANTITY_EXHAUSTED")),
      ).toBe(true);
      let effects = 0;
      for (const r of results.filter((r) => r.reservation)) {
        const token = await new ExecutionGrantIssuer(
          repo,
          "3d-key",
          keys.privateKey,
        ).issue(r.reservation!.id, clock().toISOString());
        const provider = new Provider();
        // Separate provider identities for genuinely independent allowed operations.
        const original = provider.createOrder.bind(provider);
        provider.createOrder = async (input) => {
          const order = await original(input);
          provider.order = { ...order, id: `order-${r.reservation!.id}` };
          return provider.order;
        };
        const capture = provider.captureOrder.bind(provider);
        provider.captureOrder = async (id, key) => {
          const order = await capture(id, key);
          provider.order = {
            ...order,
            captures: order.captures.map((c) => ({
              ...c,
              id: `capture-${r.reservation!.id}`,
            })),
          };
          return provider.order;
        };
        await execution(provider).execute(token, clock().toISOString());
        effects += provider.effects;
      }
      expect(effects).toBe(winners);
      expect(await peer.quantityAccounting(m, peer.sql)).toBe(
        winners * quantity,
      );
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(winners);
    },
  );
  it("eight concurrent confirmations across two connections activate exactly once", async () => {
    const r = await review(),
      q = request(r);
    const otherBoundary = makeBoundary(),
      other = new IntentActivationService(peer, otherBoundary, clock);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? other : activation).confirmReviewedIntent(q, confirmProof(q)),
      ),
    );
    expect(results.filter((r) => r.status === "ACTIVATED")).toHaveLength(1);
    expect(
      results.filter((r) => r.status === "REJECTED").map((r) => r.code),
    ).toEqual(Array(7).fill("CONFIRMATION_REPLAY"));
    expect(await repo.sql`select id from mandates`).toHaveLength(1);
    expect(
      (await repo.evidence()).filter(
        (e) => e.type === "INTENT_MANDATE_ACTIVATED",
      ),
    ).toHaveLength(1);
  });
  it.each([
    "reviewId",
    "draftFingerprint",
    "reviewedHash",
    "challenge",
  ] as const)(
    "rejects cross-review %s substitution with authenticated proof",
    async (field) => {
      const a = await review(),
        b = await review(2);
      const q = request(a);
      q[field] = request(b)[field];
      const result = await activation.confirmReviewedIntent(q, confirmProof(q));
      expect(result.status).toBe("REJECTED");
      expect(await repo.sql`select id from mandates`).toHaveLength(0);
      expect(
        (await repo.evidence()).filter(
          (e) => e.type === "INTENT_MANDATE_ACTIVATED",
        ),
      ).toHaveLength(0);
    },
  );
  const proposalMutations: [
    string,
    (p: Mutable<TransactionProposal>) => void,
  ][] = [
    [
      "amount",
      (p) => {
        p.amount.minor = 9000;
      },
    ],
    [
      "currency",
      (p) => {
        p.amount.currency = "EUR";
      },
    ],
    [
      "quantity",
      (p) => {
        p.quantity = 2;
      },
    ],
    [
      "merchant",
      (p) => {
        p.merchant.id = "merchant_other";
      },
    ],
    [
      "condition",
      (p) => {
        p.condition = "USED";
      },
    ],
    [
      "category",
      (p) => {
        p.category = "OTHER";
      },
    ],
    [
      "capability",
      (p) => {
        p.requestedCapability = "CAPTURE_PAYMENT";
      },
    ],
    [
      "agent",
      (p) => {
        p.agentId = "other-agent";
      },
    ],
    [
      "mandate",
      (p) => {
        p.mandateId = "other-mandate";
      },
    ],
    [
      "fingerprint",
      (p) => {
        p.mandateFingerprint = "a".repeat(64);
      },
    ],
    [
      "nonce",
      (p) => {
        p.nonce = "substituted-nonce";
      },
    ],
    [
      "timestamp",
      (p) => {
        p.proposedAt = "2026-10-09T00:00:00.000Z";
      },
    ],
    [
      "metadata",
      (p) => {
        p.metadata = { hiddenAuthority: "ALLOW" };
      },
    ],
  ];
  it.each(proposalMutations)(
    "proposal %s mutation after authorization cannot issue a grant",
    async (_field, mutate) => {
      const m = await activate(),
        p = proposal(m);
      await repo.saveProposal(p);
      const allowed = await new DurableAuthorizationService(
        repo,
      ).authorizeProposal(p.id, "LOW", clock().toISOString());
      expect(allowed.receipt.decision).toBe("ALLOW");
      mutate(p);
      await repo.sql`update transaction_proposals set document=${repo.sql.json(p)} where id='proposal'`;
      await expect(
        new ExecutionGrantIssuer(repo, "3d-key", keys.privateKey).issue(
          allowed.reservation!.id,
          clock().toISOString(),
        ),
      ).rejects.toThrow();
      expect(await repo.sql`select id from execution_grants`).toHaveLength(0);
      expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
    },
  );
  it.each(proposalMutations)(
    "proposal %s mutation after grant prevents provider dispatch",
    async (_field, mutate) => {
      const m = await activate(),
        issued = await issue(m),
        provider = new Provider();
      mutate(issued.proposal);
      await repo.sql`update transaction_proposals set document=${repo.sql.json(issued.proposal)} where id='proposal'`;
      await expect(
        execution(provider).execute(issued.token, clock().toISOString()),
      ).rejects.toThrow();
      expect(provider.creates).toBe(0);
      expect(provider.effects).toBe(0);
      expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(0);
    },
  );
  it.each([
    "quantity",
    "merchant",
    "amount",
    "currency",
    "capability",
    "expiry",
    "principal",
    "agent",
  ])("mandate %s mutation after grant fails closed", async (field) => {
    const m = { ...(await activate()) },
      issued = await issue(m),
      provider = new Provider();
    if (field === "quantity") m.quantityLimit = 5;
    if (field === "merchant") m.merchantScope = { mode: "ANY" };
    if (field === "amount") m.maxSingleTransactionMinor = 10000;
    if (field === "currency") m.currency = "EUR";
    if (field === "capability") m.allowedCapabilities = ["CREATE_ORDER"];
    if (field === "expiry") m.expiresAt = "2026-11-02T00:00:00.000Z";
    if (field === "principal") m.principalId = "other";
    if (field === "agent") m.authorizedAgentId = "other-agent";
    await repo.sql`update mandates set document=${repo.sql.json(m)} where id=${m.id}`;
    await expect(
      execution(provider).execute(issued.token, clock().toISOString()),
    ).rejects.toThrow();
    expect(provider.creates).toBe(0);
    expect(provider.effects).toBe(0);
  });
  it.each(["principal", "passport", "mandate"])(
    "%s revocation after grant prevents dispatch",
    async (field) => {
      const m = await activate(),
        issued = await issue(m),
        provider = new Provider();
      if (field === "principal")
        await peer.sql`update principals set status='REVOKED' where id='human'`;
      if (field === "passport")
        await peer.sql`update agent_passports set status='REVOKED' where id='agent'`;
      if (field === "mandate")
        await peer.revokeMandate(m.id, clock().toISOString());
      await expect(
        execution(provider).execute(issued.token, clock().toISOString()),
      ).rejects.toThrow();
      expect(provider.creates).toBe(0);
      expect(provider.effects).toBe(0);
    },
  );
  it("two execution workers cannot double spend one activated reservation", async () => {
    const m = await activate(),
      issued = await issue(m),
      provider = new Provider();
    const result = await Promise.allSettled([
      execution(provider).execute(issued.token, clock().toISOString()),
      execution(provider, peer).execute(issued.token, clock().toISOString()),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(provider.effects).toBe(1);
    expect(provider.creates).toBe(1);
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(1);
  });
  it("lost capture response quarantines quantity and restart GET reconciles one effect", async () => {
    const m = await activate(),
      issued = await issue(m),
      provider = new Provider();
    provider.lost = true;
    await expect(
      execution(provider).execute(issued.token, clock().toISOString()),
    ).rejects.toThrow();
    const [attempt] = await repo.sql`select * from payment_attempts`;
    expect(attempt!.status).toBe("CAPTURE_UNKNOWN");
    expect(await peer.quantityAccounting(m, peer.sql)).toBe(1);
    expect(provider.effects).toBe(1);
    expect(provider.keys).toEqual([attempt!.capture_request_id]);
    await peer.revokeMandate(m.id, clock().toISOString());
    const recovery = new PayPalExecutionRail(peer, provider, () =>
      clock().toISOString(),
    );
    expect(await recovery.reconcile(String(attempt!.id))).toBe("CAPTURED");
    expect(await recovery.reconcile(String(attempt!.id))).toBe("CAPTURED");
    expect(provider.gets).toBeGreaterThan(0);
    expect(provider.keys).toHaveLength(1);
    expect(provider.effects).toBe(1);
    expect(await peer.quantityAccounting(m, peer.sql)).toBe(1);
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(1);
  });
  it("activation evidence failure rolls back mandate and confirmation consumption", async () => {
    const r = await review(),
      q = request(r);
    const original = repo.appendEvidenceInTransaction.bind(repo);
    const spy = vi
      .spyOn(repo, "appendEvidenceInTransaction")
      .mockImplementation(async (tx, type, payload, now) => {
        if (type === "INTENT_MANDATE_ACTIVATED")
          throw new Error("SYNTHETIC_DB_CREDENTIAL_MARKER");
        return original(tx, type, payload, now);
      });
    try {
      expect(
        (await activation.confirmReviewedIntent(q, confirmProof(q))).status,
      ).toBe("REJECTED");
    } finally {
      spy.mockRestore();
    }
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
    expect(
      (
        await repo.sql`select status from intent_reviews where id=${r.reviewId}`
      )[0]!.status,
    ).toBe("PENDING");
    const evidence = await repo.evidence();
    expect(
      evidence.filter(
        (e) =>
          e.type === "HUMAN_CONFIRMATION_ACCEPTED" ||
          e.type === "INTENT_MANDATE_ACTIVATED",
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(evidence)).not.toContain(
      "SYNTHETIC_DB_CREDENTIAL_MARKER",
    );
    expect(PostgresTrustRepository.verifyEvidence(evidence)).toBe(true);
  });
  it.each(["RELEASED", "FAILED", "EXPIRED"] as const)(
    "%s unexecuted reservation restores durable quantity across restart",
    async (state) => {
      const m = await activate(),
        p = proposal(m, "original");
      p.amount.minor = 100;
      await repo.saveProposal(p);
      const service = new DurableAuthorizationService(repo);
      const first = await service.authorizeProposal(
        p.id,
        "LOW",
        clock().toISOString(),
      );
      expect(first.receipt.decision).toBe("ALLOW");
      expect(await peer.quantityAccounting(m, peer.sql)).toBe(1);
      await service.transitionReservation(
        first.reservation!.id,
        state,
        clock().toISOString(),
      );
      expect(await peer.quantityAccounting(m, peer.sql)).toBe(0);
      const retry = proposal(m, "new-authorization");
      retry.amount.minor = 100;
      await peer.saveProposal(retry);
      expect(
        (
          await new DurableAuthorizationService(peer).authorizeProposal(
            retry.id,
            "LOW",
            clock().toISOString(),
          )
        ).receipt.decision,
      ).toBe("ALLOW");
      expect(await peer.quantityAccounting(m, peer.sql)).toBe(1);
    },
  );
  it.each([null, 2])(
    "corrupted reservation quantity %s cannot reach provider",
    async (quantity) => {
      const m = await activate(),
        issued = await issue(m),
        provider = new Provider();
      await repo.sql`update authorization_reservations set quantity=${quantity} where id=${issued.reservation.id}`;
      await expect(
        execution(provider).execute(issued.token, clock().toISOString()),
      ).rejects.toThrow();
      expect(provider.creates).toBe(0);
      expect(provider.effects).toBe(0);
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(0);
    },
  );
  it("UNKNOWN cannot be released or expired to restore quantity", async () => {
    const m = await activate(),
      issued = await issue(m),
      provider = new Provider();
    provider.lost = true;
    await expect(
      execution(provider).execute(issued.token, clock().toISOString()),
    ).rejects.toThrow();
    const service = new DurableAuthorizationService(peer);
    await expect(
      service.transitionReservation(
        issued.reservation.id,
        "RELEASED",
        clock().toISOString(),
      ),
    ).rejects.toThrow("INVALID_RESERVATION_TRANSITION");
    await expect(
      service.transitionReservation(
        issued.reservation.id,
        "FAILED",
        clock().toISOString(),
      ),
    ).rejects.toThrow("INVALID_RESERVATION_TRANSITION");
    expect(
      await service.expireStaleReservations("2026-10-11T00:00:00.000Z"),
    ).toBe(0);
    expect(await peer.quantityAccounting(m, peer.sql)).toBe(1);
    expect(provider.effects).toBe(1);
  });
});
