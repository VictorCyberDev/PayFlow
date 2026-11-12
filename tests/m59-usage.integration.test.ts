/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { usagePeriod } from "../src/network/org-views.js";

/**
 * V3 M59 — usage and billing, through the real Gateway on PostgreSQL.
 *
 * The thing worth testing here is not arithmetic, it is honesty. A usage screen is the one place where a product can
 * imply a debt that does not exist. So: what is shown must be what `usage_events` actually holds, the total must be
 * zero because no price has been agreed, and the response must say both of those in words a person reads.
 */
const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  "M59 usage and billing (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: "usage_events" });
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const usage = async (t: string) =>
      (await body(await h.call(t, "GET", "/v1/admin/org/usage"))).usage;

    /** A real row in the table the Gateway writes to, not a stub in front of it. */
    const record = async (
      meter: string,
      quantity: number,
      occurredAt: string,
      org = "payflow-sandbox",
    ) => {
      await h.repo.sql`insert into usage_events
        (id, organization_id, environment, meter, quantity, occurred_at, idempotency_key, metadata)
        values (${`ue_${meter}_${occurredAt}_${quantity}_${org}`}, ${org}, 'SANDBOX', ${meter}, ${quantity},
          ${occurredAt}, ${`k_${meter}_${occurredAt}_${quantity}_${org}`}, '{}'::jsonb)`;
    };

    it("the period is the UTC calendar month the moment falls in", () => {
      expect(usagePeriod("2026-11-11T14:00:00.000Z")).toEqual({
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-12-01T00:00:00.000Z",
      });
      // Month ends are where an off-by-one would hide.
      expect(usagePeriod("2026-12-31T23:59:59.999Z")).toEqual({
        start: "2026-12-01T00:00:00.000Z",
        end: "2027-01-01T00:00:00.000Z",
      });
      expect(usagePeriod("2026-01-01T00:00:00.000Z").start).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });

    it("an organization that has done nothing is told so, rather than shown a bill", async () => {
      const owner = await h.ownerOf();
      const u = await usage(owner);
      expect(u.meters).toEqual([]);
      expect(u.totalThisPeriod).toBe(0);
      expect(u.charged).toBe(false);
      expect(u.invoicePreview.totalMinor).toBe(0);
      expect(u.priceNotice).toMatch(/no price has been agreed/u);
      expect(u.notice).toMatch(/nothing here has been charged/u);
    });

    it("what is shown is what the table holds, split into this month and all time", async () => {
      const owner = await h.ownerOf();
      const { start } = usagePeriod(h.iso());
      const inPeriod = new Date(
        Date.parse(start) + 3 * 86_400_000,
      ).toISOString();
      const beforePeriod = new Date(
        Date.parse(start) - 86_400_000,
      ).toISOString();

      await record("GOVERNED_ACTION", 4, inPeriod);
      await record("GOVERNED_ACTION", 7, beforePeriod);
      await record("VERIFY_CALL", 2, inPeriod);

      const u = await usage(owner);
      const byMeter = Object.fromEntries(
        u.meters.map((m: any) => [m.meter, m]),
      );
      // 4 this month, 11 ever: the row outside the period counts to the lifetime figure only.
      expect(byMeter.GOVERNED_ACTION).toMatchObject({
        thisPeriod: 4,
        lifetime: 11,
      });
      expect(byMeter.VERIFY_CALL).toMatchObject({
        thisPeriod: 2,
        lifetime: 2,
      });
      expect(u.totalThisPeriod).toBe(6);

      // The preview lists only meters used this period, and every amount is zero.
      const lines = Object.fromEntries(
        u.invoicePreview.lines.map((l: any) => [l.meter, l]),
      );
      expect(Object.keys(lines).sort()).toEqual([
        "BASE",
        "GOVERNED_ACTION",
        "VERIFY_CALL",
      ]);
      expect(lines.GOVERNED_ACTION.quantity).toBe(4);
      for (const l of u.invoicePreview.lines) {
        expect(l.unitAmountMinor).toBe(0);
        expect(l.amountMinor).toBe(0);
      }
      expect(u.invoicePreview.totalMinor).toBe(0);
      expect(u.planId).toBe("DEVELOPER");
    });

    it("another organization's usage is never counted into this one", async () => {
      const owner = await h.ownerOf();
      const stranger = await h.ownerOf("other-org");
      const { start } = usagePeriod(h.iso());
      const inPeriod = new Date(Date.parse(start) + 86_400_000).toISOString();

      await record("GOVERNED_ACTION", 5, inPeriod, "payflow-sandbox");
      await record("GOVERNED_ACTION", 99, inPeriod, "other-org");

      expect((await usage(owner)).totalThisPeriod).toBe(5);
      expect((await usage(stranger)).totalThisPeriod).toBe(99);
    });

    it("a role without the finance permission cannot read usage", async () => {
      await h.ownerOf();
      // SECURITY_ADMIN holds view:security and view:agents, not view:finance.
      const security = await h.member("SECURITY_ADMIN");
      const r = await h.call(security, "GET", "/v1/admin/org/usage");
      expect(r.status).toBe(403);
      // A viewer may look.
      const viewer = await h.member("VIEWER");
      expect((await h.call(viewer, "GET", "/v1/admin/org/usage")).status).toBe(
        200,
      );
    });
  },
);
