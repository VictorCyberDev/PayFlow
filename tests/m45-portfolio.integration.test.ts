/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { idemKey } from "./helpers/mission-fixtures.js";
import { settledPurchase, TRUNCATE } from "./helpers/settled-order.js";
import {
  buildPortfolio,
  shareBps,
  type SupplierFacts,
} from "../src/missions/portfolio.js";

/**
 * V3 M45 — the multi-vendor view. Computed when asked from the ledger, orders, disputes and obligations: spend by supplier in integer
 * basis points, concentration (only meaningful with more than one supplier), trouble per supplier, and whether the mission can close.
 */
const url = process.env.TEST_DATABASE_URL;
const sup = (id: string, o: Partial<SupplierFacts> = {}): SupplierFacts => ({
  supplierId: id,
  name: id,
  spentMinor: 0,
  pendingMinor: 0,
  refundedMinor: 0,
  unknownOutcomes: 0,
  orders: { total: 0, delivered: 0, cancelled: 0, inDispute: 0 },
  openDisputes: 0,
  overdueObligations: 0,
  orderIssues: 0,
  ...o,
});

describe("M45 portfolio (pure)", () => {
  it("shares are exact integer basis points, rounded down, with no float loss on large amounts", () => {
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(2, 3)).toBe(6666);
    expect(shareBps(1, 1)).toBe(10000);
    expect(shareBps(0, 5)).toBe(0);
    expect(shareBps(5, 0)).toBe(0);
    expect(shareBps(999_999_999_999, 1_000_000_000_000)).toBe(9999);
    expect(shareBps(499_999_999_999_999, 1_000_000_000_000_001)).toBe(4999);
  });

  it("concentration needs more than one supplier and a share strictly above the limit; blockers are named per supplier", () => {
    const one = buildPortfolio([
      sup("a", {
        spentMinor: 100,
        orders: { total: 1, delivered: 1, cancelled: 0, inDispute: 0 },
      }),
    ]);
    expect(one.concentration).toEqual([]);
    expect(one.closeOut).toEqual({ ready: true, blockers: [] });
    const two = buildPortfolio([
      sup("a", { spentMinor: 50 }),
      sup("b", { spentMinor: 50 }),
    ]);
    expect(two.concentration).toEqual([]); // exactly 5000 is not above 5000
    const three = buildPortfolio([
      sup("a", { spentMinor: 51 }),
      sup("b", { spentMinor: 49 }),
    ]);
    expect(three.concentration).toEqual([{ supplierId: "a", shareBps: 5100 }]);
    expect(
      buildPortfolio(
        [sup("a", { spentMinor: 51 }), sup("b", { spentMinor: 49 })],
        5100,
      ).concentration,
    ).toEqual([]);
    expect(
      buildPortfolio(
        [sup("a", { spentMinor: 51 }), sup("b", { spentMinor: 49 })],
        5099,
      ).concentration,
    ).toHaveLength(1);
    const messy = buildPortfolio([
      sup("a", {
        pendingMinor: 10,
        openDisputes: 1,
        overdueObligations: 2,
        unknownOutcomes: 1,
        orderIssues: 1,
        orders: { total: 2, delivered: 1, cancelled: 0, inDispute: 1 },
      }),
    ]);
    expect(messy.suppliers[0]!.flags).toEqual([
      "OPEN_DISPUTES",
      "OVERDUE_OBLIGATIONS",
      "DELIVERY_ISSUES",
      "UNKNOWN_PAYMENT_OUTCOME",
    ]);
    expect(messy.closeOut.blockers).toEqual([
      "a:OPEN_DISPUTES",
      "a:OVERDUE_OBLIGATIONS",
      "a:UNKNOWN_PAYMENT_OUTCOME",
      "a:PAYMENT_PENDING",
      "a:ORDERS_NOT_FINISHED",
    ]);
  });

  it("property: totals add up, shares never exceed 100% and lose less than one basis point each, order is by spend, and close-out is ready exactly when nothing blocks", () => {
    let seed = 45_045;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    let ready = 0;
    for (let i = 0; i < 3000; i++) {
      const n = 1 + rnd(5);
      const facts = Array.from({ length: n }, (_, k) => {
        const total = rnd(4);
        const delivered = rnd(total + 1);
        return sup(`s${k}`, {
          spentMinor: rnd(3) === 0 ? 0 : rnd(1000),
          pendingMinor: rnd(6) === 0 ? rnd(100) : 0,
          openDisputes: rnd(8) === 0 ? 1 : 0,
          overdueObligations: rnd(8) === 0 ? 1 : 0,
          unknownOutcomes: rnd(10) === 0 ? 1 : 0,
          orders: {
            total,
            delivered,
            cancelled: rnd(total - delivered + 1),
            inDispute: 0,
          },
        });
      });
      const p = buildPortfolio(facts);
      expect(p.totalMinor).toBe(
        facts.reduce((a, f) => a + f.spentMinor + f.pendingMinor, 0),
      );
      const sum = p.suppliers.reduce((a, s) => a + s.shareBps, 0);
      expect(sum).toBeLessThanOrEqual(10000);
      if (p.totalMinor > 0) expect(sum).toBeGreaterThan(10000 - n);
      for (let k = 1; k < p.suppliers.length; k++)
        expect(p.suppliers[k - 1]!.totalMinor).toBeGreaterThanOrEqual(
          p.suppliers[k]!.totalMinor,
        );
      const clean = facts.every(
        (f) =>
          f.openDisputes === 0 &&
          f.overdueObligations === 0 &&
          f.unknownOutcomes === 0 &&
          f.pendingMinor === 0 &&
          f.orders.total - f.orders.delivered - f.orders.cancelled <= 0,
      );
      expect(p.closeOut.ready).toBe(clean);
      expect(p.closeOut.ready).toBe(p.closeOut.blockers.length === 0);
      if (clean) ready++;
    }
    expect(ready).toBeGreaterThan(10);
  });
});

