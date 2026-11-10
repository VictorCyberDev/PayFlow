/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness, ADMIN_TOKEN } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  MISSIONS,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M57 (a slice) — recurring renewal checks through the real Gateway on PostgreSQL. A recurrence never buys: each due slot is checked
 * against the mission as it is then and the outcome is recorded once; pausing the mission stops the next check at once.
 */
const url = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;
(url ? describe : describe.skip)(
  "M57 recurring renewal checks (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        TRUNCATE + ",automation_jobs,automation_schedules,recurring_checks",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const run = async () =>
      (await body(await post(ADMIN_TOKEN, "/v1/admin/ops/automation/run"))) as {
        ran: number;
      };
    const checks = async (t: string, id: string) =>
      (
        (await body(
          await h.call(t, "GET", `${MISSIONS}/${id}/recurring`),
        )) as any
      ).checks as { outcome: string; slot: string; amountMinor: number }[];
    const setup = (t: string, id: string, over: Record<string, unknown> = {}) =>
      post(t, `${MISSIONS}/${id}/recurring`, {
        label: "Design tool",
        amountMinor: 30_000,
        everySeconds: 86_400,
        ...over,
      });
    const exposure = async (t: string, id: string) =>
      ((await body(await h.call(t, "GET", `${MISSIONS}/${id}/ledger`))) as any)
        .summary.exposureMinor as number;

    it("checks each due slot once, asks the owner, and spends nothing", async () => {
      const s = await activeMission(h, contract());
      const r = await setup(s.owner, s.id);
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      await run();
      expect(await checks(s.owner, s.id)).toEqual([]); // not due yet: the first check is one period away
      h.advance(DAY + 60_000);
      await run();
      await run(); // a repeated run records nothing twice
      const c = await checks(s.owner, s.id);
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        outcome: "DUE_FOR_OWNER",
        amountMinor: 30_000,
      });
      expect(await exposure(s.owner, s.id)).toBe(0); // nothing was held, committed or bought
      const list = await body(
        await h.call(s.owner, "GET", `${MISSIONS}/${s.id}/recurring`),
      );
      expect(list.notice).toContain("never buys");
      expect(list.schedules[0]).toMatchObject({
        label: "Design tool",
        active: true,
      });
    });

    it("pausing the mission stops the very next check; resuming lets later ones through; a stopped schedule makes no more", async () => {
      const s = await activeMission(h, contract());
      const sched = ((await body(await setup(s.owner, s.id))) as any)
        .scheduleId as string;
      h.advance(DAY + 60_000);
      await run();
      expect(
        (await post(s.owner, `${MISSIONS}/${s.id}/pause`, { reason: "review" }))
          .status,
      ).toBe(200);
      h.advance(DAY);
      await run();
      expect(
        (await post(s.owner, `${MISSIONS}/${s.id}/resume`, {})).status,
      ).toBe(200);
      h.advance(DAY);
      await run();
      const outcomes = (await checks(s.owner, s.id))
        .map((c) => c.outcome)
        .reverse();
      expect(outcomes).toEqual([
        "DUE_FOR_OWNER",
        "SKIPPED_MISSION_NOT_ACTIVE",
        "DUE_FOR_OWNER",
      ]);
      const stop = await post(
        s.owner,
        `${MISSIONS}/${s.id}/recurring/${sched}/stop`,
      );
      expect(stop.status).toBe(200);
      h.advance(3 * DAY);
      await run();
      expect(await checks(s.owner, s.id)).toHaveLength(3);
    });

    it("an amount above the single-purchase limit or the budget left is skipped with its own reason", async () => {
      const s = await activeMission(h, contract()); // single purchase limit 60,000; budget 150,000
      await setup(s.owner, s.id, { label: "Too big", amountMinor: 70_000 });
      h.advance(DAY + 60_000);
      await run();
      expect((await checks(s.owner, s.id)).map((c) => c.outcome)).toEqual([
        "SKIPPED_ABOVE_PURCHASE_LIMIT",
      ]);
    });

    it("who may set it up, what it refuses, and what cannot be changed", async () => {
      const s = await activeMission(h, contract());
      const viewer = await h.member("VIEWER");
      expect((await setup(viewer, s.id)).status).toBe(403);
      expect((await setup(s.owner, s.id, { everySeconds: 60 })).status).toBe(
        400,
      );
      expect((await setup(s.owner, s.id, { amountMinor: 0 })).status).toBe(400);
      const stranger = await h.ownerOf("org-other");
      expect((await setup(stranger, s.id)).status).toBe(404);
      expect(
        (await h.call(viewer, "GET", `${MISSIONS}/${s.id}/recurring`)).status,
      ).toBe(200); // a viewer may read
      expect(
        (
          await post(
            s.owner,
            `${MISSIONS}/${s.id}/recurring/sch_${"0".repeat(24)}/stop`,
          )
        ).status,
      ).toBe(404);
      await setup(s.owner, s.id);
      h.advance(DAY + 60_000);
      await run();
      await expect(
        h.repo.sql`update recurring_checks set outcome = 'DUE_FOR_OWNER'`,
      ).rejects.toThrow(/append-only/);
      await expect(h.repo.sql`delete from recurring_checks`).rejects.toThrow(
        /append-only/,
      );
    });
  },
);
