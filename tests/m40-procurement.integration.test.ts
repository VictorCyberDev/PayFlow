/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
  classify,
  isForeignPayment,
  ledgerSteps,
  mismatches,
  type Classification,
  type PurchaseOrderDoc,
  type TraceFacts,
} from "../src/missions/purchase.js";
import { canMove, evidenceOk, type Stage } from "../src/missions/ledger.js";

/**
 * V3 M40 — procurement to payment. The purchase order is an instruction; the agent pays through the one decision path; PayFlow then
 * reconciles from its OWN operation trace. The pure tests pin the classification and the ledger moves (including a property test that
 * every move is legal and properly evidenced, and that nothing unexplained ever releases the budget). The integration tests run a real
 * payment through the real Gateway and prove the budget item follows the trace, not anyone's word.
 */
const url = process.env.TEST_DATABASE_URL;
const po = (over: Partial<PurchaseOrderDoc> = {}): PurchaseOrderDoc => ({
  merchant: DEMO_MERCHANT,
  currency: "USD",
  totalMinor: 8_400,
  lines: [
    { sku: null, description: "Keyboard", quantity: 1, unitPriceMinor: 8_400 },
  ],
  category: "KEYBOARD",
  purpose: "Studio",
  costCenter: null,
  invoiceRef: null,
  quoteId: "qte_0",
  acceptanceId: "acc_0",
  authorityId: "auth-1",
  agentId: "c",
  requestId: "po_0",
  expiresAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const trace = (over: Partial<TraceFacts> = {}): TraceFacts => ({
  status: "VERIFIED",
  financialOutcome: "CAPTURED",
  references: {
    mandateId: "auth-1",
    agentId: "c",
    proposalId: "prop-1",
    receiptId: "rcpt-1",
    providerCaptureId: "cap-1",
    providerOrderId: "ord-1",
  },
  financial: { currency: "USD", requestedMinor: 8_400, committedMinor: 8_400 },
  commerce: {
    logicalMerchant: DEMO_MERCHANT,
    sku: null,
    trustedTotalMinor: 8_400,
    quantity: 1,
  },
  ...over,
});

describe("M40 reconciliation classification (pure)", () => {
  it("a verified capture that matches the order exactly is SETTLED; nothing else is", () => {
    expect(classify(po(), trace())).toEqual({
      classification: "SETTLED",
      problems: [],
    });
    const c = (t: Partial<TraceFacts>) => classify(po(), trace(t));
    expect(c({ status: "INCOMPLETE" }).classification).toBe("INCOMPLETE");
    expect(c({ status: "LEGACY" }).classification).toBe("INCOMPLETE");
    expect(c({ status: "INVALID" })).toEqual({
      classification: "UNKNOWN",
      problems: ["TRACE_INVALID"],
    });
    expect(c({ status: "UNKNOWN_FINANCIAL_OUTCOME" }).classification).toBe(
      "UNKNOWN",
    );
    expect(c({ financialOutcome: "FAILED" }).classification).toBe(
      "FAILED_NO_EFFECT",
    );
    expect(c({ financialOutcome: "NOT_STARTED" }).classification).toBe(
      "INCOMPLETE",
    );
    // "captured" without a provider capture on record is not settled
    expect(
      c({ references: { ...trace().references, providerCaptureId: null } }),
    ).toEqual({
      classification: "UNKNOWN",
      problems: ["NO_PROVIDER_CAPTURE_ON_RECORD"],
    });
    expect(
      c({
        financial: {
          currency: "USD",
          requestedMinor: 8_400,
          committedMinor: 8_399,
        },
      }),
    ).toEqual({
      classification: "MISMATCH",
      problems: ["COMMITTED_AMOUNT_DIFFERS"],
    });
  });

  it("each field that differs is named, and a field the trace does not carry is not a mismatch", () => {
    const p = (t: Partial<TraceFacts>, o: Partial<PurchaseOrderDoc> = {}) =>
      mismatches(po(o), trace(t));
    expect(
      p({ references: { ...trace().references, mandateId: "x" } }),
    ).toEqual(["AUTHORITY_DIFFERS"]);
    expect(p({ references: { ...trace().references, agentId: "x" } })).toEqual([
      "AGENT_DIFFERS",
    ]);
    expect(
      p({
        financial: {
          currency: "EUR",
          requestedMinor: 8_400,
          committedMinor: 8_400,
        },
      }),
    ).toEqual(["CURRENCY_DIFFERS"]);
    expect(
      p({
        financial: {
          currency: "USD",
          requestedMinor: 8_399,
          committedMinor: 8_400,
        },
      }),
    ).toEqual(["AMOUNT_DIFFERS"]);
    expect(
      p({ commerce: { ...trace().commerce, trustedTotalMinor: 8_401 } }),
    ).toEqual(["TRUSTED_TOTAL_DIFFERS"]);
    expect(
      p({ commerce: { ...trace().commerce, logicalMerchant: "other" } }),
    ).toEqual(["MERCHANT_DIFFERS"]);
    expect(p({ commerce: { ...trace().commerce, quantity: 2 } })).toEqual([
      "QUANTITY_DIFFERS",
    ]);
    const lines = [
      { sku: "KB", description: "k", quantity: 1, unitPriceMinor: 8_400 },
    ];
    expect(
      p({ commerce: { ...trace().commerce, sku: "MOUSE" } }, { lines }),
    ).toEqual(["SKU_DIFFERS"]);
    expect(
      p({ commerce: { ...trace().commerce, sku: "KB" } }, { lines }),
    ).toEqual([]);
    // nothing carried → nothing to contradict
    expect(
      p({
        financial: {
          currency: null,
          requestedMinor: null,
          committedMinor: null,
        },
        commerce: {
          logicalMerchant: null,
          sku: null,
          trustedTotalMinor: null,
          quantity: null,
        },
      }),
    ).toEqual([]);
    expect(isForeignPayment(["AMOUNT_DIFFERS"])).toBe(false);
    expect(isForeignPayment(["AMOUNT_DIFFERS", "AGENT_DIFFERS"])).toBe(true);
    expect(isForeignPayment(["AUTHORITY_DIFFERS"])).toBe(true);
  });

  it("the ledger moves are exact for each case", () => {
    const to = (from: Stage, c: Classification, t = trace()) =>
      ledgerSteps(from, c, t, "prop-1").map((s) => s.to);
    expect(to("APPROVED", "SETTLED")).toEqual([
      "RESERVED",
      "IN_FLIGHT",
      "SETTLED",
    ]);
    expect(to("COMMITTED", "SETTLED")).toEqual([
      "RESERVED",
      "IN_FLIGHT",
      "SETTLED",
    ]);
    expect(to("RESERVED", "SETTLED")).toEqual(["IN_FLIGHT", "SETTLED"]);
    expect(to("IN_FLIGHT", "SETTLED")).toEqual(["SETTLED"]);
    expect(to("UNKNOWN", "SETTLED")).toEqual(["SETTLED"]);
    expect(to("SETTLED", "SETTLED")).toEqual([]);
    expect(to("APPROVED", "UNKNOWN")).toEqual([
      "RESERVED",
      "IN_FLIGHT",
      "UNKNOWN",
    ]);
    expect(to("IN_FLIGHT", "MISMATCH")).toEqual(["UNKNOWN"]);
    expect(to("UNKNOWN", "UNKNOWN")).toEqual([]);
    expect(to("SETTLED", "MISMATCH")).toEqual([]);
    // no receipt on record and nothing started: nothing to hold
    expect(
      to(
        "APPROVED",
        "UNKNOWN",
        trace({ references: { ...trace().references, receiptId: null } }),
      ),
    ).toEqual([]);
    expect(to("APPROVED", "FAILED_NO_EFFECT")).toEqual(["CANCELLED"]);
    expect(to("RESERVED", "FAILED_NO_EFFECT")).toEqual(["CANCELLED"]);
    expect(to("IN_FLIGHT", "FAILED_NO_EFFECT")).toEqual(["FAILED"]);
    expect(to("UNKNOWN", "FAILED_NO_EFFECT")).toEqual(["RELEASED"]);
    expect(to("APPROVED", "INCOMPLETE")).toEqual([]);
  });

  it("property: every step is a legal, properly evidenced move, and a payment that is not clean never settles or releases the budget", () => {
    let seed = 40_017;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const pick = <T>(xs: readonly T[]) => xs[rnd(xs.length)]!;
    const stages: Stage[] = [
      "APPROVED",
      "COMMITTED",
      "RESERVED",
      "IN_FLIGHT",
      "UNKNOWN",
      "SETTLED",
    ];
    let settled = 0;
    let held = 0;
    for (let i = 0; i < 4000; i++) {
      const base = trace();
      // a third of the samples start clean and get at most one flaw, so the settling path is exercised
      const clean = rnd(3) === 0;
      const t: TraceFacts = clean
        ? {
            ...base,
            ...(rnd(2) === 0
              ? {}
              : { status: pick(["INCOMPLETE", "INVALID"] as const) }),
          }
        : {
            status: pick([
              "VERIFIED",
              "INCOMPLETE",
              "INVALID",
              "UNKNOWN_FINANCIAL_OUTCOME",
              "LEGACY",
            ] as const),
            financialOutcome: pick([
              "CAPTURED",
              "FAILED",
              "NOT_STARTED",
              "PENDING",
            ]),
            references: {
              ...base.references,
              mandateId: pick(["auth-1", "auth-1", "auth-1", "zzz"]),
              agentId: pick(["c", "c", "c", "q"]),
              receiptId: pick(["rcpt-1", null]),
              providerCaptureId: pick(["cap-1", null]),
            },
            financial: {
              currency: pick(["USD", "USD", "EUR", null]),
              requestedMinor: pick([8_400, 8_400, 8_300, null]),
              committedMinor: pick([8_400, 8_400, 8_300, null]),
            },
            commerce: {
              logicalMerchant: pick([
                DEMO_MERCHANT,
                DEMO_MERCHANT,
                "other",
                null,
              ]),
              sku: null,
              trustedTotalMinor: pick([8_400, 8_400, 8_000, null]),
              quantity: pick([1, 1, 2, null]),
            },
          };
      const from = pick(stages);
      const { classification, problems } = classify(po(), t);
      const steps = ledgerSteps(
        from,
        classification,
        t,
        "prop-1",
      );
      let at = from;
      for (const s of steps) {
        expect(canMove(at, s.to), `${at}->${s.to}`).toBe(true);
        expect(evidenceOk(s.to, s.evidenceKind, "PAYFLOW_ENFORCED")).toBe(true);
        at = s.to;
      }
      if (steps.some((s) => s.to === "SETTLED")) {
        settled++;
        expect(classification).toBe("SETTLED");
        expect(problems).toEqual([]);
        expect(t.status).toBe("VERIFIED");
        expect(t.financialOutcome).toBe("CAPTURED");
        expect(t.references.providerCaptureId).not.toBeNull();
        expect(mismatches(po(), t)).toEqual([]);
      }
      if (["CANCELLED", "RELEASED", "FAILED"].includes(at) && at !== from) {
        // budget only goes back when PayFlow's own trace says the payment verifiably failed
        expect(classification).toBe("FAILED_NO_EFFECT");
        expect(t.status).toBe("VERIFIED");
        expect(t.financialOutcome).toBe("FAILED");
        expect(mismatches(po(), t)).toEqual([]);
      }
      if (classification === "MISMATCH") {
        expect(at === "SETTLED" || at === "UNKNOWN" || at === from).toBe(true);
        held++;
      }
    }
    expect(settled).toBeGreaterThan(20);
    expect(held).toBeGreaterThan(200);
  });
});

(url ? describe : describe.skip)(
  "M40 procurement (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events,mission_acceptances,mission_escalations,mission_purchase_orders,mission_purchase_reconciliations",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const st = (minor: number) => ({ basis: "STATED", minor });
    type Scene = Awaited<ReturnType<typeof scene>>;
    const scene = async (categories = ["KEYBOARD"]) => {
      const m = await activeMission(
        h,
        contract({
          spendingCategories: categories,
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
          await post(m.owner, `/v1/admin/org/missions/${m.id}/suppliers`, {
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
    /** A quote for `total`, accepted by the owner. Returns the acceptance and its ledger item. */
    const accepted = async (s: Scene, total: number) => {
      const q = await post(s.owner, `/v1/admin/org/missions/${s.id}/quotes`, {
        supplierId: s.sid,
        currency: "USD",
        validUntil: "2026-11-10T10:00:00.000Z",
        document: {
          lines: [
            { description: "Keyboard", quantity: 1, unitPrice: st(total) },
          ],
          shipping: st(0),
          tax: st(0),
          duties: st(0),
          fees: st(0),
          discount: st(0),
          terms: {},
        },
        source: { kind: "SUPPLIER_STATED", ref: "email" },
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
          acceptance: { acceptanceId: string; ledgerItemId: string };
        }
      ).acceptance;
      return acc;
    };
    type Po = {
      order: {
        poId: string;
        agentId: string;
        authorityId: string;
        merchant: string;
        totalMinor: number;
        digest: string;
        notice: string;
        document: { requestId: string };
      };
      replayed: boolean;
    };
    const issue = (
      t: string,
      accId: string,
      b: Record<string, unknown> = {},
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/acceptances/${accId}/purchase-order`, {
        agentId: "c",
        category: "KEYBOARD",
        purpose: "Studio keyboard",
        idempotencyKey: idemKey("po"),
        ...b,
      });
    const stage = async (itemId: string) =>
      (
        await h.repo.sql<
          { stage: string }[]
        >`select stage from mission_ledger_items where item_id = ${itemId}`
      )[0]!.stage;
    const pay = async (token: string, authority: string, amount: number) => {
      const r = await new PayFlowClient({
        baseUrl: h.origin,
        accessToken: token,
      }).actions.execute({
        item: "Quiet keyboard",
        amount,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `m40-${Math.random().toString(36).slice(2)}-0123456789`,
        authority,
        agent: "c",
      });
      return r;
    };
    const reconcile = (
      t: string,
      poId: string,
      proposalId: string,
      base = "/v1/admin/org",
    ) => post(t, `${base}/purchase-orders/${poId}/reconcile`, { proposalId });
    const body = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    it("issues an order from an acceptance: bound to the agent, the Authority, the merchant and the total; once; never by the wrong party", async () => {
      const s = await scene();
      const acc = await accepted(s, 8_400);
      // no order from nothing; a research agent cannot buy; the owner only may issue as a person
      expect((await issue(s.owner, "acc_" + "0".repeat(24))).status).toBe(404);
      expect(
        (
          await issue(
            s.a,
            acc.acceptanceId,
            { agentId: undefined },
            "/v1/agent",
          )
        ).status,
      ).toBe(403);
      expect(
        (await issue(s.owner, acc.acceptanceId, { agentId: "b" })).status,
      ).toBe(403);
      expect(
        (await issue(s.owner, acc.acceptanceId, { category: "MOUSE" })).status,
      ).toBe(422);
      expect(
        (await issue(s.owner, acc.acceptanceId, { extra: 1 })).status,
      ).toBe(400);
      const r = await issue(s.owner, acc.acceptanceId);
      expect(r.status).toBe(201);
      const o = (await r.json()) as Po;
      expect(o.order).toMatchObject({
        agentId: "c",
        merchant: DEMO_MERCHANT,
        totalMinor: 8_400,
        notice: expect.stringContaining("not a payment") as string,
      });
      expect(o.order.document.requestId).toBe(o.order.poId);
      const auth = (
        (await (
          await get(s.owner, `${MISSIONS}/${s.id}/authorities`)
        ).json()) as {
          authorities: { authorityId: string }[];
        }
      ).authorities[0]!.authorityId;
      expect(o.order.authorityId).toBe(auth);
      // the same key replays; a second order for the same acceptance does not exist
      const again = await issue(s.owner, acc.acceptanceId, {
        idempotencyKey: "x".repeat(16),
      });
      expect(again.status).toBe(409);
      expect((await body(again)).reason).toBe("ALREADY_ISSUED");
      // an acceptance with an order can no longer be withdrawn
      const w = await post(
        s.owner,
        `/v1/admin/org/acceptances/${acc.acceptanceId}/withdraw`,
        { reason: "changed my mind" },
      );
      expect(w.status).toBe(409);
      expect(await stage(acc.ledgerItemId)).toBe("APPROVED");
      // nothing was paid by issuing
      expect(h.provider.captureCalls).toBe(0);
      const l = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/purchase-orders`),
      );
      expect(l.orders).toHaveLength(1);
      expect(l.reconciliations).toEqual([]);
    });

    it("a payment that matches is reconciled from PayFlow's own trace: the budget item settles, once", async () => {
      const s = await scene();
      const acc = await accepted(s, 8_400);
      const o = (await (await issue(s.owner, acc.acceptanceId)).json()) as Po;
      const paid = await pay(s.c, o.order.authorityId, 8_400);
      expect(paid).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      const proposalId = paid.proof!.proposalId!;
      // someone who cannot see the ledger cannot reconcile; the wrong agent cannot either
      expect(
        (await reconcile(s.b, o.order.poId, proposalId, "/v1/agent")).status,
      ).toBe(403);
      const r = await reconcile(s.owner, o.order.poId, proposalId);
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      const v = (await r.json()) as {
        reconciliation: {
          classification: string;
          ledgerSteps: string[];
          problems: string[];
        };
        itemStage: string;
        replayed: boolean;
      };
      expect(v.reconciliation).toMatchObject({
        classification: "SETTLED",
        ledgerSteps: ["RESERVED", "IN_FLIGHT", "SETTLED"],
        problems: [],
      });
      expect(v.itemStage).toBe("SETTLED");
      expect(await stage(acc.ledgerItemId)).toBe("SETTLED");
      // reconciling again changes nothing and says so; the agent may ask too
      const again = await body(
        await reconcile(s.c, o.order.poId, proposalId, "/v1/agent"),
      );
      expect(again.replayed).toBe(true);
      expect(again.itemStage).toBe("SETTLED");
      expect(h.provider.captureCalls).toBe(1);
      // the budget moved exactly once
      const entries = await h.repo
        .sql`select count(*)::int n from mission_ledger_entries where item_id = ${acc.ledgerItemId} and to_stage = 'SETTLED'`;
      expect(entries[0]!.n).toBe(1);
    });

    it("a payment that does not match the order holds the budget as UNKNOWN; it is never believed settled", async () => {
      const s = await scene();
      const acc = await accepted(s, 9_000);
      const o = (await (await issue(s.owner, acc.acceptanceId)).json()) as Po;
      // the agent pays something else inside its Authority
      const paid = await pay(s.c, o.order.authorityId, 8_400);
      expect(paid).toMatchObject({ status: "COMPLETED" });
      const r = await body(
        await reconcile(s.owner, o.order.poId, paid.proof!.proposalId!),
      );
      expect(r.reconciliation.classification).toBe("MISMATCH");
      expect(r.reconciliation.problems).toContain("AMOUNT_DIFFERS");
      expect(r.itemStage).toBe("UNKNOWN");
      expect(await stage(acc.ledgerItemId)).toBe("UNKNOWN");
      // the held budget still counts as exposure
      const led = await body(await get(s.owner, `${MISSIONS}/${s.id}/ledger`));
      expect(led.summary.exposureMinor).toBeGreaterThanOrEqual(9_000);
    });

    it("no trace, no conclusion; a payment under another Authority cannot move this order's budget, and its references are withheld", async () => {
      const s = await scene(["KEYBOARD", "MOUSE"]);
      const acc1 = await accepted(s, 8_400);
      const acc2 = await accepted(s, 8_400);
      const o1 = (await (await issue(s.owner, acc1.acceptanceId)).json()) as Po;
      const o2 = (await (
        await issue(s.owner, acc2.acceptanceId, { category: "MOUSE" })
      ).json()) as Po;
      expect(o1.order.authorityId).not.toBe(o2.order.authorityId);
      const none = await reconcile(s.owner, o1.order.poId, "does-not-exist-1");
      expect(none.status).toBe(409);
      expect((await body(none)).reason).toBe("TRACE_UNAVAILABLE");
      const paid = await pay(s.c, o1.order.authorityId, 8_400);
      const foreign = await body(
        await reconcile(s.owner, o2.order.poId, paid.proof!.proposalId!),
      );
      expect(foreign.reconciliation).toMatchObject({
        classification: "MISMATCH",
        ledgerSteps: [],
        traceStatus: "WITHHELD",
      });
      expect(foreign.reconciliation.problems).toContain("AUTHORITY_DIFFERS");
      expect(await stage(acc2.ledgerItemId)).toBe("APPROVED");
      const refs = await h.repo
        .sql`select refs from mission_purchase_reconciliations where po_id = ${o2.order.poId}`;
      expect(refs[0]!.refs).toEqual({});
      // the right order still settles from the right payment
      expect(
        (
          await body(
            await reconcile(s.owner, o1.order.poId, paid.proof!.proposalId!),
          )
        ).itemStage,
      ).toBe("SETTLED");
    });

    it("a second capture for an already settled order is a DUPLICATE and moves nothing", async () => {
      const s = await scene();
      const acc = await accepted(s, 8_400);
      const o = (await (await issue(s.owner, acc.acceptanceId)).json()) as Po;
      const paid = await pay(s.c, o.order.authorityId, 8_400);
      // an earlier, different payment already settled this order
      await h.repo
        .sql`insert into mission_purchase_reconciliations (po_id, proposal_id, classification, trace_status, financial_outcome, refs, problems, ledger_steps, actor_kind, actor_id, occurred_at)
        values (${o.order.poId}, 'earlier-payment', 'SETTLED', 'VERIFIED', 'CAPTURED', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'MEMBER', 'x', now())`;
      const r = await body(
        await reconcile(s.owner, o.order.poId, paid.proof!.proposalId!),
      );
      expect(r.reconciliation).toMatchObject({
        classification: "DUPLICATE",
        ledgerSteps: [],
        problems: ["ORDER_ALREADY_SETTLED_BY_ANOTHER_PAYMENT"],
      });
      expect(await stage(acc.ledgerItemId)).toBe("APPROVED");
    });

    it("orders and reconciliations are append-only, and an order cannot exceed the Authority", async () => {
      const s = await scene();
      const acc = await accepted(s, 8_400);
      const o = (await (await issue(s.owner, acc.acceptanceId)).json()) as Po;
      await expect(
        h.repo
          .sql`update mission_purchase_orders set total_minor = 1 where po_id = ${o.order.poId}`,
      ).rejects.toThrow(/append-only/);
      await expect(
        h.repo
          .sql`delete from mission_purchase_orders where po_id = ${o.order.poId}`,
      ).rejects.toThrow(/append-only/);
      // a second mission-sized quote above the Authority's single maximum is refused at issue
      const big = await accepted(s, 59_000);
      await h.repo
        .sql`update mandates set document = jsonb_set(document, '{maxSingleTransactionMinor}', '30000') where id = ${o.order.authorityId}`;
      const r = await issue(s.owner, big.acceptanceId);
      expect(r.status).toBe(422);
      expect((await body(r)).reason).toBe("ABOVE_AUTHORITY");
      // an Authority that does not name the supplier's merchant cannot be ordered against
      await h.repo
        .sql`update mandates set document = jsonb_set(jsonb_set(document, '{maxSingleTransactionMinor}', '60000'), '{merchantScope,ids}', '["somewhere.else"]') where id = ${o.order.authorityId}`;
      const m = await issue(s.owner, big.acceptanceId);
      expect(m.status).toBe(422);
      expect((await body(m)).reason).toBe("MERCHANT_NOT_IN_AUTHORITY");
    });
  },
);
