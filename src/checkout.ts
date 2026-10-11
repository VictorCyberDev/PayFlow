import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { mandateFingerprint, proposalDigest } from "./canonical.js";
import {
  TransactionProposalSchema,
  type Mandate,
  type TransactionProposal,
} from "./domain.js";
import type { FakeControlledCommerceSource } from "./controlled-commerce.js";
import {
  ControlledOfferSchema,
  DEMO_MERCHANT_NAME,
  MerchantBindingSchema,
  controlledOfferFingerprint,
  merchantBindingFingerprint,
  type MerchantBinding,
} from "./commerce.js";
import { type PostgresTrustRepository, persistedDate } from "./persistence.js";
import {
  CHECKOUT_QUOTE_TTL_MS,
  COMMERCE_METADATA_KEYS,
  CheckoutManifestSchema,
  CheckoutOwnerSchema,
  CheckoutQuoteSchema,
  checkoutManifestFingerprint,
  checkoutQuoteFingerprint,
  freezeCheckout,
  type CheckoutManifest,
  type CheckoutOwner,
  type CheckoutQuote,
} from "./checkout-contracts.js";

export class CheckoutError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CheckoutError";
  }
}
function fail(code: string): never {
  throw new CheckoutError(code);
}
class QuoteBoundaryExpired extends CheckoutError {
  constructor(
    readonly quote: CheckoutQuote,
    readonly observedAt: string,
  ) {
    super("COMMERCE_QUOTE_EXPIRED_AT_COMMIT");
  }
}
function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object")
    return fail("COMMERCE_PERSISTED_STATE_INVALID");
  return raw as Record<string, unknown>;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Trusted host composition. No authentication, authorization/reservation,
 * grants, payment attempts or provider calls. Caller IDs are lookup keys, not
 * authentication assertions; the host must restrict access to owned workflows.
 */
