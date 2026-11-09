import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { CheckoutQuote } from "../checkout-contracts.js";
import { checkoutQuoteFingerprint } from "../checkout-contracts.js";
import { digestOf, type PurchaseOrderDoc } from "./purchase.js";

/**
 * R0 — payment-time purchase-order binding.
 *
 * A mission-governed Authority can only pay against one approved purchase order. The order is loaded HERE from PayFlow's own tables
 * (the id an agent names is a lookup key and nothing else), compared with the trusted checkout quote before any manifest, reservation,
 * grant or provider call, re-checked immediately before dispatch, and recorded as a durable single-use execution intent.
 * Reconciliation (M40) stays a second line of defence; this is the first.
 */

type Money = { basis: string; minor?: number };
export interface OrderTerms {
  /** From the accepted mission quote. `null` = the quote did not state it (UNKNOWN), which is never accepted for a bound payment. */
  readonly shippingMinor: number | null;
  readonly discountMinor: number | null;
  /** tax + duties + fees as stated on the mission quote. */
  readonly otherChargesMinor: number | null;
}

/** Pure comparison of the trusted checkout quote with the approved order. Returns a refusal code, or null when every term matches. */
export function checkQuoteAgainstOrder(
  po: PurchaseOrderDoc,
  terms: OrderTerms,
  quote: CheckoutQuote,
): string | null {
  if (quote.currency !== po.currency) return "ORDER_CURRENCY_MISMATCH";
  if (quote.logicalMerchantId !== po.merchant) return "ORDER_MERCHANT_MISMATCH";
  if (po.lines.length !== 1) return "ORDER_MULTI_LINE_UNSUPPORTED";
  const line = po.lines[0]!;
  if (line.sku === null) return "ORDER_SKU_REQUIRED";
  if (quote.sku !== line.sku) return "ORDER_SKU_MISMATCH";
  if (quote.quantity !== line.quantity) return "ORDER_QUANTITY_MISMATCH";
  if (line.unitPriceMinor === null) return "ORDER_UNIT_PRICE_REQUIRED";
  if (quote.unitAmountMinor !== line.unitPriceMinor)
    return "ORDER_UNIT_PRICE_MISMATCH";
  if (terms.shippingMinor === null || terms.discountMinor === null)
    return "ORDER_TERMS_UNSTATED";
  if (terms.otherChargesMinor === null) return "ORDER_TERMS_UNSTATED";
  if (quote.shippingMinor !== terms.shippingMinor)
    return "ORDER_SHIPPING_MISMATCH";
  if (quote.customerDiscountMinor !== terms.discountMinor)
    return "ORDER_DISCOUNT_MISMATCH";
  if (quote.taxMinor + quote.customerFeeMinor !== terms.otherChargesMinor)
    return "ORDER_TAX_OR_FEES_MISMATCH";
  if (quote.totalMinor !== po.totalMinor) return "ORDER_TOTAL_MISMATCH";
  return null;
}

/**
 * A contractor milestone payment instruction is bound on what the instruction states: payee, currency and amount. PayFlow has no
 * payout rail, so the demo rail buys a catalog item for the payee; nothing here claims a transfer to a person. SKU, quantity and
 * price lines do not exist on an instruction and are not compared.
 */
export function checkQuoteAgainstPayment(
  doc: PurchaseOrderDoc,
  quote: CheckoutQuote,
): string | null {
  if (quote.currency !== doc.currency) return "ORDER_CURRENCY_MISMATCH";
  if (quote.logicalMerchantId !== doc.merchant)
    return "ORDER_MERCHANT_MISMATCH";
  if (quote.totalMinor !== doc.totalMinor) return "ORDER_TOTAL_MISMATCH";
  return null;
}

const stated = (m: Money | undefined): number | null =>
  m && m.basis !== "UNKNOWN" && typeof m.minor === "number" ? m.minor : null;
const sum = (xs: (number | null)[]): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + x!, 0);

export type BeginResult =
  | {
      ok: true;
      kind: "PURCHASE_ORDER" | "CONTRACTOR_PAYMENT";
      intentId: string;
      po: PurchaseOrderDoc;
      terms: OrderTerms;
      missionId: string;
    }
  | { ok: false; code: string };

