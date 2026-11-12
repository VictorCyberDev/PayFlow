/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
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
        TRUNCATE +
        ",automation_jobs,automation_schedules,recurring_decisions,recurring_checks",
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

    // ------------------------------------------------------------------ the owner's answer (M57 completion)
    const dueCheck = async (s: { owner: string; id: string }) => {
      await setup(s.owner, s.id);
      h.advance(DAY + 60_000);
      await run();
      const c = await checks(s.owner, s.id);
      expect(c[0]).toMatchObject({ outcome: "DUE_FOR_OWNER" });
      return (c[0] as any).checkId as string;
    };
    const answer = (t: string, checkId: string, how: "approve" | "decline") =>
      post(t, `/v1/admin/org/recurring-checks/${checkId}/${how}`, {});
    const listing = async (t: string, id: string) =>
      (await body(
        await h.call(t, "GET", `${MISSIONS}/${id}/recurring`),
      )) as any;

    it("a due renewal takes the owner's answer, and saying yes still buys nothing", async () => {
      const s = await activeMission(h, contract());
      const before = await exposure(s.owner, s.id);
      const checkId = await dueCheck(s);

      // Before the answer it is the one thing on the screen that needs a person.
      let v = await listing(s.owner, s.id);
      expect(v.awaitingYouCount).toBe(1);
      expect(v.checks[0]).toMatchObject({ awaitingYou: true, decision: null });

      const r = await answer(s.owner, checkId, "approve");
      expect(r.status, await r.clone().text()).toBe(200);
      const d = await body(r);
      expect(d.decision).toBe("APPROVED");
      expect(d.notice).toMatch(/Nothing has been bought or paid/u);

      v = await listing(s.owner, s.id);
      expect(v.awaitingYouCount).toBe(0);
      expect(v.checks[0]).toMatchObject({
        decision: "APPROVED",
        awaitingYou: false,
      });
      expect(v.checks[0].decidedAt).toBeTruthy();
      // The whole point: an approval here is intent, not money.
      expect(await exposure(s.owner, s.id)).toBe(before);
    });

    it("one answer per due renewal, and only a renewal that actually came due can be answered", async () => {
      const s = await activeMission(h, contract());
      const checkId = await dueCheck(s);
      expect((await answer(s.owner, checkId, "approve")).status).toBe(200);
      // A second answer, in either direction, is refused rather than overwriting the first.
      const again = await answer(s.owner, checkId, "approve");
      expect(again.status).toBe(409);
      expect((await body(again)).reason).toBe("ALREADY_DECIDED");
      expect(
        (await body(await answer(s.owner, checkId, "decline"))).reason,
      ).toBe("ALREADY_DECIDED");
      // And the record of it cannot be edited away.
      await expect(
        h.repo.sql`update recurring_decisions set decision = 'DECLINED'`,
      ).rejects.toThrow(/append-only/);
      await expect(h.repo.sql`delete from recurring_decisions`).rejects.toThrow(
        /append-only/,
      );

      // A check that was skipped has nothing to decide.
      const t = await activeMission(h, contract());
      await setup(t.owner, t.id, { amountMinor: 900_000 }); // above the single-purchase limit
      h.advance(DAY + 60_000);
      await run();
      const skipped = (await checks(t.owner, t.id))[0] as any;
      expect(skipped.outcome).toBe("SKIPPED_ABOVE_PURCHASE_LIMIT");
      const no = await answer(t.owner, skipped.checkId, "approve");
      expect(no.status).toBe(409);
      expect((await body(no)).reason).toBe("NOT_DUE");
    });

    it("an answer does not stand on a mission that is no longer active, and another organization cannot answer at all", async () => {
      const s = await activeMission(h, contract());
      const checkId = await dueCheck(s);

      const stranger = await h.ownerOf("other-org");
      expect((await answer(stranger, checkId, "approve")).status).toBe(404);

      expect((await post(s.owner, `${MISSIONS}/${s.id}/pause`)).status).toBe(
        200,
      );
      const r = await answer(s.owner, checkId, "approve");
      expect(r.status).toBe(409);
      expect((await body(r)).reason).toBe("MISSION_NOT_ACTIVE");
      // Nothing was recorded, so the answer is still open if the mission comes back.
      expect(
        Number(
          (
            await h.repo.sql`select count(*)::int c from recurring_decisions`
          )[0]!.c,
        ),
      ).toBe(0);
    });

    it("resuming a paused schedule starts from now, not from the gap it slept through", async () => {
      const s = await activeMission(h, contract());
      const created = await body(await setup(s.owner, s.id));
      const scheduleId = created.scheduleId as string;

      // Stop it, then let a long time pass. A stopped schedule records nothing.
      expect(
        (
          await post(
            s.owner,
            `${MISSIONS}/${s.id}/recurring/${scheduleId}/stop`,
          )
        ).status,
      ).toBe(200);
      h.advance(10 * DAY);
      await run();
      expect(await checks(s.owner, s.id)).toEqual([]);

      // Resuming says when it will next look, and that time is in the future.
      const res = await post(
        s.owner,
        `${MISSIONS}/${s.id}/recurring/${scheduleId}/resume`,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const next = (await body(res)).nextCheck as string;
      expect(Date.parse(next)).toBeGreaterThan(h.now());

      // The ten days it slept through are not replayed as ten renewals that were "due" in the past.
      await run();
      expect(await checks(s.owner, s.id)).toEqual([]);
      h.advance(DAY + 60_000);
      await run();
      const after = await checks(s.owner, s.id);
      expect(after).toHaveLength(1);
      expect(Date.parse(after[0]!.slot)).toBeGreaterThanOrEqual(
        Date.parse(next),
      );
    });

    it("a schedule cannot be resumed onto a mission that is not active, nor by another organization", async () => {
      const s = await activeMission(h, contract());
      const scheduleId = (await body(await setup(s.owner, s.id)))
        .scheduleId as string;
      expect(
        (
          await post(
            s.owner,
            `${MISSIONS}/${s.id}/recurring/${scheduleId}/stop`,
          )
        ).status,
      ).toBe(200);
      expect((await post(s.owner, `${MISSIONS}/${s.id}/pause`)).status).toBe(
        200,
      );
      const r = await post(
        s.owner,
        `${MISSIONS}/${s.id}/recurring/${scheduleId}/resume`,
      );
      expect(r.status).toBe(409);
      expect((await body(r)).reason).toBe("MISSION_NOT_ACTIVE");

      const stranger = await h.ownerOf("other-org");
      expect(
        (
          await post(
            stranger,
            `${MISSIONS}/${s.id}/recurring/${scheduleId}/resume`,
          )
        ).status,
      ).toBe(404);
    });
  },
);