(url ? describe : describe.skip)(
  "M45 portfolio (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const second = async (s: Awaited<ReturnType<typeof settledPurchase>>) => {
      const sid = (
        await body(
          await post(s.owner, `/v1/admin/org/missions/${s.id}/suppliers`, {
            externalRef: "second.merchant",
            displayName: "Second Co",
          }),
        )
      ).supplierId as string;
      for (const [criterion, evidenceKind, ref] of [
        ["IDENTITY", "OWNER_ATTESTATION", undefined],
        ["PAYMENT_ACCEPTED", "OWNER_ATTESTATION", undefined],
        ["RETURN_POLICY", "DOCUMENT_REF", "r.pdf"],
      ] as const)
        await post(s.owner, `/v1/admin/org/suppliers/${sid}/facts`, {
          criterion,
          status: "VERIFIED",
          evidenceKind,
          ...(ref ? { evidenceRef: ref } : {}),
          idempotencyKey: idemKey("f"),
        });
      const st = (minor: number) => ({ basis: "STATED", minor });
      const q = await post(s.owner, `/v1/admin/org/missions/${s.id}/quotes`, {
        supplierId: sid,
        currency: "USD",
        validUntil: "2026-11-10T10:00:00.000Z",
        document: {
          lines: [{ description: "Mouse", quantity: 1, unitPrice: st(20_000) }],
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
      const qid = (await body(q)).quote.quoteId as string;
      const a = await post(s.owner, `/v1/admin/org/quotes/${qid}/accept`, {
        idempotencyKey: idemKey("a"),
      });
      expect(a.status).toBe(201);
      return sid;
    };

    it("spreads spend across suppliers, flags concentration above the limit, names what blocks close-out, and clears as work finishes", async () => {
      const s = await settledPurchase(h, {
        extraMerchants: ["second.merchant"],
      });
      const oid = (
        await body(
          await post(s.owner, `/v1/admin/org/purchase-orders/${s.poId}/order`, {
            idempotencyKey: idemKey("o"),
          }),
        )
      ).order.orderId as string;
      const sid2 = await second(s);
      const p = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/portfolio`),
      );
      expect(p.totalMinor).toBe(28_400);
      expect(
        p.suppliers.map(
          (x: { name: string; totalMinor: number; shareBps: number }) => [
            x.name,
            x.totalMinor,
            x.shareBps,
          ],
        ),
      ).toEqual([
        ["Second Co", 20_000, 7042],
        ["Demo Merchant", 8_400, 2957],
      ]);
      expect(p.concentration).toEqual([{ supplierId: sid2, shareBps: 7042 }]);
      expect(p.closeOut.ready).toBe(false);
      expect(p.closeOut.blockers).toEqual(
        expect.arrayContaining([
          `${sid2}:PAYMENT_PENDING`,
          expect.stringMatching(/:ORDERS_NOT_FINISHED$/u),
        ]),
      );
      // the limit is the reader's to choose, and bad values are refused rather than guessed
      expect(
        (
          await body(
            await get(
              s.owner,
              `/v1/admin/org/missions/${s.id}/portfolio?maxShareBps=8000`,
            ),
          )
        ).concentration,
      ).toEqual([]);
      for (const bad of ["0", "10001", "abc", "5.5"])
        expect(
          (
            await get(
              s.owner,
              `/v1/admin/org/missions/${s.id}/portfolio?maxShareBps=${bad}`,
            )
          ).status,
        ).toBe(400);
      // an agent that can read sees the same; one that cannot is refused
      expect(
        (await get(s.a, `/v1/agent/missions/${s.id}/portfolio`)).status,
      ).toBe(200);
      expect(
        (await get(s.c, `/v1/agent/missions/${s.id}/portfolio`)).status,
      ).toBe(403);
      // trouble open against a supplier shows as a flag
      await post(s.owner, `/v1/admin/org/orders/${oid}/events`, {
        kind: "STATUS",
        status: "SHIPPED",
        verify: true,
        evidenceKind: "OWNER_ATTESTATION",
        idempotencyKey: idemKey("e"),
      });
      await post(s.owner, `/v1/admin/org/orders/${oid}/receipts`, {
        lineIndex: 0,
        quantity: 1,
        condition: "DAMAGED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "p.jpg",
        idempotencyKey: idemKey("r"),
      });
      const d = await post(s.owner, `/v1/admin/org/orders/${oid}/disputes`, {
        ground: "DAMAGED",
        claimedMinor: 1_000,
        reason: "crushed",
        idempotencyKey: idemKey("d"),
      });
      expect(d.status).toBe(201);
      const flagged = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/portfolio`),
      );
      const demo = flagged.suppliers.find(
        (x: { name: string }) => x.name === "Demo Merchant",
      );
      expect(demo.flags).toEqual(
        expect.arrayContaining(["OPEN_DISPUTES", "DELIVERY_ISSUES"]),
      );
      expect(flagged.closeOut.blockers).toContain(
        `${demo.supplierId}:OPEN_DISPUTES`,
      );
      // an obligation due today is not late; one due yesterday is
      const ob = (dueDate: string) =>
        post(s.owner, `/v1/admin/org/missions/${s.id}/obligations`, {
          title: "follow up",
          dueDate,
          orderId: oid,
          idempotencyKey: idemKey("b"),
        });
      const flagsOf = async () =>
        (
          (await body(
            await get(s.owner, `/v1/admin/org/missions/${s.id}/portfolio`),
          )) as {
            suppliers: {
              name: string;
              flags: string[];
              spentMinor: number;
              refundedMinor: number;
            }[];
          }
        ).suppliers.find((x) => x.name === "Demo Merchant")!;
      await ob("2026-10-23");
      expect((await flagsOf()).flags).not.toContain("OVERDUE_OBLIGATIONS");
      await ob("2026-10-22");
      expect((await flagsOf()).flags).toContain("OVERDUE_OBLIGATIONS");
      // a refund lowers what was spent; a resolved dispute no longer counts as open
      const dsp = (await body(d)).dispute.disputeId as string;
      const rf = await post(s.owner, `/v1/admin/org/disputes/${dsp}/resolve`, {
        decision: "REFUND",
        refundMinor: 1_000,
        evidenceKind: "PROVIDER_CONFIRMATION",
        evidenceRef: "re-1",
      });
      expect(rf.status).toBe(200);
      const after = await flagsOf();
      expect(after).toMatchObject({ spentMinor: 7_400, refundedMinor: 1_000 });
      expect(after.flags).not.toContain("OPEN_DISPUTES");
    });

    it("a single settled and delivered supplier is ready to close out, with no concentration warning", async () => {
      const s = await settledPurchase(h);
      const oid = (
        await body(
          await post(s.owner, `/v1/admin/org/purchase-orders/${s.poId}/order`, {
            idempotencyKey: idemKey("o"),
          }),
        )
      ).order.orderId as string;
      for (const status of ["SHIPPED", "DELIVERED"])
        await post(s.owner, `/v1/admin/org/orders/${oid}/events`, {
          kind: "STATUS",
          status,
          verify: true,
          evidenceKind: "OWNER_ATTESTATION",
          idempotencyKey: idemKey("e"),
        });
      const p = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/portfolio`),
      );
      expect(p.concentration).toEqual([]);
      expect(p.suppliers[0]).toMatchObject({
        spentMinor: 8_400,
        shareBps: 10000,
        flags: [],
      });
      expect(p.closeOut).toEqual({ ready: true, blockers: [] });
    });
  },
);
