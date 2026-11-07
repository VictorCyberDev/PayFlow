/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { idemKey } from "./helpers/mission-fixtures.js";
import { settledPurchase, TRUNCATE } from "./helpers/settled-order.js";
import {
  disputeGrounds,
  fulfillment,
  lineResult,
  type Condition,
  type ReceiptFact,
} from "../src/missions/fulfillment.js";

/**
 * V3 M42 — fulfillment. Receipts are a person's counts; the outcome is computed from the purchase order's lines and the receipts, and
 * the dispute grounds follow from the outcome. Shipments from agents are claims.
 */
const url = process.env.TEST_DATABASE_URL;
const r = (
  lineIndex: number,
  quantity: number,
  condition: Condition = "OK",
): ReceiptFact => ({ lineIndex, quantity, condition });

describe("M42 fulfillment outcome (pure)", () => {
  it("each line's outcome follows from what arrived", () => {
    const o = (rs: ReceiptFact[], ordered = 3) =>
      lineResult(0, ordered, rs).outcome;
    expect(o([])).toBe("PENDING");
    expect(o([r(0, 3)])).toBe("COMPLETE");
    expect(o([r(0, 1), r(0, 2)])).toBe("COMPLETE"); // receipts add up
    expect(o([r(0, 2)])).toBe("SHORT");
    expect(o([r(0, 4)])).toBe("OVER");
    expect(o([r(0, 2), r(0, 1, "DAMAGED")])).toBe("DAMAGED");
    expect(o([r(0, 2), r(0, 1, "WRONG_ITEM")])).toBe("WRONG_ITEM");
    expect(o([r(0, 1, "DAMAGED"), r(0, 1, "WRONG_ITEM")])).toBe("WRONG_ITEM"); // wrong beats damaged
    expect(o([r(0, 2), r(0, 2, "DAMAGED")])).toBe("OVER"); // more than ordered, whatever the condition
    expect(o([r(1, 3)])).toBe("PENDING"); // another line's receipts do not count
  });

  it("the order's outcome and the dispute grounds follow from the lines", () => {
    const lines = [{ quantity: 2 }, { quantity: 1 }];
    const f = (rs: ReceiptFact[]) => fulfillment(lines, rs);
    expect(f([]).outcome).toBe("PENDING");
    expect(f([r(0, 2)]).outcome).toBe("PARTIAL");
    expect(f([r(0, 2), r(1, 1)]).outcome).toBe("COMPLETE");
    expect(f([r(0, 1), r(1, 1)]).outcome).toBe("PARTIAL"); // short is not an issue yet: more may arrive
    expect(f([r(0, 2), r(1, 1, "DAMAGED")])).toMatchObject({
      outcome: "HAS_ISSUES",
      problems: ["LINE_1_DAMAGED"],
    });
    const short = f([r(0, 1), r(1, 1)]);
    expect(disputeGrounds(short.lines, false)).toEqual(["SHORT_DELIVERY"]);
    expect(disputeGrounds(short.lines, true)).toEqual([
      "NOT_DELIVERED_LATE",
      "SHORT_DELIVERY",
    ]);
    expect(disputeGrounds(f([r(0, 2), r(1, 1)]).lines, false)).toEqual([]);
    expect(disputeGrounds(f([r(0, 3)]).lines, false)).toEqual([
      "OVER_DELIVERY",
    ]);
  });

  it("property: the outcome is order-independent, COMPLETE only when every line is exactly met with good units, and receipts never reduce a total", () => {
    let seed = 42_042;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const conds: Condition[] = ["OK", "OK", "OK", "DAMAGED", "WRONG_ITEM"];
    let complete = 0;
    for (let i = 0; i < 3000; i++) {
      const lines = Array.from({ length: 1 + rnd(3) }, () => ({
        quantity: 1 + rnd(4),
      }));
      const rs: ReceiptFact[] = Array.from({ length: rnd(6) }, () =>
        r(rnd(lines.length), 1 + rnd(3), conds[rnd(conds.length)]),
      );
      const a = fulfillment(lines, rs);
      const shuffled = [...rs].sort(() => rnd(3) - 1);
      expect(fulfillment(lines, shuffled)).toEqual(a);
      const exact = lines.every(
        (l, k) =>
          rs
            .filter((x) => x.lineIndex === k && x.condition === "OK")
            .reduce((s, x) => s + x.quantity, 0) === l.quantity &&
          rs.filter((x) => x.lineIndex === k && x.condition !== "OK").length ===
            0,
      );
      expect(a.outcome === "COMPLETE").toBe(exact);
      if (exact) complete++;
      for (const l of a.lines)
        expect(l.receivedQty).toBe(l.okQty + l.damagedQty + l.wrongQty);
    }
    expect(complete).toBeGreaterThan(20);
  });
});