export class DurableCheckoutService {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly source: FakeControlledCommerceSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now(): string {
    const value = this.clock();
    if (!Number.isFinite(value.getTime()))
      return fail("COMMERCE_CLOCK_INVALID");
    return value.toISOString();
  }
  private async transaction<T>(operation: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      return (await this.repo.sql.begin(operation)) as T;
    } catch (error) {
      if (error instanceof QuoteBoundaryExpired) {
        // The failed seal/link has rolled back. Persist only the independently
        // observed expiry, so clock rollback cannot resurrect the quote.
        await this.repo.sql.begin(async (tx) => {
          await this.quoteRecord(error.quote.quoteId, tx, true);
          await this.markExpired(tx, error.quote, error.observedAt);
        });
      }
      if (error instanceof CheckoutError) {
        // Failed transactions have rolled back. Rejection carries no untrusted
        // claimed principal/owner, body, authentication proof or provider data.
        await this.repo.appendEvidence(
          "COMMERCE_BINDING_REJECTED",
          { code: error.code },
          this.now(),
        );
      }
      throw error;
    }
  }
  private async binding(
    tx: Sql,
    merchantId: string,
    revision: number,
    expectedFingerprint: string,
  ): Promise<MerchantBinding> {
    const rows =
      await tx`select *,encode(sha256(convert_to(document::text,'UTF8')),'hex') actual_hash from commerce_merchant_bindings where merchant_id=${merchantId} and revision=${revision}`;
    if (!rows[0]) return fail("MERCHANT_BINDING_MISSING");
    const r = record(rows[0]);
    const b = MerchantBindingSchema.parse(r.document);
    if (
      r.document_hash !== r.actual_hash ||
      b.logicalMerchantId !== r.merchant_id ||
      b.bindingRevision !== Number(r.revision) ||
      b.checkoutSourceId !== r.checkout_source_id ||
      b.environment !== r.environment ||
      b.expectedPayPalMerchantId !== r.expected_recipient ||
      b.active !== r.active ||
      merchantBindingFingerprint(b) !== r.fingerprint ||
      r.fingerprint !== expectedFingerprint
    )
      return fail("COMMERCE_BINDING_CORRUPT");
    return Object.freeze(b);
  }
  private async currentBinding(
    tx: Sql,
    b: MerchantBinding,
    fingerprint: string,
  ): Promise<void> {
    const heads =
      await tx`select revision from commerce_merchant_heads where merchant_id=${b.logicalMerchantId} for update`;
    if (!heads[0] || Number(heads[0].revision) !== b.bindingRevision)
      return fail("MERCHANT_BINDING_STALE");
    await this.binding(tx, b.logicalMerchantId, b.bindingRevision, fingerprint);
    if (!b.active) return fail("MERCHANT_BINDING_INACTIVE");
  }
  async registerMerchantBinding(): Promise<void> {
    const b = this.source.getMerchantBinding();
    const fingerprint = merchantBindingFingerprint(b);
    await this.transaction(async (tx) => {
      // Serializes initial provisioning as well as revision advancement.
      await tx`select pg_advisory_xact_lock(hashtextextended(${"payflow-commerce-binding:" + b.logicalMerchantId},0))`;
      const heads =
        await tx`select revision from commerce_merchant_heads where merchant_id=${b.logicalMerchantId} for update`;
      if (heads[0] && Number(heads[0].revision) > b.bindingRevision)
        return fail("MERCHANT_BINDING_STALE");
      if (heads[0] && Number(heads[0].revision) === b.bindingRevision) {
        await this.binding(
          tx,
          b.logicalMerchantId,
          b.bindingRevision,
          fingerprint,
        );
        return;
      }
      const now = this.now();
      await tx`insert into commerce_merchant_bindings(merchant_id,revision,checkout_source_id,environment,expected_recipient,active,fingerprint,document,document_hash,created_at) values(${b.logicalMerchantId},${b.bindingRevision},${b.checkoutSourceId},${b.environment},${b.expectedPayPalMerchantId},${b.active},${fingerprint},${tx.json(b)},encode(sha256(convert_to(${tx.json(b)}::jsonb::text,'UTF8')),'hex'),${now})`;
      await tx`insert into commerce_merchant_heads(merchant_id,revision) values(${b.logicalMerchantId},${b.bindingRevision}) on conflict(merchant_id) do update set revision=excluded.revision`;
    });
  }
  private async authority(
    tx: Sql,
    mandateId: string,
    expected?: CheckoutOwner,
  ) {
    const mandate = await this.repo.getMandate(mandateId, tx, true);
    if (!mandate) return fail("MANDATE_NOT_FOUND");
    await this.repo.assertMandateActive(mandate.id, tx);
    const agent = await this.repo.getAgent(mandate.authorizedAgentId, tx);
    await this.repo.assertPrincipalActive(mandate.principalId, tx);
    const now = this.now();
    if (
      !agent ||
      agent.principalId !== mandate.principalId ||
      agent.status !== "ACTIVE" ||
      Date.parse(now) < Date.parse(agent.issuedAt) ||
      Date.parse(now) >= Date.parse(agent.expiresAt) ||
      Date.parse(now) < Date.parse(mandate.createdAt) ||
      Date.parse(now) >= Date.parse(mandate.expiresAt)
    )
      return fail("COMMERCE_AUTHORITY_INACTIVE");
    if (
      !agent.capabilities.includes("CAPTURE_PAYMENT") ||
      !mandate.allowedCapabilities.includes("CAPTURE_PAYMENT")
    )
      return fail("CAPABILITY_DENIED");
    const owner = CheckoutOwnerSchema.parse({
      principalId: mandate.principalId,
      agentId: agent.id,
      mandateId: mandate.id,
      mandateFingerprint: mandateFingerprint(mandate),
    });
    if (expected && !same(owner, expected)) return fail("COMMERCE_OWNER_STALE");
    return { mandate, agent, owner, now };
  }
  private termsWithinMandate(
    m: Mandate,
    v: {
      currency: string;
      quantity: number;
      condition: string;
      totalMinor: number;
      logicalMerchantId: string;
    },
  ): void {
    // Projection bounds only. The normal kernel still owns risk, cumulative
    // accounting, replay, approval thresholds and the actual ALLOW decision.
    if (v.currency !== m.currency) return fail("CURRENCY_MISMATCH");
    if (!m.allowedConditions.some((c) => c === v.condition))
      return fail("CONDITION_DENIED");
    if (m.category !== "KEYBOARD") return fail("CATEGORY_DENIED");
    if (v.totalMinor > m.maxSingleTransactionMinor)
      return fail("AMOUNT_EXCEEDS_LIMIT");
    if (m.quantityLimit === undefined || v.quantity > m.quantityLimit)
      return fail("QUANTITY_EXHAUSTED");
    if (
      m.merchantScope?.mode === "ONLY" &&
      !m.merchantScope.ids.includes(v.logicalMerchantId)
    )
      return fail("MERCHANT_NOT_ALLOWED");
  }
  private timeWithinAuthority(
    m: Mandate,
    agentExpiry: string,
    now: string,
  ): void {
    const at = Date.parse(now);
    if (
      at < Date.parse(m.createdAt) ||
      at >= Date.parse(m.expiresAt) ||
      at >= Date.parse(agentExpiry)
    )
      return fail("COMMERCE_AUTHORITY_INACTIVE");
  }
  async issueQuote(
    candidate: unknown,
    mandateId: string,
    quantity: number,
  ): Promise<CheckoutQuote> {
    const support = this.source.resolveCheckoutSupport(candidate);
    if (support.status !== "SUPPORTED_CHECKOUT") return fail(support.reason);
    const offer = ControlledOfferSchema.parse(candidate);
    z.number().int().safe().positive().max(1000).parse(quantity);
    if (quantity > offer.availableQuantity)
      return fail("COMMERCE_AVAILABILITY_INSUFFICIENT");
    return this.transaction(async (tx) => {
      const authority = await this.authority(tx, mandateId);
      await this.currentBinding(
        tx,
        support.binding,
        support.bindingFingerprint,
      );
      const quotedAt = this.now();
      this.timeWithinAuthority(
        authority.mandate,
        authority.agent.expiresAt,
        quotedAt,
      );
      const expiresAt = new Date(
        Math.min(
          Date.parse(quotedAt) + CHECKOUT_QUOTE_TTL_MS,
          Date.parse(authority.mandate.expiresAt),
          Date.parse(authority.agent.expiresAt),
        ),
      ).toISOString();
      const subtotal = BigInt(offer.unitPrice.minor) * BigInt(quantity);
      if (subtotal > BigInt(Number.MAX_SAFE_INTEGER))
        return fail("CHECKOUT_ARITHMETIC_INVALID");
      const quote = CheckoutQuoteSchema.parse({
        version: "payflow.checkout-quote.v1",
        quoteId: randomUUID(),
        checkoutSourceId: support.binding.checkoutSourceId,
        logicalMerchantId: support.binding.logicalMerchantId,
        merchantBindingRevision: support.binding.bindingRevision,
        merchantBindingFingerprint: support.bindingFingerprint,
        controlledOfferFingerprint: support.offerFingerprint,
        productFamilyId: offer.productFamilyId,
        offerId: offer.offerId,
        catalogRevision: offer.catalogRevision,
        sku: offer.sku,
        variant: offer.variant,
        condition: offer.condition,
        quantity,
        unitAmountMinor: offer.unitPrice.minor,
        subtotalMinor: Number(subtotal),
        taxMinor: 0,
        shippingMinor: 0,
        customerDiscountMinor: 0,
        customerFeeMinor: 0,
        totalMinor: Number(subtotal),
        currency: offer.unitPrice.currency,
        quotedAt,
        expiresAt,
        provenanceReference: offer.sourceId + "/" + offer.offerId,
      });
      this.termsWithinMandate(authority.mandate, quote);
      const fp = checkoutQuoteFingerprint(quote),
        o = authority.owner;
      await tx`insert into commerce_quotes(id,merchant_id,binding_revision,binding_fingerprint,principal_id,agent_id,mandate_id,mandate_fingerprint,document,fingerprint,document_hash,offer_document,offer_document_hash,quantity,unit_minor,subtotal_minor,tax_minor,shipping_minor,discount_minor,fee_minor,total_minor,currency,quoted_at,expires_at) values(${quote.quoteId},${quote.logicalMerchantId},${quote.merchantBindingRevision},${quote.merchantBindingFingerprint},${o.principalId},${o.agentId},${o.mandateId},${o.mandateFingerprint},${tx.json(quote)},${fp},encode(sha256(convert_to(${tx.json(quote)}::jsonb::text,'UTF8')),'hex'),${tx.json(offer)},encode(sha256(convert_to(${tx.json(offer)}::jsonb::text,'UTF8')),'hex'),${quote.quantity},${quote.unitAmountMinor},${quote.subtotalMinor},${quote.taxMinor},${quote.shippingMinor},${quote.customerDiscountMinor},${quote.customerFeeMinor},${quote.totalMinor},${quote.currency},${quote.quotedAt},${quote.expiresAt})`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        "COMMERCE_QUOTE_ISSUED",
        {
          quoteId: quote.quoteId,
          quoteFingerprint: fp,
          offerFingerprint: quote.controlledOfferFingerprint,
          bindingFingerprint: quote.merchantBindingFingerprint,
          bindingRevision: quote.merchantBindingRevision,
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          principalId: o.principalId,
          agentId: o.agentId,
          mandateId: o.mandateId,
        },
        quotedAt,
      );
      this.timeWithinAuthority(
        authority.mandate,
        authority.agent.expiresAt,
        this.now(),
      );
      if (Date.parse(this.now()) >= Date.parse(expiresAt))
        return fail("COMMERCE_QUOTE_EXPIRED_DURING_ISSUANCE");
      return freezeCheckout(quote);
    });
  }
  private async quoteRecord(id: string, tx: Sql, lock = false) {
    z.string().uuid().parse(id);
    const rows = lock
      ? await tx`select *,encode(sha256(convert_to(document::text,'UTF8')),'hex') actual_hash,encode(sha256(convert_to(offer_document::text,'UTF8')),'hex') actual_offer_hash from commerce_quotes where id=${id} for update`
      : await tx`select *,encode(sha256(convert_to(document::text,'UTF8')),'hex') actual_hash,encode(sha256(convert_to(offer_document::text,'UTF8')),'hex') actual_offer_hash from commerce_quotes where id=${id}`;
    if (!rows[0]) return fail("COMMERCE_QUOTE_NOT_FOUND");
    const r = record(rows[0]),
      q = CheckoutQuoteSchema.parse(r.document),
      offer = ControlledOfferSchema.parse(r.offer_document);
    const owner = CheckoutOwnerSchema.parse({
      principalId: r.principal_id,
      agentId: r.agent_id,
      mandateId: r.mandate_id,
      mandateFingerprint: r.mandate_fingerprint,
    });
    const columns = {
      quantity: r.quantity,
      unitAmountMinor: r.unit_minor,
      subtotalMinor: r.subtotal_minor,
      taxMinor: r.tax_minor,
      shippingMinor: r.shipping_minor,
      customerDiscountMinor: r.discount_minor,
      customerFeeMinor: r.fee_minor,
      totalMinor: r.total_minor,
    };
    if (
      q.quoteId !== r.id ||
      q.logicalMerchantId !== r.merchant_id ||
      q.merchantBindingRevision !== Number(r.binding_revision) ||
      q.merchantBindingFingerprint !== r.binding_fingerprint ||
      checkoutQuoteFingerprint(q) !== r.fingerprint ||
      r.document_hash !== r.actual_hash ||
      r.offer_document_hash !== r.actual_offer_hash ||
      controlledOfferFingerprint(offer) !== q.controlledOfferFingerprint ||
      offer.productFamilyId !== q.productFamilyId ||
      offer.offerId !== q.offerId ||
      offer.sku !== q.sku ||
      !same(offer.variant, q.variant) ||
      offer.condition !== q.condition ||
      offer.unitPrice.minor !== q.unitAmountMinor ||
      offer.unitPrice.currency !== q.currency ||
      offer.catalogRevision !== q.catalogRevision ||
      q.quantity > offer.availableQuantity ||
      q.currency !== r.currency ||
      q.quotedAt !== persistedDate(r.quoted_at).toISOString() ||
      q.expiresAt !== persistedDate(r.expires_at).toISOString() ||
      Object.entries(columns).some(
        ([k, v]) => Number(v) !== q[k as keyof typeof columns],
      )
    )
      return fail("COMMERCE_QUOTE_CORRUPT");
    const binding = await this.binding(
      tx,
      q.logicalMerchantId,
      q.merchantBindingRevision,
      q.merchantBindingFingerprint,
    );
    return { quote: freezeCheckout(q), owner, binding };
  }
  async getQuote(id: string): Promise<CheckoutQuote> {
    return (await this.quoteRecord(id, this.repo.sql)).quote;
  }
  private async quoteLive(tx: Sql, q: CheckoutQuote): Promise<boolean> {
    const expired =
      await tx`select quote_id from commerce_quote_expirations where quote_id=${q.quoteId}`;
    const now = this.now();
    if (Date.parse(now) < Date.parse(q.quotedAt))
      return fail("COMMERCE_CLOCK_ROLLBACK");
    if (expired.length || Date.parse(now) >= Date.parse(q.expiresAt)) {
      await this.markExpired(tx, q, now);
      return false;
    }
    return true;
  }
  private async markExpired(
    tx: Sql,
    q: CheckoutQuote,
    at: string,
  ): Promise<void> {
    const rows =
      await tx`insert into commerce_quote_expirations(quote_id,observed_at) values(${q.quoteId},${at}) on conflict do nothing returning quote_id`;
    if (rows.length)
      await this.repo.appendEvidenceInTransaction(
        tx,
        "COMMERCE_QUOTE_EXPIRED",
        { quoteId: q.quoteId, quoteFingerprint: checkoutQuoteFingerprint(q) },
        at,
      );
  }
  private finishFreshOperation(
    q: CheckoutQuote,
    mandate: Mandate,
    agentExpiry: string,
  ): void {
    const checkedAt = this.now();
    if (Date.parse(checkedAt) < Date.parse(q.quotedAt))
      return fail("COMMERCE_CLOCK_ROLLBACK");
    if (Date.parse(checkedAt) >= Date.parse(q.expiresAt))
      throw new QuoteBoundaryExpired(q, checkedAt);
    this.timeWithinAuthority(mandate, agentExpiry, checkedAt);
  }
  private manifestFromQuote(
    q: CheckoutQuote,
    owner: CheckoutOwner,
    b: MerchantBinding,
    id: string,
  ): CheckoutManifest {
    const { version, expiresAt, ...rest } = q;
    return freezeCheckout(
      CheckoutManifestSchema.parse({
        ...rest,
        version: "payflow.checkout-manifest.v1",
        manifestId: id,
        quoteVersion: version,
        quoteExpiresAt: expiresAt,
        owner,
        expectedPayPalMerchantId: b.expectedPayPalMerchantId,
        environment: b.environment,
      }),
    );
  }
  private async manifestRecord(id: string, tx: Sql): Promise<CheckoutManifest> {
    z.string().uuid().parse(id);
    const rows =
      await tx`select *,encode(sha256(convert_to(document::text,'UTF8')),'hex') actual_hash from checkout_manifests where id=${id}`;
    if (!rows[0]) return fail("CHECKOUT_MANIFEST_NOT_FOUND");
    const r = record(rows[0]),
      m = CheckoutManifestSchema.parse(r.document);
    const linked = await this.quoteRecord(m.quoteId, tx);
    const expected = this.manifestFromQuote(
      linked.quote,
      linked.owner,
      linked.binding,
      id,
    );
    if (
      m.manifestId !== r.id ||
      m.quoteId !== r.quote_id ||
      r.document_hash !== r.actual_hash ||
      checkoutManifestFingerprint(m) !== r.fingerprint ||
      checkoutManifestFingerprint(expected) !== r.fingerprint
    )
      return fail("CHECKOUT_MANIFEST_CORRUPT");
    return freezeCheckout(m);
  }
  async getManifest(id: string): Promise<CheckoutManifest> {
    return this.manifestRecord(id, this.repo.sql);
  }
  async sealManifest(quoteId: string): Promise<CheckoutManifest> {
    const result = await this.transaction(async (tx) => {
      const initial = await this.quoteRecord(quoteId, tx);
      const authority = await this.authority(
        tx,
        initial.owner.mandateId,
        initial.owner,
      );
      await this.currentBinding(
        tx,
        initial.binding,
        initial.quote.merchantBindingFingerprint,
      );
      const { quote, owner, binding } = await this.quoteRecord(
        quoteId,
        tx,
        true,
      );
      this.termsWithinMandate(authority.mandate, quote);
      if (!(await this.quoteLive(tx, quote))) return null;
      const existing =
        await tx`select id from checkout_manifests where quote_id=${quoteId}`;
      if (existing[0]) {
        const m = await this.manifestRecord(String(existing[0].id), tx);
        this.finishFreshOperation(
          quote,
          authority.mandate,
          authority.agent.expiresAt,
        );
        return m;
      }
      const m = this.manifestFromQuote(quote, owner, binding, randomUUID()),
        fp = checkoutManifestFingerprint(m);
      const now = this.now();
      this.timeWithinAuthority(
        authority.mandate,
        authority.agent.expiresAt,
        now,
      );
      if (Date.parse(now) >= Date.parse(quote.expiresAt)) {
        await this.quoteLive(tx, quote);
        return null;
      }
      await tx`insert into checkout_manifests(id,quote_id,fingerprint,document,document_hash,sealed_at) values(${m.manifestId},${m.quoteId},${fp},${tx.json(m)},encode(sha256(convert_to(${tx.json(m)}::jsonb::text,'UTF8')),'hex'),${now})`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        "CHECKOUT_MANIFEST_SEALED",
        {
          manifestId: m.manifestId,
          manifestFingerprint: fp,
          quoteId: m.quoteId,
          quoteFingerprint: checkoutQuoteFingerprint(quote),
          bindingFingerprint: m.merchantBindingFingerprint,
          offerFingerprint: m.controlledOfferFingerprint,
        },
        now,
      );
      this.finishFreshOperation(
        quote,
        authority.mandate,
        authority.agent.expiresAt,
      );
      return m;
    });
    if (!result) return fail("COMMERCE_QUOTE_EXPIRED");
    return result;
  }
  async compileManifestProposal(
    manifestId: string,
  ): Promise<TransactionProposal> {
    const result = await this.transaction(async (tx) => {
      const m = await this.manifestRecord(manifestId, tx);
      const authority = await this.authority(tx, m.owner.mandateId, m.owner);
      const linked = await this.quoteRecord(m.quoteId, tx);
      await this.currentBinding(
        tx,
        linked.binding,
        m.merchantBindingFingerprint,
      );
      const q = (await this.quoteRecord(m.quoteId, tx, true)).quote;
      this.termsWithinMandate(authority.mandate, m);
      if (!(await this.quoteLive(tx, q))) return null;
      const existing =
        await tx`select proposal_id from checkout_manifest_proposals where manifest_id=${manifestId}`;
      if (existing[0]) {
        const p = await this.repo.getProposal(
          String(existing[0].proposal_id),
          tx,
        );
        if (!p) return fail("COMMERCE_PROPOSAL_MISSING");
        this.finishFreshOperation(
          q,
          authority.mandate,
          authority.agent.expiresAt,
        );
        return p;
      }
      const now = this.now();
      const p = TransactionProposalSchema.parse({
        id: randomUUID(),
        agentId: m.owner.agentId,
        mandateId: m.owner.mandateId,
        mandateFingerprint: m.owner.mandateFingerprint,
        amount: { minor: m.totalMinor, currency: m.currency },
        quantity: m.quantity,
        merchant: { id: m.logicalMerchantId, displayName: DEMO_MERCHANT_NAME },
        category: "KEYBOARD",
        condition: m.condition,
        requestedCapability: "CAPTURE_PAYMENT",
        proposedAt: now,
        nonce: randomUUID(),
        metadata: {
          [COMMERCE_METADATA_KEYS.id]: m.manifestId,
          [COMMERCE_METADATA_KEYS.version]: m.version,
          [COMMERCE_METADATA_KEYS.fingerprint]: checkoutManifestFingerprint(m),
        },
      });
      this.timeWithinAuthority(
        authority.mandate,
        authority.agent.expiresAt,
        now,
      );
      await tx`insert into transaction_proposals(id,mandate_id,agent_id,nonce,amount_minor,currency,document,proposed_at) values(${p.id},${p.mandateId},${p.agentId},${p.nonce},${p.amount.minor},${p.amount.currency},${tx.json(p)},${p.proposedAt})`;
      await tx`insert into checkout_manifest_proposals(manifest_id,proposal_id,proposal_digest,linked_at) values(${m.manifestId},${p.id},${proposalDigest(p)},${now})`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        "CHECKOUT_MANIFEST_PROPOSAL_LINKED",
        {
          manifestId: m.manifestId,
          manifestFingerprint: checkoutManifestFingerprint(m),
          quoteId: m.quoteId,
          proposalId: p.id,
          proposalDigest: proposalDigest(p),
          principalId: m.owner.principalId,
          agentId: m.owner.agentId,
          mandateId: m.owner.mandateId,
        },
        now,
      );
      this.finishFreshOperation(
        q,
        authority.mandate,
        authority.agent.expiresAt,
      );
      return Object.freeze(p);
    });
    if (!result) return fail("COMMERCE_QUOTE_EXPIRED");
    return result;
  }
}
