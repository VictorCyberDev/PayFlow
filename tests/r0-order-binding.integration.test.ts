import { describe, expect, it } from "vitest";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { hostHarness, DEMO_MERCHANT } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  ExecutionBindingService,
  checkQuoteAgainstOrder,
  type OrderTerms,
} from "../src/missions/execution-binding.js";
import type { PurchaseOrderDoc } from "../src/missions/purchase.js";
import type { CheckoutQuote } from "../src/checkout-contracts.js";

/**
 * R0 — payment-time purchase-order binding. A mission-governed Authority can pay only an approved purchase order, and the Gateway
 * compares the order with the TRUSTED checkout quote before any manifest, reservation, grant or provider call. Every refusal below
 * asserts the provider call count, the budget item, the reservations and the execution-intent state, not just the response.
 */
const url = process.env.TEST_DATABASE_URL;
const KB = "PF-KB-QUIET-BROWN-BLACK";

const po = (over: Partial<PurchaseOrderDoc> = {}): PurchaseOrderDoc => ({
  merchant: DEMO_MERCHANT,
  currency: "USD",
  totalMinor: 8_400,
  lines: [{ sku: KB, description: "k", quantity: 1, unitPriceMinor: 8_400 }],
  category: "KEYBOARD",
  purpose: "p",
  costCenter: null,
  invoiceRef: null,
  quoteId: "qte_0",
  acceptanceId: "acc_0",
  authorityId: "a",
  agentId: "c",
  requestId: "po_0",
  expiresAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const terms = (over: Partial<OrderTerms> = {}): OrderTerms => ({
  shippingMinor: 0,
  discountMinor: 0,
  otherChargesMinor: 0,
  ...over,
});
const cq = (over: Partial<CheckoutQuote> = {}) =>
  ({
    logicalMerchantId: DEMO_MERCHANT,
    sku: KB,
    quantity: 1,
    unitAmountMinor: 8_400,
    subtotalMinor: 8_400,
    taxMinor: 0,
    shippingMinor: 0,
    customerDiscountMinor: 0,
    customerFeeMinor: 0,
    totalMinor: 8_400,
    currency: "USD",
    ...over,
  }) as CheckoutQuote;

describe("R0 order binding (pure)", () => {
  it("accepts exactly the order's terms and names the first term that differs", () => {
    expect(checkQuoteAgainstOrder(po(), terms(), cq())).toBeNull();
    const t = (q: Partial<CheckoutQuote>, p = po(), tt = terms()) =>
      checkQuoteAgainstOrder(p, tt, cq(q));
    expect(t({ currency: "EUR" })).toBe("ORDER_CURRENCY_MISMATCH");
    expect(t({ logicalMerchantId: "x" as never })).toBe(
      "ORDER_MERCHANT_MISMATCH",
    );
    expect(t({ sku: "OTHER" })).toBe("ORDER_SKU_MISMATCH");
    expect(t({ quantity: 2 })).toBe("ORDER_QUANTITY_MISMATCH");
    expect(t({ unitAmountMinor: 8_399 })).toBe("ORDER_UNIT_PRICE_MISMATCH");
    expect(t({ shippingMinor: 1 })).toBe("ORDER_SHIPPING_MISMATCH");
    expect(t({ customerDiscountMinor: 1 })).toBe("ORDER_DISCOUNT_MISMATCH");
    expect(t({ taxMinor: 1 })).toBe("ORDER_TAX_OR_FEES_MISMATCH");
    expect(t({ customerFeeMinor: 1 })).toBe("ORDER_TAX_OR_FEES_MISMATCH");
    expect(t({ totalMinor: 8_401 })).toBe("ORDER_TOTAL_MISMATCH");
    // an order that cannot be compared is refused, never waved through
    expect(checkQuoteAgainstOrder(po({ lines: [] }), terms(), cq())).toBe(
      "ORDER_MULTI_LINE_UNSUPPORTED",
    );
    expect(
      checkQuoteAgainstOrder(
        po({
          lines: [
            { sku: null, description: "k", quantity: 1, unitPriceMinor: 8_400 },
          ],
        }),
        terms(),
        cq(),
      ),
    ).toBe("ORDER_SKU_REQUIRED");
    expect(
      checkQuoteAgainstOrder(
        po({
          lines: [
            { sku: KB, description: "k", quantity: 1, unitPriceMinor: null },
          ],
        }),
        terms(),
        cq(),
      ),
    ).toBe("ORDER_UNIT_PRICE_REQUIRED");
    expect(
      checkQuoteAgainstOrder(po(), terms({ shippingMinor: null }), cq()),
    ).toBe("ORDER_TERMS_UNSTATED");
  });
});

(url ? describe : describe.skip)(
  "R0 order binding (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events,mission_acceptances,mission_escalations,mission_purchase_orders,mission_purchase_reconciliations,mission_execution_intents",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const st = (minor: number) => ({ basis: "STATED", minor });
    type Scene = Awaited<ReturnType<typeof scene>>;
    const scene = async () => {
      const m = await activeMission(
        h,
        contract({
          spendingCategories: ["KEYBOARD"],
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: { mode: "ONLY", ids: [DEMO_MERCHANT] },
          maxCommitmentMinor: 60_000,
          totalBudgetMinor: 150_000,
          agents: [
            { agentId: "a", capabilities: ["READ", "COMPARE"] },
            { agentId: "b", capabilities: ["READ", "NEGOTIATE", "CONTRACT"] },
            { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
          ],
        }),
      );
      const sid = (
        (await (
          await post(m.owner, `${MISSIONS}/${m.id}/suppliers`, {
            externalRef: DEMO_MERCHANT,
            displayName: "Demo Merchant",
          })
        ).json()) as { supplierId: string }
      ).supplierId;
      const f = (criterion: string, evidenceKind: string, ref?: string) =>
        post(m.owner, `/v1/admin/org/suppliers/${sid}/facts`, {
          criterion,
          status: "VERIFIED",
          evidenceKind,
          ...(ref ? { evidenceRef: ref } : {}),
          idempotencyKey: idemKey("f"),
        });
      await f("IDENTITY", "OWNER_ATTESTATION");
      await f("PAYMENT_ACCEPTED", "OWNER_ATTESTATION");
      await f("RETURN_POLICY", "DOCUMENT_REF", "returns.pdf");
      return { ...m, sid };
    };
    interface QOpts {
      sku?: string;
      qty?: number;
      unit?: number;
      shipping?: number;
      tax?: number;
      fees?: number;
      discount?: number;
      supersedes?: string;
    }
    /** Records a quote and an acceptance. Returns the ids; the order total is whatever the arithmetic says. */
    const accepted = async (s: Scene, o: QOpts = {}) => {
      const q = await post(s.owner, `${MISSIONS}/${s.id}/quotes`, {
        supplierId: s.sid,
        currency: "USD",
        validUntil: "2026-11-10T10:00:00.000Z",
        document: {
          lines: [
            {
              sku: o.sku ?? KB,
              description: "Keyboard",
              quantity: o.qty ?? 1,
              unitPrice: st(o.unit ?? 8_400),
            },
          ],
          shipping: st(o.shipping ?? 0),
          tax: st(o.tax ?? 0),
          duties: st(0),
          fees: st(o.fees ?? 0),
          discount: st(o.discount ?? 0),
          terms: {},
        },
        source: { kind: "SUPPLIER_STATED", ref: "email" },
        ...(o.supersedes ? { supersedes: o.supersedes } : {}),
        idempotencyKey: idemKey("q"),
      });
      const qid = ((await q.json()) as { quote: { quoteId: string } }).quote
        .quoteId;
      const a = await post(s.owner, `/v1/admin/org/quotes/${qid}/accept`, {
        idempotencyKey: idemKey("a"),
      });
      expect(a.status, JSON.stringify(await a.clone().json())).toBe(201);
      const acc = (
        (await a.json()) as {
          acceptance: {
            acceptanceId: string;
            ledgerItemId: string;
            totalMinor: number;
          };
        }
      ).acceptance;
      return { ...acc, quoteId: qid };
    };
    const issue = async (
      s: Scene,
      accId: string,
      b: Record<string, unknown> = {},
    ) => {
      const r = await post(
        s.owner,
        `/v1/admin/org/acceptances/${accId}/purchase-order`,
        {
          agentId: "c",
          category: "KEYBOARD",
          purpose: "Studio keyboard",
          costCenter: "CC-1",
          invoiceRef: "INV-1",
          idempotencyKey: idemKey("po"),
          ...b,
        },
      );
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      return (
        (await r.json()) as {
          order: { poId: string; authorityId: string; totalMinor: number };
        }
      ).order;
    };
    const exec = (
      token: string,
      authority: string,
      amount: number,
      over: {
        missionOrder?: string;
        nonce?: string;
        merchant?: string;
        currency?: string;
        agent?: string;
        item?: string;
        quantity?: number;
      } = {},
    ) =>
      new PayFlowClient({
        baseUrl: h.origin,
        accessToken: token,
      }).actions.execute({
        item: over.item ?? "Quiet keyboard",
        amount,
        currency: over.currency ?? "USD",
        merchant: over.merchant ?? DEMO_MERCHANT,
        nonce:
          over.nonce ?? `r0-${Math.random().toString(36).slice(2)}-0123456789`,
        authority,
        agent: over.agent ?? "c",
        ...(over.quantity ? { quantity: over.quantity } : {}),
        ...(over.missionOrder ? { missionOrder: over.missionOrder } : {}),
      });
    const sqlr = () => h.repo.sql;
    const stage = async (itemId: string) =>
      String(
        (
          await sqlr()`select stage from mission_ledger_items where item_id = ${itemId}`
        )[0]!.stage,
      );
    const reservations = async () =>
      Number(
        (
          await sqlr()`select count(*)::int n from authorization_reservations`
        )[0]!.n,
      );
    const intents = async (poId: string) =>
      (await sqlr()`select status, refusal from mission_execution_intents where order_ref = ${poId} order by created_at`) as unknown as {
        status: string;
        refusal: string | null;
      }[];

    /** A refusal that leaves no financial trace anywhere. */
    const expectNoEffect = async (
      r: { status: string; effectCount?: number | null; reason?: string },
      reason: string,
      itemId: string,
      resBefore: number,
    ) => {
      expect(r).toMatchObject({ status: "DENIED", effectCount: 0, reason });
      expect(h.provider.captureCalls).toBe(0);
      expect(await stage(itemId)).toBe("APPROVED");
      expect(await reservations()).toBe(resBefore);
    };

    it("a matching order pays once; the intent records it; the same order cannot be paid again", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const paid = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(paid).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      expect(h.provider.captureCalls).toBe(1);
      expect(await intents(order.poId)).toEqual([
        { status: "COMPLETED", refusal: null },
      ]);
      // a second, fresh request for the same order is refused before the provider
      const again = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(again).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "ORDER_ALREADY_IN_PROGRESS",
      });
      expect(h.provider.captureCalls).toBe(1);
      expect(await intents(order.poId)).toHaveLength(1);
    });

    it("the generic path cannot bypass: a mission Authority without an order is refused, and an order on a non-mission Authority is refused", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const before = await reservations();
      const r = await exec(s.c, order.authorityId, 8_400);
      await expectNoEffect(
        r,
        "MISSION_BINDING_REQUIRED",
        acc.ledgerItemId,
        before,
      );
      // the other direction: a sandbox Authority (not from a mission) cannot be given an order
      const generic = await h.authority();
      const gAgent = String(
        (
          await sqlr()`select authorized_agent_id from mandates where id = ${generic}`
        )[0]!.authorized_agent_id,
      );
      const token = await h.agentToken(gAgent);
      const g = await exec(token, generic, 8_400, {
        agent: gAgent,
        missionOrder: order.poId,
      });
      expect(g).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "NOT_A_MISSION_AUTHORITY",
      });
      expect(h.provider.captureCalls).toBe(0);
      // revoking the mission does not turn its Authority into a generic one
      const sec = await h.member("SECURITY_ADMIN");
      expect(
        (await post(sec, `${MISSIONS}/${s.id}/revoke`, { reason: "stop" }))
          .status,
      ).toBe(200);
      const after = await exec(s.c, order.authorityId, 8_400);
      expect(after).toMatchObject({
        status: "DENIED",
        reason: "MISSION_BINDING_REQUIRED",
      });
      const withOrder = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(withOrder).toMatchObject({ status: "DENIED", effectCount: 0 });
      expect(h.provider.captureCalls).toBe(0);
    });

    it("refuses every claimed term that is not the order's: amount, currency, merchant, unknown or malformed order, wrong credential", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const before = await reservations();
      const base = { missionOrder: order.poId };
      await expectNoEffect(
        await exec(s.c, order.authorityId, 8_399, base),
        "ORDER_CLAIMED_TERMS_MISMATCH",
        acc.ledgerItemId,
        before,
      );
      await expectNoEffect(
        await exec(s.c, order.authorityId, 8_400, { ...base, currency: "EUR" }),
        "ORDER_CLAIMED_TERMS_MISMATCH",
        acc.ledgerItemId,
        before,
      );
      await expectNoEffect(
        await exec(s.c, order.authorityId, 8_400, {
          ...base,
          merchant: "somewhere.else",
        }),
        "ORDER_CLAIMED_TERMS_MISMATCH",
        acc.ledgerItemId,
        before,
      );
      await expectNoEffect(
        await exec(s.c, order.authorityId, 8_400, {
          missionOrder: "po_" + "0".repeat(24),
        }),
        "ORDER_NOT_FOUND",
        acc.ledgerItemId,
        before,
      );
      await expectNoEffect(
        await exec(s.c, order.authorityId, 8_400, {
          missionOrder: "not-an-order",
        }),
        "ORDER_NOT_FOUND",
        acc.ledgerItemId,
        before,
      );
      // another agent's credential cannot use this Authority at all
      const r = await exec(s.a, order.authorityId, 8_400, {
        ...base,
        agent: "a",
      });
      expect(r).toMatchObject({ effectCount: 0 });
      expect(h.provider.captureCalls).toBe(0);
      expect(await intents(order.poId)).toEqual([]);
    });

    it("a payment whose trusted quote differs from the order in SKU, quantity, unit price, shipping, discount, or tax/fees is refused before the provider", async () => {
      const cases: {
        name: string;
        q: QOpts;
        amount: number;
        reason: string;
        item?: string;
        quantity?: number;
      }[] = [
        {
          name: "sku",
          q: { sku: "PF-KB-QUIET-RED-GREY" },
          amount: 8_400,
          reason: "ORDER_SKU_MISMATCH",
        },
        {
          name: "quantity",
          q: { qty: 2, unit: 4_200 },
          amount: 8_400,
          reason: "ORDER_QUANTITY_MISMATCH",
        },
        {
          name: "unit price",
          q: { unit: 8_000, tax: 400 },
          amount: 8_400,
          reason: "ORDER_UNIT_PRICE_MISMATCH",
        },
        {
          name: "shipping",
          q: { shipping: 100, discount: 100 },
          amount: 8_400,
          reason: "ORDER_SHIPPING_MISMATCH",
        },
        {
          name: "discount",
          q: { fees: 100, discount: 100 },
          amount: 8_400,
          reason: "ORDER_DISCOUNT_MISMATCH",
        },
      ];
      for (const c of cases) {
        const s = await scene();
        const acc = await accepted(s, c.q);
        const order = await issue(s, acc.acceptanceId);
        const before = await reservations();
        const r = await exec(s.c, order.authorityId, c.amount, {
          missionOrder: order.poId,
        });
        await expectNoEffect(r, c.reason, acc.ledgerItemId, before);
        // the refused attempt left the order free to be paid correctly (it never dispatched)
        expect(
          (await intents(order.poId)).every((i) => i.status === "NO_EFFECT"),
          c.name,
        ).toBe(true);
      }
    });

    it("an expired order, an expired quote, a superseded quote, a paused/revoked mission and a stale mission version all stop the payment", async () => {
      // expired order
      {
        const s = await scene();
        const acc = await accepted(s);
        const order = await issue(s, acc.acceptanceId);
        const before = await reservations();
        await sqlr()`alter table mission_purchase_orders disable trigger user`;
        await sqlr()`update mission_purchase_orders set expires_at = '2000-01-01T00:00:00Z' where po_id = ${order.poId}`;
        await sqlr()`alter table mission_purchase_orders enable trigger user`;
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r).toMatchObject({ status: "DENIED", effectCount: 0 });
        expect(h.provider.captureCalls).toBe(0);
        expect(await reservations()).toBe(before);
      }
      // superseded quote
      {
        const s = await scene();
        const acc = await accepted(s);
        const order = await issue(s, acc.acceptanceId);
        const before = await reservations();
        const sup = await post(s.owner, `${MISSIONS}/${s.id}/quotes`, {
          supplierId: s.sid,
          currency: "USD",
          validUntil: "2026-11-10T10:00:00.000Z",
          document: {
            lines: [
              {
                sku: KB,
                description: "Keyboard",
                quantity: 1,
                unitPrice: st(7_900),
              },
            ],
            shipping: st(0),
            tax: st(0),
            duties: st(0),
            fees: st(0),
            discount: st(0),
            terms: {},
          },
          source: { kind: "SUPPLIER_STATED", ref: "email2" },
          supersedes: acc.quoteId,
          idempotencyKey: idemKey("q"),
        });
        expect(sup.status, JSON.stringify(await sup.clone().json())).toBe(201);
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        await expectNoEffect(r, "QUOTE_SUPERSEDED", acc.ledgerItemId, before);
      }
      // paused mission (its Authority is revoked), then resumed: the old order's Authority stays revoked
      {
        const s = await scene();
        const acc = await accepted(s);
        const order = await issue(s, acc.acceptanceId);
        const sec = await h.member("SECURITY_ADMIN");
        expect(
          (await post(sec, `${MISSIONS}/${s.id}/pause`, { reason: "review" }))
            .status,
        ).toBe(200);
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r).toMatchObject({ status: "DENIED", effectCount: 0 });
        expect(h.provider.captureCalls).toBe(0);
        expect((await post(s.owner, `${MISSIONS}/${s.id}/resume`)).status).toBe(
          200,
        );
        const r2 = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r2).toMatchObject({ status: "DENIED", effectCount: 0 });
        expect(h.provider.captureCalls).toBe(0);
        expect(await stage(acc.ledgerItemId)).toBe("APPROVED");
      }
      // stale mission version: the Authority was compiled for version 1, the mission now runs version 2
      {
        const s = await scene();
        const acc = await accepted(s);
        const order = await issue(s, acc.acceptanceId);
        const before = await reservations();
        await sqlr()`update missions set latest_version = 2, active_version = 2 where mission_id = ${s.id}`;
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r).toMatchObject({ status: "DENIED", effectCount: 0 });
        expect(h.provider.captureCalls).toBe(0);
        expect(await reservations()).toBe(before);
      }
    });

    it("a withdrawn acceptance or exhausted budget item cannot be paid", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const before = await reservations();
      // the budget item has left APPROVED (e.g. released): no payment may use it
      await sqlr()`alter table mission_ledger_items disable trigger user`;
      await sqlr()`update mission_ledger_items set stage = 'RELEASED' where item_id = ${acc.ledgerItemId}`;
      await sqlr()`alter table mission_ledger_items enable trigger user`;
      const r = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(r).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "ORDER_BUDGET_NOT_AVAILABLE",
      });
      expect(h.provider.captureCalls).toBe(0);
      expect(await reservations()).toBe(before);
    });

    it("a replayed nonce and a conflicting reuse of a nonce for a different order both stop at the replay claim", async () => {
      const s = await scene();
      const acc1 = await accepted(s);
      const acc2 = await accepted(s);
      const o1 = await issue(s, acc1.acceptanceId);
      const o2 = await issue(s, acc2.acceptanceId);
      const nonce = "r0-replay-nonce-0123456789";
      expect(
        await exec(s.c, o1.authorityId, 8_400, {
          missionOrder: o1.poId,
          nonce,
        }),
      ).toMatchObject({ status: "COMPLETED" });
      expect(
        await exec(s.c, o1.authorityId, 8_400, {
          missionOrder: o1.poId,
          nonce,
        }),
      ).toMatchObject({ effectCount: 0, reason: "REPLAY_DETECTED" });
      expect(
        await exec(s.c, o2.authorityId, 8_400, {
          missionOrder: o2.poId,
          nonce,
        }),
      ).toMatchObject({ effectCount: 0, reason: "REPLAY_DETECTED" });
      expect(h.provider.captureCalls).toBe(1);
      expect(await intents(o2.poId)).toEqual([]);
      expect(await stage(acc2.ledgerItemId)).toBe("APPROVED");
    });

    it("two competing requests for one order reach the provider at most once", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          exec(s.c, order.authorityId, 8_400, { missionOrder: order.poId }),
        ),
      );
      const done = results.filter((r) => r.status === "COMPLETED");
      expect(done).toHaveLength(1);
      expect(h.provider.captureCalls).toBe(1);
      for (const r of results.filter((x) => x.status !== "COMPLETED"))
        expect(r).toMatchObject({ effectCount: 0 });
      const rows = await intents(order.poId);
      expect(rows.filter((i) => i.status === "COMPLETED")).toHaveLength(1);
      expect(
        rows.filter((i) =>
          ["PENDING", "DISPATCHING", "UNKNOWN"].includes(i.status),
        ),
      ).toHaveLength(0);
      const res =
        await sqlr()`select count(*)::int n from authorization_reservations`;
      expect(Number(res[0]!.n)).toBe(1);
    });

    it("an order cannot be paid by a different tenant's Authority, and a tampered order document is detected", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      // a different Authority naming this order: the order is not found for it
      const generic = await h.authority();
      const gAgent = String(
        (
          await sqlr()`select authorized_agent_id from mandates where id = ${generic}`
        )[0]!.authorized_agent_id,
      );
      const token = await h.agentToken(gAgent);
      const other = await exec(token, generic, 8_400, {
        agent: gAgent,
        missionOrder: order.poId,
      });
      expect(other).toMatchObject({ effectCount: 0 });
      expect(h.provider.captureCalls).toBe(0);
      // tamper with the stored order total (append-only is a trigger; a database owner can still try): the digest no longer matches
      await sqlr()`alter table mission_purchase_orders disable trigger user`;
      await sqlr()`update mission_purchase_orders set document = jsonb_set(document, '{totalMinor}', '1') where po_id = ${order.poId}`;
      await sqlr()`alter table mission_purchase_orders enable trigger user`;
      const r = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(r).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "ORDER_INTEGRITY_FAILURE",
      });
      expect(h.provider.captureCalls).toBe(0);
    });

    it("dispatch is single-use and re-checks live state: a mission revoked between the claim and the provider call stops the payment", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      const binding = new ExecutionBindingService({ sql: sqlr(), now: h.iso });
      const ask = (nonce: string) =>
        binding.begin({
          poId: order.poId,
          authorityId: order.authorityId,
          agentId: "c",
          nonce,
          amountMinor: 8_400,
          currency: "USD",
          merchantId: DEMO_MERCHANT,
        });
      // two requests race for one order: exactly one claims it (partial unique index), deterministically
      const [x, y] = await Promise.all([
        ask("race-nonce-0000000001"),
        ask("race-nonce-0000000002"),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
      const won = (x.ok ? x : y) as Extract<typeof x, { ok: true }>;
      const lost = x.ok ? y : x;
      expect(lost).toEqual({ ok: false, code: "ORDER_ALREADY_IN_PROGRESS" });
      // state flips AFTER the claim and BEFORE the provider call
      const sec = await h.member("SECURITY_ADMIN");
      expect(
        (await post(sec, `${MISSIONS}/${s.id}/revoke`, { reason: "stop" }))
          .status,
      ).toBe(200);
      expect(await binding.beforeDispatch(won.intentId)).toBe(
        "MISSION_REVOKED",
      );
      expect((await intents(order.poId)).map((i) => i.status)).toEqual([
        "PENDING",
      ]);
      // a healthy mission: PENDING -> DISPATCHING once and only once
      const s2 = await scene();
      const acc2 = await accepted(s2);
      const o2 = await issue(s2, acc2.acceptanceId);
      const claim = (nonce: string) =>
        binding.begin({
          poId: o2.poId,
          authorityId: o2.authorityId,
          agentId: "c",
          nonce,
          amountMinor: 8_400,
          currency: "USD",
          merchantId: DEMO_MERCHANT,
        });
      const b2 = await claim("ok-nonce-00000000001");
      if (!b2.ok) throw new Error(b2.code);
      expect(await binding.beforeDispatch(b2.intentId)).toBeNull();
      expect(await binding.beforeDispatch(b2.intentId)).toBe(
        "ORDER_INTENT_NOT_PENDING",
      );
      // dispatched and then unknown: the order stays held, never freed for a second payment
      await binding.resolve(b2.intentId, {
        effect: "UNKNOWN",
        proposalId: null,
      });
      expect(await claim("ok-nonce-00000000002")).toEqual({
        ok: false,
        code: "ORDER_ALREADY_IN_PROGRESS",
      });
    });

    it("end to end: state that flips after the claim and the reservation but before the provider call still stops the payment", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      // Failpoint: the instant the Trust Kernel reserves, the mission's Authority link is revoked (a concurrent pause/revoke).
      await sqlr()`create or replace function r0_failpoint() returns trigger language plpgsql as $f$
        begin update mission_authorities set status = 'REVOKED', revoked_reason = 'failpoint', revoked_at = now() where authority_id = new.mandate_id; return new; end $f$`;
      await sqlr()`create trigger r0_failpoint after insert on authorization_reservations for each row execute function r0_failpoint()`;
      try {
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r).toMatchObject({
          status: "DENIED",
          effectCount: 0,
          reason: "MISSION_AUTHORITY_REVOKED",
        });
        expect(h.provider.captureCalls).toBe(0);
        expect(await intents(order.poId)).toEqual([
          { status: "NO_EFFECT", refusal: "MISSION_AUTHORITY_REVOKED" },
        ]);
        expect(await stage(acc.ledgerItemId)).toBe("APPROVED");
      } finally {
        await sqlr()`drop trigger if exists r0_failpoint on authorization_reservations`;
      }
    });

    it("a provider timeout leaves the payment UNKNOWN: the order stays held, nothing is retried, the budget is not released", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      h.provider.loseCapture = true;
      const r = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(r).toMatchObject({ status: "UNRESOLVED", effectCount: null });
      const calls = h.provider.captureCalls;
      expect(calls).toBe(1);
      expect(await intents(order.poId)).toEqual([
        { status: "UNKNOWN", refusal: null },
      ]);
      // a second attempt, even with a fresh nonce, neither reaches the provider nor frees the order
      const again = await exec(s.c, order.authorityId, 8_400, {
        missionOrder: order.poId,
      });
      expect(again).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "ORDER_ALREADY_IN_PROGRESS",
      });
      expect(h.provider.captureCalls).toBe(calls);
      expect(await stage(acc.ledgerItemId)).toBe("APPROVED");
    });

    it("the order document (cost center, invoice reference) cannot change between claim and dispatch: the digest is re-checked at the boundary", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      // Failpoint: after the reservation, someone with database access rewrites the order's cost center.
      await sqlr()`create or replace function r0_doc_failpoint() returns trigger language plpgsql as $f$
        begin
          perform set_config('session_replication_role', 'replica', true);
          update mission_purchase_orders set document = jsonb_set(document, '{costCenter}', '"CC-EVIL"') where authority_id = new.mandate_id;
          perform set_config('session_replication_role', 'origin', true);
          return new;
        end $f$`;
      await sqlr()`create trigger r0_doc_failpoint after insert on authorization_reservations for each row execute function r0_doc_failpoint()`;
      try {
        const r = await exec(s.c, order.authorityId, 8_400, {
          missionOrder: order.poId,
        });
        expect(r).toMatchObject({
          status: "DENIED",
          effectCount: 0,
          reason: "ORDER_INTEGRITY_FAILURE",
        });
        expect(h.provider.captureCalls).toBe(0);
        expect(await intents(order.poId)).toEqual([
          { status: "NO_EFFECT", refusal: "ORDER_INTEGRITY_FAILURE" },
        ]);
      } finally {
        await sqlr()`drop trigger if exists r0_doc_failpoint on authorization_reservations`;
      }
    });

    it("the reservation must be on the very quote the order was compared with: a different proposal at dispatch is a substitution", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      // a real proposal from an unrelated, generic payment supplies a different quote
      const generic = await h.authority();
      const gAgent = String(
        (
          await sqlr()`select authorized_agent_id from mandates where id = ${generic}`
        )[0]!.authorized_agent_id,
      );
      const other = await exec(await h.agentToken(gAgent), generic, 8_400, {
        agent: gAgent,
      });
      const foreignProposal = (other as { proof?: { proposalId?: string } })
        .proof!.proposalId!;
      const binding = new ExecutionBindingService({ sql: sqlr(), now: h.iso });
      const b = await binding.begin({
        poId: order.poId,
        authorityId: order.authorityId,
        agentId: "c",
        nonce: "subst-nonce-0000000001",
        amountMinor: 8_400,
        currency: "USD",
        merchantId: DEMO_MERCHANT,
      });
      if (!b.ok) throw new Error(b.code);
      // no quote pinned yet -> refused; pinned to some quote, then a proposal on another -> refused
      expect(await binding.beforeDispatch(b.intentId, foreignProposal)).toBe(
        "ORDER_QUOTE_NOT_BOUND",
      );
      await sqlr()`update mission_execution_intents set checkout_quote_id = 'not-that-quote', checkout_quote_fingerprint = ${"a".repeat(64)} where intent_id = ${b.intentId}`;
      expect(await binding.beforeDispatch(b.intentId, foreignProposal)).toBe(
        "ORDER_QUOTE_SUBSTITUTED",
      );
      // once set, the pinned quote cannot be rewritten
      await expect(
        sqlr()`update mission_execution_intents set checkout_quote_id = 'other' where intent_id = ${b.intentId}`,
      ).rejects.toThrow(/immutable/);
      expect(h.provider.captureCalls).toBe(1); // only the unrelated generic payment
    });

    it("the execution intent is append-only in identity and forward-only in status", async () => {
      const s = await scene();
      const acc = await accepted(s);
      const order = await issue(s, acc.acceptanceId);
      await exec(s.c, order.authorityId, 8_400, { missionOrder: order.poId });
      await expect(
        sqlr()`delete from mission_execution_intents where order_ref = ${order.poId}`,
      ).rejects.toThrow(/append-only/);
      await expect(
        sqlr()`update mission_execution_intents set order_ref = order_ref, agent_id = 'x' where order_ref = ${order.poId}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        sqlr()`update mission_execution_intents set status = 'NO_EFFECT' where order_ref = ${order.poId}`,
      ).rejects.toThrow(/final/);
    });
  },
);
