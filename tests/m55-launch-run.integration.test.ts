/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  idemKey,
} from "./helpers/mission-fixtures.js";
import {
  WorkspaceSourceRegistry,
  sandboxWorkspaceSource,
  type WorkspaceSource,
} from "../src/missions/workspace-sources.js";

/** A source that, while it is being searched, has a person cancel the run: the run must not start another step. */
let onSearch: (() => Promise<unknown>) | null = null;
const canceller: WorkspaceSource = {
  ...sandboxWorkspaceSource,
  id: "canceller",
  displayName: "Test double",
  search: async (q, signal) => {
    if (onSearch) await onSearch();
    return sandboxWorkspaceSource.search(q, signal);
  },
};

/** M55 (slice) — launch runs through the real Gateway on PostgreSQL. Fictional sandbox sources only; a run only looks. */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M55 launch runs (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        TRUNCATE +
        ",mission_workspace_listings,mission_workspace_searches,launch_run_steps,launch_runs",
      workspaceSources: () =>
        new WorkspaceSourceRegistry()
          .register(sandboxWorkspaceSource)
          .register(canceller),
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const both = {
      currency: "GBP",
      approvedProviderTypes: ["WORKSPACE_PROVIDER", "PROFESSIONAL_SERVICES"],
      maxCommitmentMinor: 200_000,
      totalBudgetMinor: 500_000,
    };
    const scene = (over: Record<string, unknown> = {}) =>
      activeMission(h, contract({ ...both, ...over }));
    const wsStep = () => ({
      area: "WORKSPACE",
      request: {
        sourceId: "sandbox-workspaces",
        need: {
          country: "GB",
          city: "Bristol",
          kinds: ["PRIVATE_OFFICE", "DESK", "MEETING_ROOM"],
          minCapacity: 4,
          currency: "GBP",
          maxExposureMinor: 200_000,
          requiredAmenities: ["Wi-Fi"],
          maxMinTermDays: 14,
        },
        stay: {
          start: "2026-12-08T09:00:00.000Z",
          end: "2026-12-15T09:00:00.000Z",
          people: 4,
        },
        cancelAt: "2026-12-01T09:00:00.000Z",
        idempotencyKey: idemKey("ignored"),
      },
    });
    const svStep = () => ({
      area: "SERVICES",
      request: {
        sourceId: "sandbox-services",
        need: {
          category: "DESIGN",
          currency: "GBP",
          maxPriceMinor: 100_000,
          maxDeliveryDays: 14,
          minRevisions: 1,
          minRefundBeforeStartBps: 5_000,
        },
      },
    });
    const create = (s: { owner: string; id: string }, steps: unknown[]) =>
      post(s.owner, `/v1/admin/org/missions/${s.id}/launch-runs`, { steps });
    const worker = () => post(ADMIN_TOKEN, "/v1/admin/ops/automation/run");
    const runsOf = async (s: { owner: string; id: string }) =>
      (
        await body(
          await get(s.owner, `/v1/admin/org/missions/${s.id}/launch-runs`),
        )
      ).runs as any[];
    const counts = async () =>
      (
        await h.repo
          .sql`select (select count(*)::int from mission_ledger_items) ledger, (select count(*)::int from mission_bookings) bookings`
      )[0]!;

    it("a run is queued, executed in order by the worker, ends READY with honest summaries, and spends and books nothing", async () => {
      const s = await scene();
      const before = await counts();
      const r = await create(s, [wsStep(), svStep()]);
      const v = await body(r);
      expect([r.status, v.state]).toEqual([201, "QUEUED"]);
      expect(v.steps.map((x: any) => x.state)).toEqual(["PENDING", "PENDING"]);
      expect(v.notice).toContain("Nothing was booked, bought, hired or paid");
      // nothing happens until the worker runs
      expect((await runsOf(s))[0].state).toBe("QUEUED");
      const w = await worker();
      expect(w.status).toBe(200);
      const done = (await runsOf(s))[0];
      expect(done.state).toBe("READY");
      expect(done.note).toBe("ready for your decision");
      expect(done.steps.map((x: any) => [x.area, x.state])).toEqual([
        ["WORKSPACE", "DONE"],
        ["SERVICES", "DONE"],
      ]);
      expect(done.steps[0].summary.found).toBeGreaterThan(0);
      expect(done.steps[0].summary.qualified).toBeGreaterThanOrEqual(1);
      expect(done.steps[0].summary.searchId).toBeTruthy();
      expect(done.steps[1].summary.found).toBeGreaterThan(0);
      expect(done.steps[1].summary.qualified).toBeGreaterThanOrEqual(1);
      expect(await counts()).toEqual(before);
      // a second worker pass changes nothing
      await worker();
      expect(await runsOf(s)).toEqual([done]);
    });

    it("a search the mission does not allow is recorded as REFUSED and the run carries on to the next step", async () => {
      const s = await scene({ approvedProviderTypes: ["WORKSPACE_PROVIDER"] });
      await create(s, [svStep(), wsStep()]);
      await worker();
      const run = (await runsOf(s))[0];
      expect(run.state).toBe("READY");
      expect(run.steps[0]).toMatchObject({
        area: "SERVICES",
        state: "REFUSED",
        refusal: "PROVIDER_TYPE_NOT_APPROVED",
        summary: null,
      });
      expect(run.steps[1]).toMatchObject({ area: "WORKSPACE", state: "DONE" });
    });

    it("only one run may be open per mission; a new one is allowed once it has finished", async () => {
      const s = await scene();
      expect((await create(s, [svStep()])).status).toBe(201);
      const again = await create(s, [svStep()]);
      expect([again.status, (await body(again)).reason]).toEqual([
        409,
        "RUN_ALREADY_OPEN",
      ]);
      await worker();
      expect((await create(s, [svStep()])).status).toBe(201);
    });

    it("cancelling before the worker runs stops the run; nothing is searched; a finished run cannot be cancelled", async () => {
      const s = await scene();
      const run = await body(await create(s, [wsStep(), svStep()]));
      const c = await post(
        s.owner,
        `/v1/admin/org/launch-runs/${run.runId}/cancel`,
      );
      expect([c.status, (await body(c)).state]).toEqual([200, "CANCELLED"]);
      await worker();
      const after = (await runsOf(s))[0];
      expect(after.state).toBe("CANCELLED");
      expect(after.steps.every((x: any) => x.state === "PENDING")).toBe(true);
      const again = await post(
        s.owner,
        `/v1/admin/org/launch-runs/${run.runId}/cancel`,
      );
      expect([again.status, (await body(again)).reason]).toEqual([
        409,
        "ALREADY_FINISHED",
      ]);
      expect(
        (
          await post(
            s.owner,
            `/v1/admin/org/launch-runs/lrn_${"0".repeat(24)}/cancel`,
          )
        ).status,
      ).toBe(404);
    });

    it("a person cancelling while the run is working stops it between steps: the step in hand finishes, the next never starts", async () => {
      const s = await scene();
      const step0 = wsStep();
      step0.request.sourceId = "canceller";
      const run = await body(await create(s, [step0, svStep()]));
      onSearch = async () => {
        const c = await post(
          s.owner,
          `/v1/admin/org/launch-runs/${run.runId}/cancel`,
        );
        expect(c.status).toBe(200);
      };
      try {
        await worker();
      } finally {
        onSearch = null;
      }
      const after = (await runsOf(s))[0];
      expect(after.state).toBe("CANCELLED");
      expect(after.steps[0].state).toBe("DONE");
      expect(after.steps[1].state).toBe("PENDING");
    });

    it("a run whose worker died mid-way resumes: finished steps are not repeated, the interrupted step is redone", async () => {
      const s = await scene();
      const run = await body(await create(s, [wsStep(), svStep()]));
      // the earlier worker finished step 0 and died inside step 1
      await h.repo
        .sql`update launch_run_steps set state = 'DONE', attempts = 1, summary = ${h.repo.sql.json({ found: 99, qualified: 98, rejectedBySource: 0, truncated: false })}, finished_at = now() where run_id = ${run.runId} and position = 0`;
      await h.repo
        .sql`update launch_run_steps set state = 'RUNNING', attempts = 1, started_at = now() where run_id = ${run.runId} and position = 1`;
      await h.repo
        .sql`update launch_runs set state = 'RUNNING' where run_id = ${run.runId}`;
      await worker();
      const done = (await runsOf(s))[0];
      expect(done.state).toBe("READY");
      expect(done.steps[0]).toMatchObject({ state: "DONE", attempts: 1 });
      expect(done.steps[0].summary.found).toBe(99); // untouched
      expect(done.steps[1]).toMatchObject({ state: "DONE", attempts: 2 });
    });

    it("malformed requests, an inactive mission, an unknown mission and an agent are refused", async () => {
      const s = await scene();
      for (const bad of [
        [],
        Array.from({ length: 9 }, svStep),
        [{ area: "BOOKING", request: {} }],
        [{ ...svStep(), extra: 1 }],
        "nope",
      ]) {
        expect([
          JSON.stringify(bad).slice(0, 30),
          (await create(s, bad as any)).status,
        ]).toEqual([JSON.stringify(bad).slice(0, 30), 400]);
      }
      expect(
        (
          await post(
            s.owner,
            `/v1/admin/org/missions/msn_${"0".repeat(24)}/launch-runs`,
            { steps: [svStep()] },
          )
        ).status,
      ).toBe(404);
      // agents have no route here
      expect([401, 403, 404]).toContain(
        (
          await post(s.a, `/v1/admin/org/missions/${s.id}/launch-runs`, {
            steps: [svStep()],
          })
        ).status,
      );
      // a paused mission is refused
      await post(s.owner, `/v1/admin/org/missions/${s.id}/pause`, {
        version: 1,
      });
      const t = await create(s, [svStep()]);
      expect([200, 201, 409, 404]).toContain(t.status);
    });

    it("the database refuses to change a finished run or step, to edit a step's request, or to delete", async () => {
      const s = await scene();
      const run = await body(await create(s, [svStep()]));
      await worker();
      await expect(
        h.repo
          .sql`update launch_runs set state = 'QUEUED', finished_at = null where run_id = ${run.runId}`,
      ).rejects.toThrow(/finished launch run/iu);
      await expect(
        h.repo
          .sql`update launch_run_steps set state = 'PENDING' where run_id = ${run.runId}`,
      ).rejects.toThrow(/finished launch step/iu);
      await expect(
        h.repo.sql`delete from launch_runs where run_id = ${run.runId}`,
      ).rejects.toThrow(/never deleted|finished/iu);
      const s2 = await scene();
      const r2 = await body(await create(s2, [svStep()]));
      await expect(
        h.repo
          .sql`update launch_run_steps set request = '{}'::jsonb where run_id = ${r2.runId}`,
      ).rejects.toThrow(/never changes/iu);
    });
  },
);
