import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import { DurableCheckoutService } from "../src/checkout.js";
import { FakeControlledCommerceSource } from "../src/controlled-commerce.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import {
  checkoutAuthority,
  checkoutBinding,
  checkoutNow,
} from "./checkout-fixture.js";
import {
  checkoutManifestFingerprint,
  COMMERCE_METADATA_KEYS,
} from "../src/checkout-contracts.js";
import {
  merchantBindingFingerprint,
  MerchantBindingSchema,
} from "../src/commerce.js";
import { mandateFingerprint, proposalDigest } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("M4B immutable durable commerce (real PostgreSQL)", () => {
  let repo: PostgresTrustRepository, other: PostgresTrustRepository;
  let source: FakeControlledCommerceSource, service: DurableCheckoutService;
  let time: Date;
  const clock = () => new Date(time);
  const offer = () => source.listControlledOffers()[0]!;
  const quote = () => service.issueQuote(offer(), "commerce-m", 1);
  async function sealed() {
    const q = await quote();
    return { q, m: await service.sealManifest(q.quoteId) };
  }
  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    other = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    const names = (await readdir("db/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const name of names) {
      // Prove upgrade preserves a pre-commerce authority, not just a fresh empty DB.
      if (name.startsWith("006")) {
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
    expect(await repo.sql`select * from commerce_quotes`).toHaveLength(0);
  });
  afterAll(async () => {
    await repo?.close();
    await other?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    time = new Date(checkoutNow);
    await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
    const f = checkoutAuthority();
    await repo.savePrincipal({
      id: f.mandate.principalId,
      displayName: "Human",
    });
    await repo.saveAgent(f.agent);
    await repo.saveMandate(f.mandate);
    source = new FakeControlledCommerceSource(
      checkoutBinding,
      demoCommerceCatalog(),
    );
    service = new DurableCheckoutService(repo, source, clock);
    await service.registerMerchantBinding();
  });
  it("durably seals complete terms and compiles a normal proposal without financial authority", async () => {
    const { q, m } = await sealed();
    const p = await service.compileManifestProposal(m.manifestId);
    expect(q.totalMinor).toBe(8400);
    expect(m.expectedPayPalMerchantId).toBe("DEMOACCOUNT01");
    expect(m.merchantBindingFingerprint).toBe(q.merchantBindingFingerprint);
    expect(m.controlledOfferFingerprint).toBe(q.controlledOfferFingerprint);
    expect(p.amount.minor).toBe(m.totalMinor);
    expect(p.requestedCapability).toBe("CAPTURE_PAYMENT");
    expect(p.metadata[COMMERCE_METADATA_KEYS.fingerprint]).toBe(
      checkoutManifestFingerprint(m),
    );
    expect(await repo.getProposal(p.id)).toEqual(p);
    for (const table of [
      "authorization_reservations",
      "decision_receipts",
      "execution_grants",
      "payment_attempts",
    ])
      expect(await repo.sql.unsafe(`select * from ${table}`)).toHaveLength(0);
    const evidence = await repo.evidence();
    expect(evidence.map((e) => e.type)).toEqual([
      "COMMERCE_QUOTE_ISSUED",
      "CHECKOUT_MANIFEST_SEALED",
      "CHECKOUT_MANIFEST_PROPOSAL_LINKED",
    ]);
    expect(PostgresTrustRepository.verifyEvidence(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(
      /secret|token|description|authentication/i,
    );
  });
  it("existing deterministic authorization consumes the compiled proposal normally", async () => {
    const { m } = await sealed();
    const p = await service.compileManifestProposal(m.manifestId);
    const result = await new DurableAuthorizationService(
      repo,
    ).authorizeProposal(p.id, "LOW", clock().toISOString());
    expect(result.receipt.decision).toBe("ALLOW");
    expect(result.reservation?.amountMinor).toBe(8400);
    expect(
      await repo.sql`select quantity from authorization_reservations`,
    ).toEqual([expect.objectContaining({ quantity: "1" })]);
    expect(await repo.sql`select * from payment_attempts`).toHaveLength(0);
  });
  it("recovers quote/manifest/proposal with a new connection and source, without reviving provenance", async () => {
    const { q, m } = await sealed();
    const p = await service.compileManifestProposal(m.manifestId);
    await repo.close();
    repo = PostgresTrustRepository.connect(url!);
    const nextSource = new FakeControlledCommerceSource(
      checkoutBinding,
      demoCommerceCatalog(),
    );
    const next = new DurableCheckoutService(repo, nextSource, clock);
    expect(await next.getQuote(q.quoteId)).toEqual(q);
    expect(await next.getManifest(m.manifestId)).toEqual(m);
    expect(await next.compileManifestProposal(m.manifestId)).toEqual(p);
    await expect(
      next.issueQuote(JSON.parse(JSON.stringify(offer())), "commerce-m", 1),
    ).rejects.toThrow("CHECKOUT_NOT_SUPPORTED");
  });
  it.each(["copy", "parsed", "foreign", "discovery"])(
    "rejects %s input before a quote can exist",
    async (kind) => {
      const input: unknown =
        kind === "copy"
          ? { ...offer() }
          : kind === "parsed"
            ? JSON.parse(JSON.stringify(offer()))
            : kind === "foreign"
              ? new FakeControlledCommerceSource(
                  checkoutBinding,
                  demoCommerceCatalog(),
                ).listControlledOffers()[0]
              : {
                  ...offer(),
                  checkoutSupported: true,
                  expectedPayPalMerchantId: "DEMOACCOUNT01",
                };
      await expect(service.issueQuote(input, "commerce-m", 1)).rejects.toThrow(
        "CHECKOUT_NOT_SUPPORTED",
      );
      expect(await repo.sql`select * from commerce_quotes`).toHaveLength(0);
    },
  );
  it("rejects USED under NEW authority", async () => {
    await expect(
      service.issueQuote(source.listControlledOffers()[2], "commerce-m", 1),
    ).rejects.toThrow("CONDITION_DENIED");
    expect(await repo.sql`select * from commerce_quotes`).toHaveLength(0);
  });
  it("availability cannot widen human quantity authority", async () => {
    const f = checkoutAuthority();
    const m = {
      ...f.mandate,
      maxSingleTransactionMinor: 84000,
      cumulativeLimitMinor: 84000,
      autonomousPurchaseThresholdMinor: 84000,
      humanApprovalThresholdMinor: 84000,
    };
    await repo.sql`update mandates set document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)},cumulative_limit_minor=${m.cumulativeLimitMinor} where id=${m.id}`;
    await expect(service.issueQuote(offer(), "commerce-m", 10)).rejects.toThrow(
      "QUANTITY_EXHAUSTED",
    );
    expect((await repo.getMandate("commerce-m"))!.quantityLimit).toBe(1);
  });
  it("availability can narrow an otherwise permitted quantity", async () => {
    const catalog = demoCommerceCatalog();
    catalog.offers[0]!.availableQuantity = 0;
    const s = new FakeControlledCommerceSource(checkoutBinding, catalog);
    await expect(
      new DurableCheckoutService(repo, s, clock).issueQuote(
        s.listControlledOffers()[0],
        "commerce-m",
        1,
      ),
    ).rejects.toThrow("COMMERCE_AVAILABILITY_INSUFFICIENT");
  });
  it.each([
    ["amount", { maxSingleTransactionMinor: 8000 }, "AMOUNT_EXCEEDS_LIMIT"],
    ["currency", { currency: "EUR" }, "CURRENCY_MISMATCH"],
    [
      "merchant",
      { merchantScope: { mode: "ONLY", ids: ["other-merchant"] } },
      "MERCHANT_NOT_ALLOWED",
    ],
    ["category", { category: "HEADPHONES" }, "CATEGORY_DENIED"],
    ["quantity", { quantityLimit: undefined }, "QUANTITY_EXHAUSTED"],
    [
      "capability",
      { allowedCapabilities: ["CREATE_ORDER"] },
      "CAPABILITY_DENIED",
    ],
  ])(
    "rechecks current %s authority, without producing authorization",
    async (_label, patch, code) => {
      const f = checkoutAuthority();
      const m = {
        ...f.mandate,
        ...patch,
        ...(_label === "amount"
          ? {
              autonomousPurchaseThresholdMinor: 8000,
              humanApprovalThresholdMinor: 8000,
            }
          : {}),
      } as typeof f.mandate;
      await repo.sql`update mandates set document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)} where id=${m.id}`;
      await expect(quote()).rejects.toThrow(code);
      expect(
        await repo.sql`select * from authorization_reservations`,
      ).toHaveLength(0);
    },
  );
  it("detects stale owner snapshot after authority changes", async () => {
    const q = await quote();
    const f = checkoutAuthority();
    const m = { ...f.mandate, nonce: "different-mandate-nonce" };
    await repo.sql`update mandates set nonce=${m.nonce},document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)} where id=${m.id}`;
    await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
      "COMMERCE_OWNER_STALE",
    );
    expect(await repo.sql`select * from checkout_manifests`).toHaveLength(0);
  });
  it.each(["SUSPENDED", "REVOKED"])(
    "rejects a %s agent at seal time",
    async (status) => {
      const q = await quote();
      await repo.sql`update agent_passports set status=${status} where id='commerce-a'`;
      await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
        "COMMERCE_AUTHORITY_INACTIVE",
      );
    },
  );
  it("rejects revoked mandate and disabled principal", async () => {
    const q = await quote();
    await repo.sql`update mandates set revoked_at=${clock().toISOString()} where id='commerce-m'`;
    await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
      "MANDATE_REVOKED",
    );
    await repo.sql`update mandates set revoked_at=null where id='commerce-m'`;
    await repo.sql`update principals set status='DISABLED' where id='commerce-p'`;
    await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
      "PRINCIPAL_INACTIVE",
    );
  });
  it("expiration persists across restart and backward clock; reissue gets a new identity", async () => {
    const q = await quote();
    time = new Date(q.expiresAt);
    await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
      "COMMERCE_QUOTE_EXPIRED",
    );
    time = new Date(checkoutNow);
    await expect(
      new DurableCheckoutService(other, source, clock).sealManifest(q.quoteId),
    ).rejects.toThrow("COMMERCE_QUOTE_EXPIRED");
    const next = await quote();
    expect(next.quoteId).not.toBe(q.quoteId);
    expect(
      (await repo.evidence()).filter(
        (e) => e.type === "COMMERCE_QUOTE_EXPIRED",
      ),
    ).toHaveLength(1);
  });
  it("expired manifest cannot be linked to a new proposal", async () => {
    const { q, m } = await sealed();
    time = new Date(q.expiresAt);
    await expect(service.compileManifestProposal(m.manifestId)).rejects.toThrow(
      "COMMERCE_QUOTE_EXPIRED",
    );
    expect(await repo.sql`select * from transaction_proposals`).toHaveLength(0);
  });
  it("two independent PostgreSQL workers seal/link one coherent relationship", async () => {
    const q = await quote();
    const second = new DurableCheckoutService(other, source, clock);
    const [a, b] = await Promise.all([
      service.sealManifest(q.quoteId),
      second.sealManifest(q.quoteId),
    ]);
    expect(a.manifestId).toBe(b.manifestId);
    const [p1, p2] = await Promise.all([
      service.compileManifestProposal(a.manifestId),
      second.compileManifestProposal(b.manifestId),
    ]);
    expect(p1.id).toBe(p2.id);
    expect(proposalDigest(p1)).toBe(proposalDigest(p2));
    expect(await repo.sql`select * from checkout_manifests`).toHaveLength(1);
    expect(
      await repo.sql`select * from checkout_manifest_proposals`,
    ).toHaveLength(1);
    expect(
      await repo.sql`select * from authorization_reservations`,
    ).toHaveLength(0);
    expect(
      (await repo.evidence()).filter(
        (e) => e.type === "CHECKOUT_MANIFEST_SEALED",
      ),
    ).toHaveLength(1);
  });
  it("quote lock wait crossing expiry fails closed (no sleeps)", async () => {
    const q = await quote();
    let unblock!: () => void, locked!: () => void;
    const acquired = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    const blocker = other.sql.begin(async (tx) => {
      await tx`select id from commerce_quotes where id=${q.quoteId} for update`;
      locked();
      await gate;
    });
    await acquired;
    const pending = service.sealManifest(q.quoteId);
    // Query actual PostgreSQL wait state, not merely start two promises sequentially.
    for (let n = 0; n < 200; n++) {
      const rows =
        await other.sql`select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%commerce_quotes%'`;
      if (rows.length) break;
      if (n === 199) throw new Error("LOCK_WAIT_NOT_OBSERVED");
    }
    time = new Date(q.expiresAt);
    unblock();
    await blocker;
    await expect(pending).rejects.toThrow("COMMERCE_QUOTE_EXPIRED");
    expect(await repo.sql`select * from checkout_manifests`).toHaveLength(0);
  });
  it.each(["seal", "link"])(
    "expiry after %s evidence rolls back all identity writes but preserves expiry",
    async (stage) => {
      const q = await quote();
      const m =
        stage === "link" ? await service.sealManifest(q.quoteId) : undefined;
      const original = repo.appendEvidenceInTransaction.bind(repo);
      vi.spyOn(repo, "appendEvidenceInTransaction").mockImplementation(
        async (...args) => {
          const result = await original(...args);
          if (
            args[1] ===
            (stage === "seal"
              ? "CHECKOUT_MANIFEST_SEALED"
              : "CHECKOUT_MANIFEST_PROPOSAL_LINKED")
          )
            time = new Date(q.expiresAt);
          return result;
        },
      );
      await expect(
        stage === "seal"
          ? service.sealManifest(q.quoteId)
          : service.compileManifestProposal(m!.manifestId),
      ).rejects.toThrow("COMMERCE_QUOTE_EXPIRED_AT_COMMIT");
      expect(await repo.sql`select * from transaction_proposals`).toHaveLength(
        0,
      );
      expect(await repo.sql`select * from checkout_manifests`).toHaveLength(
        stage === "seal" ? 0 : 1,
      );
      time = new Date(checkoutNow);
      await expect(service.sealManifest(q.quoteId)).rejects.toThrow(
        "COMMERCE_QUOTE_EXPIRED",
      );
      const events = await repo.evidence();
      expect(PostgresTrustRepository.verifyEvidence(events)).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type ===
            (stage === "seal"
              ? "CHECKOUT_MANIFEST_SEALED"
              : "CHECKOUT_MANIFEST_PROPOSAL_LINKED"),
        ),
      ).toBe(false);
    },
  );
  it("binding revisions cannot reinterpret a sealed manifest or be downgraded", async () => {
    const { q, m } = await sealed();
    const newer = source.withMerchantBinding({
      ...checkoutBinding,
      bindingRevision: 2,
      expectedPayPalMerchantId: "DEMOACCOUNT02",
    });
    await new DurableCheckoutService(
      other,
      newer,
      clock,
    ).registerMerchantBinding();
    expect(await service.getManifest(m.manifestId)).toEqual(m);
    expect(await service.getQuote(q.quoteId)).toEqual(q);
    await expect(service.compileManifestProposal(m.manifestId)).rejects.toThrow(
      "MERCHANT_BINDING_STALE",
    );
    await expect(service.registerMerchantBinding()).rejects.toThrow(
      "MERCHANT_BINDING_STALE",
    );
    expect(
      await repo.sql`select * from commerce_merchant_bindings`,
    ).toHaveLength(2);
    await expect(
      repo.sql`update commerce_merchant_heads set revision=1`,
    ).rejects.toThrow("MERCHANT_BINDING_REVISION_REQUIRED");
  });
  it("same revision cannot change expected recipient", async () => {
    const s = new FakeControlledCommerceSource(
      { ...checkoutBinding, expectedPayPalMerchantId: "DEMOACCOUNT02" },
      demoCommerceCatalog(),
    );
    await expect(
      new DurableCheckoutService(other, s, clock).registerMerchantBinding(),
    ).rejects.toThrow("COMMERCE_BINDING_CORRUPT");
  });
  it("inactive current binding cannot issue a quote", async () => {
    const next = source.withMerchantBinding({
      ...checkoutBinding,
      bindingRevision: 2,
      active: false,
    });
    const s = new DurableCheckoutService(other, next, clock);
    await s.registerMerchantBinding();
    await expect(
      s.issueQuote(next.listControlledOffers()[0], "commerce-m", 1),
    ).rejects.toThrow("MERCHANT_BINDING_INACTIVE");
    expect((await repo.getMandate("commerce-m"))!.quantityLimit).toBe(1);
  });
  it("sealing winning the head lock retains old identity; later revision prevents linking", async () => {
    const q = await quote();
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const next = source.withMerchantBinding({
      ...checkoutBinding,
      bindingRevision: 2,
    });
    const blocker = other.sql.begin(async (tx) => {
      await tx`select revision from commerce_merchant_heads for update`;
      locked();
      await gate;
    });
    await held;
    const pending = service.sealManifest(q.quoteId);
    for (let n = 0; n < 200; n++) {
      const rows =
        await other.sql`select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%commerce_merchant_heads%'`;
      if (rows.length) break;
      if (n === 199) throw new Error("LOCK_WAIT_NOT_OBSERVED");
    }
    // The real provisioning transaction must wait for that same head lock too.
    release();
    await blocker;
    await pending;
    await new DurableCheckoutService(
      other,
      next,
      clock,
    ).registerMerchantBinding();
    await expect(
      service.compileManifestProposal(
        (await repo.sql`select id from checkout_manifests`)[0]!.id as string,
      ),
    ).rejects.toThrow("MERCHANT_BINDING_STALE");
  });
  it("binding revision commit winning a PostgreSQL head lock prevents old sealing", async () => {
    const q = await quote();
    const b = MerchantBindingSchema.parse({
      ...checkoutBinding,
      bindingRevision: 2,
      expectedPayPalMerchantId: "DEMOACCOUNT02",
    });
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => {
      acquired = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const update = other.sql.begin(async (tx) => {
      await tx`select revision from commerce_merchant_heads for update`;
      await tx`insert into commerce_merchant_bindings(merchant_id,revision,checkout_source_id,environment,expected_recipient,active,fingerprint,document,document_hash,created_at) values(${b.logicalMerchantId},${b.bindingRevision},${b.checkoutSourceId},${b.environment},${b.expectedPayPalMerchantId},${b.active},${merchantBindingFingerprint(b)},${tx.json(b)},encode(sha256(convert_to(${tx.json(b)}::jsonb::text,'UTF8')),'hex'),${checkoutNow})`;
      await tx`update commerce_merchant_heads set revision=2`;
      acquired();
      await gate;
    });
    await ready;
    const pending = service.sealManifest(q.quoteId);
    for (let n = 0; n < 200; n++) {
      const rows =
        await other.sql`select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%commerce_merchant_heads%'`;
      if (rows.length) break;
      if (n === 199) {
        release();
        throw new Error("LOCK_WAIT_NOT_OBSERVED");
      }
    }
    release();
    await update;
    await expect(pending).rejects.toThrow("MERCHANT_BINDING_STALE");
    expect(await repo.sql`select * from checkout_manifests`).toHaveLength(0);
    expect(await service.getQuote(q.quoteId)).toEqual(q);
  });
  it("catalog replacement changes new terms without mutating old immutable snapshots", async () => {
    const { q, m } = await sealed();
    const catalog = demoCommerceCatalog();
    catalog.catalogRevision = 2;
    for (const o of catalog.offers) o.catalogRevision = 2;
    catalog.offers[0]!.unitPrice.minor = 8500;
    const s = new FakeControlledCommerceSource(checkoutBinding, catalog);
    const next = new DurableCheckoutService(other, s, clock);
    const q2 = await next.issueQuote(
      s.listControlledOffers()[0],
      "commerce-m",
      1,
    );
    const m2 = await next.sealManifest(q2.quoteId);
    expect(q2.unitAmountMinor).toBe(8500);
    expect(checkoutManifestFingerprint(m2)).not.toBe(
      checkoutManifestFingerprint(m),
    );
    expect(await next.getQuote(q.quoteId)).toEqual(q);
    expect(await next.getManifest(m.manifestId)).toEqual(m);
  });
  it("DB rejects quote/manifest/linked proposal mutation and conflicting ownership", async () => {
    const { q, m } = await sealed();
    const p = await service.compileManifestProposal(m.manifestId);
    await expect(
      repo.sql`update commerce_quotes set quantity=10 where id=${q.quoteId}`,
    ).rejects.toThrow("IMMUTABLE_COMMERCE_RECORD");
    await expect(
      repo.sql`update commerce_quotes set principal_id='attacker' where id=${q.quoteId}`,
    ).rejects.toThrow("IMMUTABLE_COMMERCE_RECORD");
    await expect(
      repo.sql`update checkout_manifests set document=jsonb_set(document,'{expectedPayPalMerchantId}','"DEMOACCOUNT02"') where id=${m.manifestId}`,
    ).rejects.toThrow("IMMUTABLE_COMMERCE_RECORD");
    await expect(
      repo.sql`update transaction_proposals set amount_minor=18400 where id=${p.id}`,
    ).rejects.toThrow("IMMUTABLE_COMMERCE_PROPOSAL");
    await expect(
      repo.sql`insert into checkout_manifests select 'another',quote_id,fingerprint,document,document_hash,sealed_at from checkout_manifests`,
    ).rejects.toThrow();
    expect(await repo.getProposal(p.id)).toEqual(p);
  });
  it("generic proposal API and deferred DB check reject fabricated reserved metadata", async () => {
    const { m } = await sealed();
    const p = await service.compileManifestProposal(m.manifestId);
    const forged = {
      ...p,
      id: "forged-proposal",
      nonce: "forged-proposal-nonce",
      metadata: {
        ...p.metadata,
        [COMMERCE_METADATA_KEYS.fingerprint]: "f".repeat(64),
      },
    };
    await expect(repo.saveProposal(forged)).rejects.toThrow(
      "RESERVED_COMMERCE_METADATA",
    );
    await expect(
      repo.sql.begin(async (tx) => {
        await tx`insert into transaction_proposals(id,mandate_id,agent_id,nonce,amount_minor,currency,document,proposed_at) values(${forged.id},${forged.mandateId},${forged.agentId},${forged.nonce},${forged.amount.minor},${forged.amount.currency},${tx.json(forged)},${forged.proposedAt})`;
      }),
    ).rejects.toThrow("COMMERCE_PROPOSAL_LINK_INVALID");
    expect(await repo.sql`select * from transaction_proposals`).toHaveLength(1);
  });
  it("single-column quote corruption cannot become financial authorization", async () => {
    const {q,m} = await sealed(); const p = await service.compileManifestProposal(m.manifestId);
    await repo.sql`alter table commerce_quotes disable trigger immutable_commerce_quote`;
    try {await repo.sql`update commerce_quotes set shipping_minor=1,total_minor=8401 where id=${q.quoteId}`;}
    finally {await repo.sql`alter table commerce_quotes enable trigger immutable_commerce_quote`;}
    await expect(service.getQuote(q.quoteId)).rejects.toThrow("COMMERCE_QUOTE_CORRUPT");
    await expect(repo.getProposal(p.id)).rejects.toThrow("COMMERCE_PROPOSAL_LINK_INVALID");
    await expect(new DurableAuthorizationService(repo).authorizeProposal(p.id,"LOW",checkoutNow)).rejects.toThrow("COMMERCE_PROPOSAL_LINK_INVALID");
    expect(await repo.sql`select * from authorization_reservations`).toHaveLength(0);
  });
  it.each([
    "recipient",
    "sku",
    "variant",
    "owner",
    "fingerprint",
    "quantity",
    "shipping",
  ])(
    "corrupted %s manifest fails closed even with DB protection deliberately disabled",
    async (field) => {
      const { m } = await sealed();
      const p = await service.compileManifestProposal(m.manifestId);
      const broken = { ...m, variant: { ...m.variant }, owner: { ...m.owner } };
      if (field === "recipient")
        broken.expectedPayPalMerchantId = "DEMOACCOUNT02";
      if (field === "sku") broken.sku = "PF-OTHER";
      if (field === "variant") broken.variant.switchType = "RED";
      if (field === "owner") broken.owner.principalId = "other-principal";
      if (field === "quantity") broken.quantity = 10;
      if (field === "shipping") broken.shippingMinor = 1200;
      await repo.sql`alter table checkout_manifests disable trigger immutable_checkout_manifest`;
      try {
        await repo.sql`update checkout_manifests set document=${repo.sql.json(broken)},document_hash=encode(sha256(convert_to(${repo.sql.json(broken)}::jsonb::text,'UTF8')),'hex'),fingerprint=${field === "fingerprint" ? "f".repeat(64) : checkoutManifestFingerprint(m)} where id=${m.manifestId}`;
      } finally {
        await repo.sql`alter table checkout_manifests enable trigger immutable_checkout_manifest`;
      }
      await expect(service.getManifest(m.manifestId)).rejects.toThrow();
      await expect(repo.getProposal(p.id)).rejects.toThrow();
      expect(
        await repo.sql`select * from authorization_reservations`,
      ).toHaveLength(0);
    },
  );
});
