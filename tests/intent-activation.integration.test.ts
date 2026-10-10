import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import {
  PayPalExecutionRail,
  PayPalProviderError,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  HumanConfirmationBoundary,
  IntentActivationService,
  reviewHash,
  type HumanActionBinding,
} from "../src/intent-activation.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import { compileIntentDraft } from "../src/intent.js";
import { mandateFingerprint } from "../src/canonical.js";
import type { Mandate, TransactionProposal } from "../src/domain.js";
import { activationFixture } from "./activation-fixture.js";
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("3C durable human confirmation and commerce accounting", () => {
  let repo: PostgresTrustRepository,
    second: PostgresTrustRepository,
    service: IntentActivationService,
    boundary: HumanConfirmationBoundary;
  let time: Date;
  let upgradedLegacyFingerprint: string;
  const clock = () => new Date(time);
  const policy = {
    version: "payflow.activation-policy.v1",
    maximumMinor: 10000,
    maximumQuantity: 1,
    currencies: ["USD"],
    capabilities: [
      "SEARCH_PRODUCTS",
      "EVALUATE_PRODUCTS",
      "CREATE_ORDER",
      "CAPTURE_PAYMENT",
    ],
    merchantIds: ["Amazon", "eBay"],
    merchantRiskCeiling: "LOW",
    maximumLifetimeSeconds: 86400 * 30,
  };
  // Deterministic TEST authenticator: assertion verifies exact external human action.
  function makeBoundary() {
    return new HumanConfirmationBoundary(
      {
        verify: async (raw, binding) => {
          await Promise.resolve();
          const proof = raw as {
            principalId: string;
            binding: HumanActionBinding;
          };
          if (
            !proof ||
            JSON.stringify(proof.binding) !== JSON.stringify(binding)
          )
            throw new Error("BAD_TEST_PROOF");
          return {
            principalId: proof.principalId,
            actor: "HUMAN",
            authenticatedAt: clock().toISOString(),
            expiresAt: new Date(time.getTime() + 300000).toISOString(),
          };
        },
      },
      clock,
    );
  }
  async function review() {
    const f = activationFixture();
    const b = { action: "CREATE_INTENT_REVIEW" as const, agentId: "a" };
    const context = await boundary.authenticate(
      { principalId: "p", binding: b },
      b,
    );
    return service.createReview(context, "a", f.candidate, f.context);
  }
  function request(r: Awaited<ReturnType<typeof review>>) {
    return {
      action: "CONFIRM_EXACT_TERMS" as const,
      reviewId: r.reviewId,
      agentId: "a",
      draftFingerprint: r.draftFingerprint,
      reviewedHash: r.reviewedHash,
      challenge: r.challenge,
    };
  }
  function proof(r: ReturnType<typeof request>, principalId = "p") {
    const { challenge, ...rest } = r;
    return {
      principalId,
      binding: {
        ...rest,
        challengeHash:
          /* same deterministic hashing as boundary */ hash(challenge),
      },
    };
  }
  function hash(v: unknown) {
    return reviewHash(v);
  }
  async function activate() {
    const r = await review();
    const req = request(r);
    const result = await service.confirmReviewedIntent(req, proof(req));
    expect(result.status).toBe("ACTIVATED");
    if (result.status !== "ACTIVATED") throw new Error(JSON.stringify(result));
    return result.mandate;
  }
  function proposal(
    m: Mandate,
    id: string,
    quantity = 1,
    merchantId = "Amazon",
  ): TransactionProposal {
    return {
      id,
      mandateId: m.id,
      mandateFingerprint: mandateFingerprint(m),
      agentId: "a",
      amount: { minor: 100, currency: "USD" },
      merchant: { id: merchantId, displayName: merchantId },
      category: "KEYBOARD",
      condition: "NEW",
      requestedCapability: "CREATE_ORDER",
      quantity,
      proposedAt: clock().toISOString(),
      nonce: `proposal-nonce-${id}`,
      metadata: {},
    };
  }
  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    second = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    const names = (await readdir("db/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const name of names) {
      if (name.startsWith("005")) {
        const f = activationFixture(),
          c = compileIntentDraft(f.candidate, f.context);
        if (c.status !== "VALID_DRAFT") throw new Error("FIXTURE_INVALID");
        await repo.savePrincipal({ id: "upgrade-p", displayName: "Legacy" });
        await repo.saveAgent({
          id: "upgrade-a",
          principalId: "upgrade-p",
          displayName: "Legacy",
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities: [
            "CREATE_ORDER",
            "CAPTURE_PAYMENT",
            "SEARCH_PRODUCTS",
            "EVALUATE_PRODUCTS",
          ],
        });
        const historical: Mandate = {
          ...c.draft.proposedMandateTerms,
          allowedConditions: [
            ...c.draft.proposedMandateTerms.allowedConditions,
          ],
          allowedCapabilities: [
            ...c.draft.proposedMandateTerms.allowedCapabilities,
          ],
          id: "upgrade-m",
          principalId: "upgrade-p",
          authorizedAgentId: "upgrade-a",
          merchantRiskCeiling: "LOW",
          createdAt: f.context.now,
          nonce: "legacy-upgrade-nonce",
          version: 1,
        };
        await repo.saveMandate(historical);
        upgradedLegacyFingerprint = mandateFingerprint(historical);
      }
      await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
    }
    expect(mandateFingerprint((await repo.getMandate("upgrade-m"))!)).toBe(
      upgradedLegacyFingerprint,
    );
    expect(
      (await repo.sql`select status from principals where id='upgrade-p'`)[0]
        ?.status,
    ).toBe("ACTIVE");
  });
  afterAll(async () => {
    await second.close();
    await repo.close();
  });
  beforeEach(async () => {
    time = new Date("2026-10-10T00:00:00.000Z");
    await repo.sql`truncate principals cascade`;
    await repo.sql`truncate evidence_events restart identity`;
    await repo.savePrincipal({ id: "p", displayName: "Human" });
    await repo.savePrincipal({ id: "other", displayName: "Other" });
    await repo.saveAgent({
      id: "a",
      principalId: "p",
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
    });
    boundary = makeBoundary();
    service = new IntentActivationService(repo, boundary, clock);
    await service.provisionPolicy("p", policy);
  });
  it("atomically activates server-owned identity, exact terms, quantity/merchant enforcement and evidence", async () => {
    const m = await activate();
    expect(m).toMatchObject({
      principalId: "p",
      authorizedAgentId: "a",
      maxSingleTransactionMinor: 9999,
      quantityLimit: 1,
      merchantScope: { mode: "ONLY", ids: ["Amazon"] },
    });
    const rows = await repo.sql`select * from intent_reviews`;
    expect(rows[0]?.status).toBe("ACTIVATED");
    expect(rows[0]?.mandate_id).toBe(m.id);
    const events = await repo.sql`select type from evidence_events`;
    expect(events.map((e) => String(e.type))).toEqual([
      "INTENT_REVIEW_CREATED",
      "HUMAN_CONFIRMATION_ACCEPTED",
      "INTENT_MANDATE_ACTIVATED",
    ]);
  });
  it.each([
    "draftFingerprint",
    "reviewedHash",
    "agentId",
    "reviewId",
    "challenge",
  ])("rejects changed %s with no mandate", async (field) => {
    const r = await review(),
      req = {
        ...request(r),
        [field]:
          field.includes("Hash") ||
          field.includes("Fingerprint") ||
          field === "challenge"
            ? "f".repeat(64)
            : "other",
      };
    expect((await service.confirmReviewedIntent(req, proof(req))).status).toBe(
      "REJECTED",
    );
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
  it.each([
    { confirmed: true },
    { approval: { approved: true } },
    { executionGrant: "fake" },
    { decisionReceipt: { decision: "ALLOW" } },
    { principalId: "p" },
  ])("rejects unknown authority-bearing request fields %j", async (extra) => {
    const r = await review(),
      req = request(r);
    expect(
      (await service.confirmReviewedIntent({ ...req, ...extra }, proof(req)))
        .status,
    ).toBe("REJECTED");
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
  it("rejects cross-principal authenticated confirmation", async () => {
    const r = await review(),
      req = request(r);
    expect(
      await service.confirmReviewedIntent(req, proof(req, "other")),
    ).toEqual({ status: "REJECTED", code: "PRINCIPAL_MISMATCH" });
  });
  it("rejects forged or cloned trusted human context", async () => {
    const r = await review(),
      req = request(r),
      binding = proof(req).binding;
    expect(
      (
        await service.activateReviewedIntent(
          {
            kind: "AUTHENTICATED_HUMAN_ACTION",
            principalId: "p",
            confirmed: true,
          },
          binding,
        )
      ).status,
    ).toBe("REJECTED");
  });
  it("rejects exactly at review expiry", async () => {
    const r = await review(),
      req = request(r);
    time = new Date(r.expiresAt);
    expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
      status: "REJECTED",
      code: "REVIEW_EXPIRED",
    });
  });
  it.each(["principal", "passport", "policy"])(
    "detects stale %s even after restored security state",
    async (target) => {
      const r = await review(),
        req = request(r);
      if (target === "principal") {
        await repo.sql`update principals set status='DISABLED' where id='p'`;
        await repo.sql`update principals set status='ACTIVE' where id='p'`;
      }
      if (target === "passport") {
        await repo.sql`update agent_passports set status='SUSPENDED' where id='a'`;
        await repo.sql`update agent_passports set status='ACTIVE' where id='a'`;
      }
      if (target === "policy") await service.provisionPolicy("p", policy);
      expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
        status: "REJECTED",
        code: "REVIEW_STALE",
      });
    },
  );
  it.each(["DISABLED", "REVOKED"])(
    "blocks inactive principal %s",
    async (status) => {
      const r = await review(),
        req = request(r);
      await repo.sql`update principals set status=${status} where id='p'`;
      expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
        status: "REJECTED",
        code: "PRINCIPAL_INACTIVE",
      });
    },
  );
  it.each(["SUSPENDED", "REVOKED"])(
    "blocks inactive passport %s",
    async (status) => {
      const r = await review(),
        req = request(r);
      await repo.sql`update agent_passports set status=${status} where id='a'`;
      expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
        status: "REJECTED",
        code: "PASSPORT_INACTIVE",
      });
    },
  );
  it("restart and concurrent instances consume one durable confirmation exactly once", async () => {
    const r = await review(),
      req = request(r),
      other = new IntentActivationService(second, makeBoundary(), clock);
    const results = await Promise.all([
      service.confirmReviewedIntent(req, proof(req)),
      other.confirmReviewedIntent(req, proof(req)),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([
      "ACTIVATED",
      "REJECTED",
    ]);
    expect(results.find((x) => x.status === "REJECTED")).toEqual({
      status: "REJECTED",
      code: "CONFIRMATION_REPLAY",
    });
    expect(await repo.sql`select id from mandates`).toHaveLength(1);
    const restarted = new IntentActivationService(
      second,
      makeBoundary(),
      clock,
    );
    expect(await restarted.confirmReviewedIntent(req, proof(req))).toEqual({
      status: "REJECTED",
      code: "CONFIRMATION_REPLAY",
    });
    const events =
      await repo.sql`select type from evidence_events where type='INTENT_MANDATE_ACTIVATED'`;
    expect(events).toHaveLength(1);
  });
  it("two database connections cannot reserve quantity one twice", async () => {
    const m = await activate();
    for (const id of ["one", "two"]) await repo.saveProposal(proposal(m, id));
    const results = await Promise.all([
      new DurableAuthorizationService(repo).authorizeProposal(
        "one",
        "LOW",
        clock().toISOString(),
      ),
      new DurableAuthorizationService(second).authorizeProposal(
        "two",
        "LOW",
        clock().toISOString(),
      ),
    ]);
    expect(results.map((x) => x.receipt.decision).sort()).toEqual([
      "ALLOW",
      "DENY",
    ]);
    expect(
      results.find((x) => x.receipt.decision === "DENY")?.receipt.reasonCodes,
    ).toContain("QUANTITY_EXHAUSTED");
    expect(
      await repo.sql`select id from authorization_reservations where status='AUTHORIZED'`,
    ).toHaveLength(1);
    expect(await second.quantityAccounting(m, second.sql)).toBe(1);
  });
  it("release restores quantity and a fresh reservation consumes it again", async () => {
    const m = await activate(),
      auth = new DurableAuthorizationService(repo);
    await repo.saveProposal(proposal(m, "first"));
    const first = await auth.authorizeProposal(
      "first",
      "LOW",
      clock().toISOString(),
    );
    await auth.transitionReservation(
      first.reservation!.id,
      "RELEASED",
      clock().toISOString(),
    );
    expect(await repo.quantityAccounting(m, repo.sql)).toBe(0);
    await repo.saveProposal(proposal(m, "next"));
    const next = await auth.authorizeProposal(
      "next",
      "LOW",
      clock().toISOString(),
    );
    expect(next.receipt.decision).toBe("ALLOW");
    expect(await second.quantityAccounting(m, second.sql)).toBe(1);
  });
  it("corrupt quantity is detected rather than restored or ignored", async () => {
    const m = await activate();
    await repo.saveProposal(proposal(m, "first"));
    await new DurableAuthorizationService(repo).authorizeProposal(
      "first",
      "LOW",
      clock().toISOString(),
    );
    await repo.sql`update authorization_reservations set quantity=2`;
    await expect(repo.quantityAccounting(m, repo.sql)).rejects.toThrow(
      "CORRUPT_QUANTITY_ACCOUNTING",
    );
  });
  it.each([
    [2, "Amazon", "QUANTITY_EXHAUSTED"],
    [1, "eBay", "MERCHANT_NOT_ALLOWED"],
    [1, "amazon", "MERCHANT_NOT_ALLOWED"],
  ])("denies quantity %s merchant %s", async (q, m, code) => {
    const mandate = await activate();
    await repo.saveProposal(proposal(mandate, "bad", q, m));
    const result = await new DurableAuthorizationService(
      repo,
    ).authorizeProposal("bad", "LOW", clock().toISOString());
    expect(result.receipt.decision).toBe("DENY");
    expect(result.receipt.reasonCodes).toContain(code);
    expect(
      await repo.sql`select id from authorization_reservations`,
    ).toHaveLength(0);
  });
  it.each([false, true])(
    "activated quantity survives capture/restart, lost response=%s, with one financial effect",
    async (lost) => {
      const m = await activate(),
        auth = new DurableAuthorizationService(repo);
      await repo.saveProposal(proposal(m, "paid"));
      await repo.saveProposal(proposal(m, "racing"));
      const decisions = await Promise.all([
        auth.authorizeProposal("paid", "LOW", clock().toISOString()),
        new DurableAuthorizationService(second).authorizeProposal(
          "racing",
          "LOW",
          clock().toISOString(),
        ),
      ]);
      expect(decisions.map((d) => d.receipt.decision).sort()).toEqual([
        "ALLOW",
        "DENY",
      ]);
      const authorized = decisions.find((d) => d.receipt.decision === "ALLOW")!;
      const keys = generateKeyPairSync("ed25519");
      const issuer = new ExecutionGrantIssuer(repo, "3c", keys.privateKey);
      const token = await issuer.issue(
        authorized.reservation!.id,
        clock().toISOString(),
      );
      let effects = 0,
        creates = 0;
      let order: PayPalOrderView;
      const provider: PaymentProvider = {
        async createOrder(input) {
          await Promise.resolve();
          creates++;
          order = {
            id: "order-3c",
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
          return order;
        },
        async getOrder() {
          await Promise.resolve();
          return order;
        },
        async captureOrder() {
          await Promise.resolve();
          effects++;
          order = {
            ...order,
            status: "COMPLETED",
            captures: [
              {
                id: "capture-3c",
                status: "COMPLETED",
                amountValue: "1.00",
                currency: "USD",
              },
            ],
          };
          if (lost)
            throw new PayPalProviderError(
              "AMBIGUOUS",
              "SIMULATED_RESPONSE_LOSS",
            );
          return order;
        },
      };
      const rail = new PayPalExecutionRail(repo, provider, () =>
        clock().toISOString(),
      );
      const boundary = new ExecutionBoundary(
        repo,
        new StaticPublicKeyRing(new Map([["3c", keys.publicKey]])),
        rail,
      );
      if (lost) {
        await expect(
          boundary.execute(token, clock().toISOString()),
        ).rejects.toThrow("PAYPAL_CAPTURE_UNKNOWN");
        expect(await second.quantityAccounting(m, second.sql)).toBe(1);
        const [attempt] =
          await repo.sql`select id,status from payment_attempts`;
        expect(attempt?.status).toBe("CAPTURE_UNKNOWN");
        expect(
          await new PayPalExecutionRail(second, provider, () =>
            clock().toISOString(),
          ).reconcile(String(attempt?.id), clock().toISOString()),
        ).toBe("CAPTURED");
      } else await boundary.execute(token, clock().toISOString());
      expect(effects).toBe(1);
      expect(creates).toBe(1);
      await expect(
        boundary.execute(token, clock().toISOString()),
      ).rejects.toThrow();
      await repo.saveProposal(proposal(m, "another"));
      expect(
        (
          await new DurableAuthorizationService(second).authorizeProposal(
            "another",
            "LOW",
            clock().toISOString(),
          )
        ).receipt.reasonCodes,
      ).toContain("QUANTITY_EXHAUSTED");
      expect(effects).toBe(1);
      expect(await second.quantityAccounting(m, second.sql)).toBe(1);
      expect(
        (await repo.sql`select status from payment_attempts`)[0]?.status,
      ).toBe("CAPTURED");
      expect(
        (await repo.sql`select status from authorization_reservations`)[0]
          ?.status,
      ).toBe("COMMITTED");
    },
  );
  it.each([
    "amount",
    "bound",
    "currency",
    "quantity",
    "conditions",
    "merchants",
    "autonomousPurchase",
    "confirmationRequired",
    "capabilities",
    "expiresAt",
  ])("rejects durable reviewed %s mutation", async (field) => {
    const r = await review(),
      req = request(r);
    const name = field === "amount" || field === "bound" ? "maximum" : field;
    const mutation =
      field === "amount"
        ? { decimal: "1000", bound: "EXCLUSIVE" }
        : field === "bound"
          ? { decimal: "100", bound: "INCLUSIVE" }
          : "MUTATED";
    await repo.sql`update intent_reviews set reviewed_document=jsonb_set(reviewed_document,${["interpretation", "constraints", name, "value"]},${JSON.stringify(mutation)}::jsonb) where id=${r.reviewId}`;
    expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
      status: "REJECTED",
      code: "REVIEW_BINDING_MISMATCH",
    });
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
    expect(
      await repo.sql`select type from evidence_events where type='INTENT_MANDATE_ACTIVATED'`,
    ).toHaveLength(0);
  });
  it("rolls back mandate, confirmation and evidence if final transition is suppressed", async () => {
    const r = await review(),
      req = request(r);
    await repo.sql.unsafe(
      "create function suppress_activation() returns trigger language plpgsql as $$ begin return null; end $$",
    );
    await repo.sql.unsafe(
      "create trigger suppress_activation before update on intent_reviews for each row execute function suppress_activation()",
    );
    try {
      expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
        status: "REJECTED",
        code: "TRANSITION_FAILED",
      });
      expect(await repo.sql`select id from mandates`).toHaveLength(0);
      expect(
        (await repo.sql`select status from intent_reviews`)[0]?.status,
      ).toBe("PENDING");
      expect(
        await repo.sql`select type from evidence_events where type in ('INTENT_MANDATE_ACTIVATED','HUMAN_CONFIRMATION_ACCEPTED')`,
      ).toHaveLength(0);
    } finally {
      await repo.sql.unsafe(
        "drop trigger suppress_activation on intent_reviews",
      );
      await repo.sql.unsafe("drop function suppress_activation()");
    }
    expect((await service.confirmReviewedIntent(req, proof(req))).status).toBe(
      "ACTIVATED",
    );
  });
  it("passport revocation holding the authority lock before activation wins", async () => {
    const r = await review(),
      req = request(r);
    let unlock!: () => void, locked!: () => void;
    const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
    const revocation = second.sql.begin(async (tx) => {
      await tx`select id from agent_passports where id='a' for update`;
      locked();
      await release;
      await tx`update agent_passports set status='REVOKED' where id='a'`;
    });
    await lockReady;
    const activation = service.confirmReviewedIntent(req, proof(req));
    unlock();
    await revocation;
    expect(await activation).toEqual({
      status: "REJECTED",
      code: "PASSPORT_INACTIVE",
    });
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
  it("keeps upgraded historical mandate semantics and NULL quantity reservations", async () => {
    const m = await activate();
    const legacy = { ...m };
    delete legacy.quantityLimit;
    delete legacy.merchantScope;
    // A separately provisioned historical mandate has no new restrictions/defaults.
    const historical = {
      ...legacy,
      id: "legacy",
      nonce: "historical-mandate-nonce",
    };
    await repo.saveMandate(historical);
    const proposed = proposal(historical, "legacy");
    const oldProposal = { ...proposed };
    delete oldProposal.quantity;
    await repo.saveProposal(oldProposal);
    const result = await new DurableAuthorizationService(
      repo,
    ).authorizeProposal("legacy", "LOW", clock().toISOString());
    expect(result.receipt.decision).toBe("ALLOW");
    expect(result.reservation?.quantity).toBeUndefined();
    expect(
      (await repo.sql`select quantity from authorization_reservations`)[0]
        ?.quantity,
    ).toBeNull();
    expect(await repo.getMandate("legacy")).toEqual(historical);
  });
  it("migration 005 upgrades existing trusted mandates without changing fingerprints", () => {
    expect(upgradedLegacyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  async function waitForLedgerWaiter(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const rows =
        await repo.sql`select pid from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like '%pg_advisory_xact_lock%'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("ACTIVATION_DID_NOT_REACH_LEDGER_BARRIER");
  }
  it("expiry while activation waits at evidence commit rolls everything back", async () => {
    const r = await review(),
      req = request(r);
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const blocker = second.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(731991)`;
      ready();
      await gate;
    });
    await held;
    const pending = service.confirmReviewedIntent(req, proof(req));
    try {
      await waitForLedgerWaiter();
      time = new Date(r.expiresAt);
    } finally {
      release();
      await blocker;
    }
    expect(await pending).toEqual({
      status: "REJECTED",
      code: "AUTHENTICATION_EXPIRED",
    });
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
    expect((await repo.sql`select status from intent_reviews`)[0]?.status).toBe(
      "PENDING",
    );
    expect(
      await repo.sql`select type from evidence_events where type in ('INTENT_MANDATE_ACTIVATED','HUMAN_CONFIRMATION_ACCEPTED')`,
    ).toHaveLength(0);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });
  it("activation holding authority locks wins, but later principal disable blocks financial dispatch", async () => {
    const r = await review(),
      req = request(r);
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const blocker = second.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(731991)`;
      ready();
      await gate;
    });
    await held;
    const pending = service.confirmReviewedIntent(req, proof(req));
    let disabled: Promise<unknown> | undefined;
    try {
      await waitForLedgerWaiter();
      disabled =
        second.sql`update principals set status='DISABLED' where id='p'`.execute();
    } finally {
      release();
      await blocker;
    }
    const result = await pending;
    expect(result.status).toBe("ACTIVATED");
    await disabled;
    if (result.status !== "ACTIVATED") throw new Error("EXPECTED_LOCK_WINNER");
    await repo.saveProposal(proposal(result.mandate, "disabled"));
    await expect(
      new DurableAuthorizationService(repo).authorizeProposal(
        "disabled",
        "LOW",
        clock().toISOString(),
      ),
    ).rejects.toThrow("PRINCIPAL_INACTIVE");
    expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
  });
  it("pending review survives service restart and still requires fresh authentication", async () => {
    const r = await review(),
      req = request(r),
      restarted = new IntentActivationService(second, makeBoundary(), clock);
    expect(
      (await restarted.confirmReviewedIntent(req, { confirmed: true })).status,
    ).toBe("REJECTED");
    expect(
      (await restarted.confirmReviewedIntent(req, proof(req))).status,
    ).toBe("ACTIVATED");
    expect(await repo.sql`select id from mandates`).toHaveLength(1);
  });
  it.each([
    { maximumMinor: 1 },
    { maximumQuantity: 1, capabilities: ["CREATE_ORDER"] },
    { merchantIds: ["eBay"] },
    { currencies: ["EUR"] },
    { maximumLifetimeSeconds: 1 },
  ])("review cannot exceed trusted activation policy %j", async (patch) => {
    await service.provisionPolicy("p", { ...policy, ...patch });
    await expect(review()).rejects.toThrow(
      "ACTIVATION_REQUIREMENTS_UNSATISFIED",
    );
    expect(await repo.sql`select id from intent_reviews`).toHaveLength(0);
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
  it("durable review expiration cannot be extended independently of reviewed terms", async () => {
    const r = await review(),
      req = request(r);
    await repo.sql`update intent_reviews set expires_at=expires_at-interval '1 second' where id=${r.reviewId}`;
    expect(await service.confirmReviewedIntent(req, proof(req))).toEqual({
      status: "REJECTED",
      code: "REVIEW_BINDING_MISMATCH",
    });
  });
  it("a fingerprint from another valid review is not confirmation of this review", async () => {
    const first = await review(),
      second = await review(),
      req = {
        ...request(first),
        reviewedHash: second.reviewedHash,
        challenge: second.challenge,
      };
    expect((await service.confirmReviewedIntent(req, proof(req))).status).toBe(
      "REJECTED",
    );
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
  it.each(["merchant", "quantity"])(
    "post-authorization %s substitution causes zero provider effects",
    async (field) => {
      const m = await activate();
      await repo.saveProposal(proposal(m, "mutated"));
      const authorized = await new DurableAuthorizationService(
        repo,
      ).authorizeProposal("mutated", "LOW", clock().toISOString());
      const keys = generateKeyPairSync("ed25519"),
        issuer = new ExecutionGrantIssuer(repo, "3c", keys.privateKey);
      const token = await issuer.issue(
        authorized.reservation!.id,
        clock().toISOString(),
      );
      if (field === "merchant")
        await repo.sql`update transaction_proposals set document=jsonb_set(document,'{merchant,id}','"eBay"'::jsonb) where id='mutated'`;
      else
        await repo.sql`update transaction_proposals set document=jsonb_set(document,'{quantity}','2'::jsonb) where id='mutated'`;
      let creates = 0,
        effects = 0;
      const provider: PaymentProvider = {
        createOrder() {
          creates++;
          return Promise.reject(new Error("UNEXPECTED_PROVIDER_CALL"));
        },
        captureOrder() {
          effects++;
          return Promise.reject(new Error("UNEXPECTED_PROVIDER_CALL"));
        },
        getOrder() {
          return Promise.reject(new Error("UNEXPECTED_PROVIDER_CALL"));
        },
      };
      const rail = new PayPalExecutionRail(repo, provider, () =>
          clock().toISOString(),
        ),
        executor = new ExecutionBoundary(
          repo,
          new StaticPublicKeyRing(new Map([["3c", keys.publicKey]])),
          rail,
        );
      await expect(
        executor.execute(token, clock().toISOString()),
      ).rejects.toThrow();
      expect(creates).toBe(0);
      expect(effects).toBe(0);
      expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
    },
  );
  it("authentication failure records sanitized rejection without proof, nonce or source", async () => {
    const r = await review(),
      req = request(r);
    const assertion = {
      confirmed: true,
      untrustedCredential: "DO_NOT_PERSIST_TEST_ASSERTION",
    };
    expect((await service.confirmReviewedIntent(req, assertion)).status).toBe(
      "REJECTED",
    );
    const events = await repo.evidence();
    const rejected = events.find(
      (e) => e.type === "INTENT_CONFIRMATION_REJECTED",
    );
    expect(rejected?.data).toEqual({
      code: "ACTIVATION_REQUIREMENTS_UNSATISFIED",
    });
    expect(JSON.stringify(events)).not.toContain(
      "DO_NOT_PERSIST_TEST_ASSERTION",
    );
    expect(JSON.stringify(events)).not.toContain(r.challenge);
    expect(await repo.sql`select id from mandates`).toHaveLength(0);
  });
});