const PENDING_TTL_MS = 5 * 60_000;

export class ExecutionBindingService {
  constructor(private readonly deps: { sql: Sql; now: () => string }) {}

  /** Is this Authority one that a mission compiled? Revoked ones count: revoking must not turn a mission Authority generic. */
  async governs(authorityId: string): Promise<boolean> {
    const r = await this.deps
      .sql`select 1 from mission_authorities where authority_id = ${authorityId} limit 1`;
    return r.length > 0;
  }

  /**
   * Loads the order and checks everything that does not need the checkout quote, then durably claims the order for this request.
   * Only one live intent per order can exist (partial unique index), so a competing request is refused here, before the provider.
   */
  async begin(input: {
    poId: unknown;
    authorityId: string;
    agentId: string;
    nonce: string;
    amountMinor: number;
    currency: string;
    merchantId: string;
  }): Promise<BeginResult> {
    const sql = this.deps.sql;
    const ref = typeof input.poId === "string" ? input.poId : "";
    const kind = /^po_[a-f0-9]{24}$/u.test(ref)
      ? ("PURCHASE_ORDER" as const)
      : /^cpy_[a-f0-9]{24}$/u.test(ref)
        ? ("CONTRACTOR_PAYMENT" as const)
        : null;
    if (!kind) return { ok: false, code: "ORDER_NOT_FOUND" };
    const row = await this.load(kind, ref);
    if (!row || row.authority_id !== input.authorityId)
      return { ok: false, code: "ORDER_NOT_FOUND" };
    if (row.agent_id !== input.agentId)
      return { ok: false, code: "ORDER_AGENT_MISMATCH" };
    const doc = row.document as PurchaseOrderDoc;
    // The stored document is the only source of truth, and it must still be what was issued.
    if (digestOf(doc) !== String(row.document_digest).trim())
      return { ok: false, code: "ORDER_INTEGRITY_FAILURE" };
    if (
      doc.authorityId !== input.authorityId ||
      doc.agentId !== input.agentId ||
      Number(row.total_minor) !== doc.totalMinor
    )
      return { ok: false, code: "ORDER_INTEGRITY_FAILURE" };
    if (
      input.amountMinor !== doc.totalMinor ||
      input.currency !== doc.currency ||
      input.merchantId !== doc.merchant
    )
      return { ok: false, code: "ORDER_CLAIMED_TERMS_MISMATCH" };
    const live = await this.liveChecks(kind, row);
    if (live) return { ok: false, code: live };
    const terms =
      kind === "PURCHASE_ORDER"
        ? await this.termsOf(String(row.quote_id))
        : { shippingMinor: 0, discountMinor: 0, otherChargesMinor: 0 };
    const now = this.deps.now();
    // A request that crashed before dispatch must not block the order forever; one that was dispatched never expires.
    await sql`update mission_execution_intents set status = 'ABANDONED', resolved_at = ${now}
      where order_ref = ${ref} and status = 'PENDING' and created_at < ${new Date(Date.parse(now) - PENDING_TTL_MS).toISOString()}`;
    const intentId = `xin_${randomBytes(12).toString("hex")}`;
    try {
      await sql`insert into mission_execution_intents
        (intent_id, order_kind, order_ref, mission_id, mission_version, authority_id, agent_id, po_digest, nonce_digest, status, created_at)
        values (${intentId}, ${kind}, ${ref}, ${String(row.mission_id)}, ${Number(row.auth_version)}, ${input.authorityId}, ${input.agentId},
          ${String(row.document_digest)}, ${createHash("sha256").update(input.nonce).digest("hex")}, 'PENDING', ${now})`;
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, code: "ORDER_ALREADY_IN_PROGRESS" };
      throw e;
    }
    return {
      ok: true,
      kind,
      intentId,
      po: doc,
      terms,
      missionId: String(row.mission_id),
    };
  }

  private async load(
    kind: "PURCHASE_ORDER" | "CONTRACTOR_PAYMENT",
    ref: string,
  ): Promise<Record<string, unknown> | null> {
    const sql = this.deps.sql;
    const [r] =
      kind === "PURCHASE_ORDER"
        ? await sql`select p.*, a.status as auth_status, a.mission_version as auth_version
            from mission_purchase_orders p
            left join mission_authorities a on a.authority_id = p.authority_id and a.mission_id = p.mission_id
            where p.po_id = ${ref}`
        : await sql`select p.*, p.amount_minor as total_minor, a.status as auth_status, a.mission_version as auth_version
            from mission_contractor_payments p
            left join mission_authorities a on a.authority_id = p.authority_id and a.mission_id = p.mission_id
            where p.payment_id = ${ref}`;
    return r ?? null;
  }

  /** State that can change between begin and dispatch: mission, version, Authority, order lifetime, acceptance, ledger, quote. */
  private async liveChecks(
    kind: "PURCHASE_ORDER" | "CONTRACTOR_PAYMENT",
    row: Record<string, unknown>,
  ): Promise<string | null> {
    const sql = this.deps.sql;
    const now = this.deps.now();
    if (new Date(String(row.expires_at)).getTime() <= Date.parse(now))
      return "ORDER_EXPIRED";
    const [m] =
      await sql`select status, active_version from missions where mission_id = ${String(row.mission_id)}`;
    if (!m) return "ORDER_NOT_FOUND";
    if (m.status !== "ACTIVE") return `MISSION_${String(m.status)}`;
    if (row.auth_status !== "ACTIVE") return "MISSION_AUTHORITY_REVOKED";
    if (Number(m.active_version) !== Number(row.auth_version))
      return "MISSION_VERSION_STALE";
    const [due] =
      await sql`select 1 from mission_versions where mission_id = ${String(row.mission_id)} and version = ${Number(m.active_version)}
        and (contract->>'expiresAt')::timestamptz <= ${now}::timestamptz`;
    if (due) return "MISSION_EXPIRED";
    const [g] =
      await sql`select capabilities from mission_agent_grants where mission_id = ${String(row.mission_id)}
        and version = ${Number(m.active_version)} and agent_id = ${String(row.agent_id)}`;
    if (!g || !(g.capabilities as string[]).includes("PURCHASE"))
      return "AGENT_NOT_ASSIGNED";
    if (kind === "CONTRACTOR_PAYMENT") return this.paymentChecks(row);
    const [acc] =
      await sql`select status, ledger_item_id from mission_acceptances where acceptance_id = ${String(row.acceptance_id)}`;
    if (!acc || acc.status !== "ACCEPTED") return "ACCEPTANCE_WITHDRAWN";
    const [item] =
      await sql`select stage from mission_ledger_items where item_id = ${String(acc.ledger_item_id)}`;
    if (!item || !["APPROVED", "COMMITTED"].includes(String(item.stage)))
      return "ORDER_BUDGET_NOT_AVAILABLE";
    const [q] =
      await sql`select valid_until from mission_quotes where quote_id = ${String(row.quote_id)}`;
    if (!q || new Date(q.valid_until as string).getTime() <= Date.parse(now))
      return "QUOTE_EXPIRED";
    const [sup] =
      await sql`select 1 from mission_quotes where supersedes_quote_id = ${String(row.quote_id)}`;
    if (sup) return "QUOTE_SUPERSEDED";
    return null;
  }

  /** A milestone payment is payable while its contract stands, its deliverable is accepted and the milestone's budget is still committed. */
  private async paymentChecks(
    row: Record<string, unknown>,
  ): Promise<string | null> {
    const sql = this.deps.sql;
    const [t] =
      await sql`select 1 from mission_contract_terminations where contract_id = ${String(row.contract_id)}`;
    if (t) return "CONTRACT_TERMINATED";
    const [c] =
      await sql`select milestones from mission_talent_contracts where contract_id = ${String(row.contract_id)}`;
    const ms = (
      (c?.milestones ?? []) as { index: number; ledgerItemId: string }[]
    ).find((m) => m.index === Number(row.milestone_index));
    if (!ms) return "ORDER_NOT_FOUND";
    const [item] =
      await sql`select stage from mission_ledger_items where item_id = ${ms.ledgerItemId}`;
    if (!item || item.stage !== "COMMITTED")
      return "ORDER_BUDGET_NOT_AVAILABLE";
    const [d] =
      await sql`select status from mission_deliverables where deliverable_id = ${String(row.deliverable_id)}`;
    if (!d || d.status !== "ACCEPTED") return "DELIVERABLE_NOT_ACCEPTED";
    return null;
  }

  private async termsOf(quoteId: string): Promise<OrderTerms> {
    const [q] = await this.deps
      .sql`select document from mission_quotes where quote_id = ${quoteId}`;
    const d = (q?.document ?? {}) as Record<string, Money>;
    return {
      shippingMinor: stated(d.shipping),
      discountMinor: stated(d.discount),
      otherChargesMinor: sum([stated(d.tax), stated(d.duties), stated(d.fees)]),
    };
  }

  /**
   * The last check before the provider may be called. Atomically moves PENDING -> DISPATCHING (single use) only if the live state
   * still allows the payment. Returns a refusal code, or null.
   */
  /** Pins the trusted checkout quote an intent was compared with. Set once; a different quote later is a refusal. */
  async recordQuote(
    intentId: string,
    quote: CheckoutQuote,
  ): Promise<string | null> {
    const fp = checkoutQuoteFingerprint(quote);
    const moved = await this.deps.sql`update mission_execution_intents
      set checkout_quote_id = ${quote.quoteId}, checkout_quote_fingerprint = ${fp}
      where intent_id = ${intentId} and status = 'PENDING' and checkout_quote_id is null returning intent_id`;
    return moved.length === 1 ? null : "ORDER_INTENT_NOT_PENDING";
  }

  async beforeDispatch(
    intentId: string,
    proposalId?: string,
  ): Promise<string | null> {
    const sql = this.deps.sql;
    const [i] =
      await sql`select order_kind, order_ref, po_digest, checkout_quote_id from mission_execution_intents where intent_id = ${intentId}`;
    if (!i) return "ORDER_INTENT_MISSING";
    const kind = i.order_kind as "PURCHASE_ORDER" | "CONTRACTOR_PAYMENT";
    const row = await this.load(kind, String(i.order_ref));
    if (!row) return "ORDER_NOT_FOUND";
    // The order document (cost center, invoice reference, lines) must still be exactly what this decision was made on.
    const doc = row.document as PurchaseOrderDoc;
    if (
      digestOf(doc) !== String(row.document_digest).trim() ||
      String(row.document_digest).trim() !== String(i.po_digest).trim()
    )
      return "ORDER_INTEGRITY_FAILURE";
    // The reservation must belong to the very quote that was compared with the order (no substitution in between).
    if (proposalId !== undefined) {
      if (!i.checkout_quote_id) return "ORDER_QUOTE_NOT_BOUND";
      const [pq] =
        await sql`select cm.quote_id from checkout_manifest_proposals l join checkout_manifests cm on cm.id = l.manifest_id
          where l.proposal_id = ${proposalId}`;
      if (!pq || String(pq.quote_id) !== String(i.checkout_quote_id))
        return "ORDER_QUOTE_SUBSTITUTED";
    }
    const live = await this.liveChecks(kind, row);
    if (live) return live;
    const moved =
      await sql`update mission_execution_intents set status = 'DISPATCHING', dispatched_at = ${this.deps.now()}
      where intent_id = ${intentId} and status = 'PENDING' returning intent_id`;
    return moved.length === 1 ? null : "ORDER_INTENT_NOT_PENDING";
  }

  /** Records how the attempt ended. A refusal before dispatch frees the order; an unknown outcome keeps it held. */
  async resolve(
    intentId: string,
    outcome: {
      effect: "CAPTURED" | "NONE" | "UNKNOWN";
      proposalId: string | null;
      refusal?: string | null;
    },
  ): Promise<void> {
    const status =
      outcome.effect === "CAPTURED"
        ? "COMPLETED"
        : outcome.effect === "UNKNOWN"
          ? "UNKNOWN"
          : "NO_EFFECT";
    await this.deps.sql`update mission_execution_intents
      set status = ${status}, proposal_id = ${outcome.proposalId}, refusal = ${outcome.refusal ?? null}, resolved_at = ${this.deps.now()}
      where intent_id = ${intentId} and status in ('PENDING','DISPATCHING')`;
  }
}
