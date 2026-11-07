/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { idemKey } from "./helpers/mission-fixtures.js";
import { settledPurchase, TRUNCATE } from "./helpers/settled-order.js";
import {
  addDays,
  addMonths,
  derive,
  isDate,
  stateOf,
} from "../src/missions/obligations.js";

/**
 * V3 M44 — obligations. Dates come from verified facts only (a claimed delivery starts nothing), exist once per order and kind, and
 * their urgency is computed when asked. Only a person closes one. Nothing here moves money.
 */
const url = process.env.TEST_DATABASE_URL;

describe("M44 obligation dates (pure)", () => {
  it("calendar months clamp to the end of the month, across leap years and year ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonths("2026-03-31", 1)).toBe("2026-04-30");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-12-31", 12)).toBe("2027-12-31");
    expect(addMonths("2026-05-31", 0)).toBe("2026-05-31");
    expect(addMonths("2026-10-30", 24)).toBe("2028-10-30");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-27", 2)).toBe("2028-02-29");
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2026-1-1")).toBe(false);
    expect(isDate("next week")).toBe(false);
  });

  it("property: derived dates are real dates, never earlier than the start, and months land in the right month", () => {
    let seed = 44_044;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let i = 0; i < 4000; i++) {
      const y = 2024 + rnd(6);
      const m = 1 + rnd(12);
      const d = 1 + rnd(28 + rnd(4));
      const start = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, 31)).padStart(2, "0")}`;
      if (!isDate(start)) continue;
      const n = rnd(60);
      const out = addMonths(start, n);
      expect(isDate(out)).toBe(true);
      expect(out >= start).toBe(true);
      const total = y * 12 + (m - 1) + n;
      expect(out.slice(0, 7)).toBe(
        `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`,
      );
      expect(Number(out.slice(8))).toBeLessThanOrEqual(Number(start.slice(8)));
      const k = rnd(400);
      expect(addDays(addDays(start, k), -k)).toBe(start);
    }
  });

  it("only verified delivery starts the return window and the warranty; urgency is computed", () => {
    const terms = {
      deliveryDays: 10,
      returnWindowDays: 30,
      warrantyMonths: 12,
    };
    const before = derive({
      orderCreatedDate: "2026-10-23",
      deliveredDate: null,
      terms,
    });
    expect(before.map((x) => x.kind)).toEqual(["DELIVERY_DEADLINE"]);
    expect(before[0]!.dueDate).toBe("2026-11-02");
    const after = derive({
      orderCreatedDate: "2026-10-23",
      deliveredDate: "2026-11-01",
      terms,
    });
    expect(after.map((x) => [x.kind, x.dueDate])).toEqual([
      ["DELIVERY_DEADLINE", "2026-11-02"],
      ["RETURN_WINDOW", "2026-12-01"],
      ["WARRANTY_END", "2027-11-01"],
    ]);
    expect(
      derive({
        orderCreatedDate: "2026-10-23",
        deliveredDate: "2026-11-01",
        terms: {},
      }),
    ).toEqual([]);
    expect(stateOf("OPEN", "2026-10-22", "2026-10-23")).toBe("OVERDUE");
    expect(stateOf("OPEN", "2026-10-23", "2026-10-23")).toBe("DUE_SOON"); // due today is not late
    expect(stateOf("OPEN", "2026-10-30", "2026-10-23")).toBe("DUE_SOON");
    expect(stateOf("OPEN", "2026-10-31", "2026-10-23")).toBe("UPCOMING");
    expect(stateOf("DONE", "2020-01-01", "2026-10-23")).toBe("DONE");
    expect(stateOf("WAIVED", "2020-01-01", "2026-10-23")).toBe("WAIVED");
  });
});

(url ? describe : describe.skip)(
  "M44 obligations (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ordered = async () => {
      const s = await settledPurchase(h, {
        terms: { deliveryDays: 10, returnWindowDays: 30, warrantyMonths: 12 },
      });
      const oid = (
        await body(
          await post(s.owner, `/v1/admin/org/purchase-orders/${s.poId}/order`, {
            idempotencyKey: idemKey("o"),
          }),
        )
      ).order.orderId as string;
      return { ...s, oid };
    };
    const ev = (
      t: string,
      oid: string,
      b: Record<string, unknown>,
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/orders/${oid}/events`, {
        idempotencyKey: idemKey("e"),
        ...b,
      });
    const derived = (t: string, oid: string) =>
      post(t, `/v1/admin/org/orders/${oid}/obligations/derive`);

    it("derives the delivery deadline at once; the return window and warranty only after a person verifies delivery; deriving again changes nothing", async () => {
      const s = await ordered();
      const first = await body(await derived(s.owner, s.oid));
      expect(first.created).toBe(1);
      expect(first.obligations[0]).toMatchObject({
        kind: "DELIVERY_DEADLINE",
        dueDate: "2026-11-02",
        state: "UPCOMING",
        status: "OPEN",
      });
      // an agent's claim of delivery starts nothing
      await ev(
        s.c,
        s.oid,
        { kind: "STATUS", status: "DELIVERED" },
        "/v1/agent",
      );
      expect((await body(await derived(s.owner, s.oid))).created).toBe(0);
      // a person verifies shipping then delivery
      await ev(s.owner, s.oid, {
        kind: "STATUS",
        status: "SHIPPED",
        verify: true,
        evidenceKind: "OWNER_ATTESTATION",
      });
      await ev(s.owner, s.oid, {
        kind: "STATUS",
        status: "DELIVERED",
        verify: true,
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "pod.pdf",
      });
      const second = await body(await derived(s.owner, s.oid));
      expect(second.created).toBe(2);
      expect(
        second.obligations.map((o: { kind: string; dueDate: string }) => [
          o.kind,
          o.dueDate,
        ]),
      ).toEqual([
        ["DELIVERY_DEADLINE", "2026-11-02"],
        ["RETURN_WINDOW", "2026-11-22"],
        ["WARRANTY_END", "2027-10-23"],
      ]);
      expect((await body(await derived(s.owner, s.oid))).created).toBe(0);
      // agents cannot derive; the member API refuses their credential
      expect((await derived(s.c, s.oid)).status).toBe(401);
    });

    it("an agent may add a reminder; only a person closes an obligation, once; a closed one cannot change", async () => {
      const s = await ordered();
      const r = await post(s.a, `/v1/agent/missions/${s.id}/obligations`, {
        title: "Renew support plan",
        dueDate: "2026-10-26",
        kind: "RENEWAL",
        idempotencyKey: idemKey("b"),
      });
      expect(r.status).toBe(201);
      const ob = (await body(r)).obligation;
      expect(ob).toMatchObject({
        kind: "RENEWAL",
        state: "DUE_SOON",
        createdBy: "agent:a",
      });
      expect(
        (
          await post(s.a, `/v1/agent/missions/${s.id}/obligations`, {
            title: "x",
            dueDate: "2026-02-30",
            idempotencyKey: idemKey("b"),
          })
        ).status,
      ).toBe(400);
      const key = "same-key-0123456789";
      const a = await post(s.a, `/v1/agent/missions/${s.id}/obligations`, {
        title: "Pay deposit",
        dueDate: "2026-10-20",
        kind: "PAYMENT_DUE",
        amountMinor: 500,
        idempotencyKey: key,
      });
      expect((await body(a)).obligation.state).toBe("OVERDUE");
      const again = await post(s.a, `/v1/agent/missions/${s.id}/obligations`, {
        title: "Pay deposit",
        dueDate: "2026-10-20",
        kind: "PAYMENT_DUE",
        amountMinor: 500,
        idempotencyKey: key,
      });
      expect([again.status, (await body(again)).replayed]).toEqual([200, true]);
      expect(
        (
          await post(s.a, `/v1/agent/missions/${s.id}/obligations`, {
            title: "Different",
            dueDate: "2026-10-20",
            idempotencyKey: key,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(s.a, `/v1/agent/obligations/${ob.obligationId}/resolve`, {
            outcome: "DONE",
          })
        ).status,
      ).toBe(404); // no agent route
      const done = await post(
        s.owner,
        `/v1/admin/org/obligations/${ob.obligationId}/resolve`,
        { outcome: "DONE", note: "renewed" },
      );
      expect((await body(done)).obligation).toMatchObject({
        status: "DONE",
        state: "DONE",
        resolutionNote: "renewed",
      });
      const replay = await post(
        s.owner,
        `/v1/admin/org/obligations/${ob.obligationId}/resolve`,
        { outcome: "DONE" },
      );
      expect((await body(replay)).replayed).toBe(true);
      const flip = await post(
        s.owner,
        `/v1/admin/org/obligations/${ob.obligationId}/resolve`,
        { outcome: "WAIVED" },
      );
      expect([flip.status, (await body(flip)).reason]).toEqual([
        409,
        "ALREADY_RESOLVED",
      ]);
      await expect(
        h.repo
          .sql`update mission_obligations set title = 'x' where obligation_id = ${ob.obligationId}`,
      ).rejects.toThrow(/resolved obligation cannot change/);
      await expect(h.repo.sql`delete from mission_obligations`).rejects.toThrow(
        /never deleted/,
      );
    });

    it("the list counts what is overdue, due soon and upcoming as of today, in due-date order", async () => {
      const s = await ordered();
      await derived(s.owner, s.oid);
      for (const [title, dueDate] of [
        ["late", "2026-10-01"],
        ["soon", "2026-10-25"],
        ["later", "2027-01-01"],
      ] as const)
        await post(s.owner, `/v1/admin/org/missions/${s.id}/obligations`, {
          title,
          dueDate,
          idempotencyKey: idemKey("b"),
        });
      const l = await body(
        await h.call(s.a, "GET", `/v1/agent/missions/${s.id}/obligations`),
      );
      expect(l.counts).toMatchObject({
        OVERDUE: 1,
        DUE_SOON: 1,
        UPCOMING: 2,
        DONE: 0,
        WAIVED: 0,
      });
      expect(l.obligations.map((o: { title: string }) => o.title)[0]).toBe(
        "late",
      );
      const dates = l.obligations.map((o: { dueDate: string }) => o.dueDate);
      expect(dates).toEqual([...dates].sort());
      // an order of another mission cannot be named
      const bad = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/obligations`,
        {
          title: "x",
          dueDate: "2026-12-01",
          orderId: "ord_" + "0".repeat(24),
          idempotencyKey: idemKey("b"),
        },
      );
      expect(bad.status).toBe(404);
    });
  },
);