(url ? describe : describe.skip)(
  "M42 fulfillment (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const orderShipped = async (ship = true) => {
      const s = await settledPurchase(h);
      const id = (
        await body(
          await post(s.owner, `/v1/admin/org/purchase-orders/${s.poId}/order`, {
            idempotencyKey: idemKey("o"),
          }),
        )
      ).order.orderId as string;
      if (ship)
        await post(s.owner, `/v1/admin/org/orders/${id}/events`, {
          kind: "STATUS",
          status: "SHIPPED",
          verify: true,
          evidenceKind: "OWNER_ATTESTATION",
          idempotencyKey: idemKey("e"),
        });
      return { ...s, id };
    };
    const receipt = (t: string, id: string, b: Record<string, unknown>) =>
      post(t, `/v1/admin/org/orders/${id}/receipts`, {
        lineIndex: 0,
        quantity: 1,
        condition: "OK",
        evidenceKind: "OWNER_ATTESTATION",
        idempotencyKey: idemKey("r"),
        ...b,
      });
    const view = async (t: string, id: string, base = "/v1/admin/org") =>
      body(await h.call(t, "GET", `${base}/orders/${id}/fulfillment`));

    it("a receipt needs a person, evidence, an order the person has verified as shipped, and a real line", async () => {
      const s = await orderShipped(false);
      const early = await receipt(s.owner, s.id, {});
      expect([early.status, (await body(early)).reason]).toEqual([
        409,
        "ORDER_NOT_SHIPPED",
      ]);
      await post(s.owner, `/v1/admin/org/orders/${s.id}/events`, {
        kind: "STATUS",
        status: "SHIPPED",
        verify: true,
        evidenceKind: "OWNER_ATTESTATION",
        idempotencyKey: idemKey("e"),
      });
      expect((await receipt(s.c, s.id, {})).status).toBe(401); // agents have no receipt route: the member API refuses their credential
      const noLine = await receipt(s.owner, s.id, { lineIndex: 5 });
      expect([noLine.status, (await body(noLine)).reason]).toEqual([
        422,
        "NO_SUCH_LINE",
      ]);
      expect(
        (await receipt(s.owner, s.id, { evidenceKind: "NONE" })).status,
      ).toBe(400);
      expect((await receipt(s.owner, s.id, { quantity: 0 })).status).toBe(400);
      const ok = await receipt(s.owner, s.id, {
        idempotencyKey: "same-key-0123456789",
      });
      expect(ok.status).toBe(201);
      const again = await receipt(s.owner, s.id, {
        idempotencyKey: "same-key-0123456789",
      });
      expect([again.status, (await body(again)).replayed]).toEqual([200, true]);
      const reused = await receipt(s.owner, s.id, {
        idempotencyKey: "same-key-0123456789",
        quantity: 2,
      });
      expect(reused.status).toBe(409);
    });

    it("the outcome is computed from the receipts and the order's lines; damage and shortage open the matching dispute grounds", async () => {
      const s = await orderShipped();
      expect((await view(s.owner, s.id)).outcome).toBe("PENDING");
      await receipt(s.owner, s.id, { quantity: 1 });
      const done = await view(s.owner, s.id);
      expect(done).toMatchObject({ outcome: "COMPLETE", disputeGrounds: [] });
      expect(done.lines[0]).toMatchObject({
        ordered: 1,
        okQty: 1,
        outcome: "COMPLETE",
      });
      await receipt(s.owner, s.id, {
        quantity: 1,
        condition: "DAMAGED",
        note: "box crushed",
      });
      const bad = await view(s.owner, s.id);
      expect(bad.lines[0].outcome).toBe("OVER"); // 2 arrived for 1 ordered
      expect(bad.disputeGrounds).toEqual(["OVER_DELIVERY"]);
    });

    it("a damaged-only arrival is HAS_ISSUES with the damaged ground", async () => {
      const s = await orderShipped();
      await receipt(s.owner, s.id, { quantity: 1, condition: "DAMAGED" });
      const v = await view(s.owner, s.id);
      expect(v).toMatchObject({
        outcome: "HAS_ISSUES",
        problems: ["LINE_0_DAMAGED"],
        disputeGrounds: ["DAMAGED"],
      });
    });

    it("a shipment from the buyer agent is a claim; a person verifies with evidence; nobody else can report", async () => {
      const s = await orderShipped();
      const claim = await post(s.c, `/v1/agent/orders/${s.id}/shipments`, {
        carrier: "UPS",
        trackingRef: "1Z999",
        idempotencyKey: idemKey("s"),
      });
      expect([claim.status, (await body(claim)).verification]).toEqual([
        201,
        "CLAIMED",
      ]);
      expect(
        (
          await post(s.c, `/v1/agent/orders/${s.id}/shipments`, {
            carrier: "UPS",
            trackingRef: "1Z999",
            verify: true,
            evidenceKind: "DOCUMENT_REF",
            idempotencyKey: idemKey("s"),
          })
        ).status,
      ).toBe(403);
      const other = await post(s.b, `/v1/agent/orders/${s.id}/shipments`, {
        carrier: "UPS",
        trackingRef: "x",
        idempotencyKey: idemKey("s"),
      });
      expect([other.status, (await body(other)).reason]).toEqual([
        403,
        "NOT_THE_BUYER",
      ]);
      const noEv = await post(
        s.owner,
        `/v1/admin/org/orders/${s.id}/shipments`,
        {
          carrier: "UPS",
          trackingRef: "1Z999",
          verify: true,
          idempotencyKey: idemKey("s"),
        },
      );
      expect([noEv.status, (await body(noEv)).reason]).toEqual([
        422,
        "EVIDENCE_REQUIRED",
      ]);
      const ver = await post(
        s.owner,
        `/v1/admin/org/orders/${s.id}/shipments`,
        {
          carrier: "UPS",
          trackingRef: "1Z999",
          verify: true,
          evidenceKind: "DOCUMENT_REF",
          evidenceRef: "label.pdf",
          idempotencyKey: idemKey("s"),
        },
      );
      expect([ver.status, (await body(ver)).verification]).toEqual([
        201,
        "VERIFIED",
      ]);
      const v = await view(s.a, s.id, "/v1/agent");
      expect(
        v.shipments.map((x: { verification: string }) => x.verification),
      ).toEqual(["CLAIMED", "VERIFIED"]);
      await receipt(s.owner, s.id, {});
      await expect(
        h.repo.sql`update mission_receipts set quantity = 9`,
      ).rejects.toThrow(/append-only/);
      await expect(h.repo.sql`delete from mission_shipments`).rejects.toThrow(
        /append-only/,
      );
    });
  },
);
