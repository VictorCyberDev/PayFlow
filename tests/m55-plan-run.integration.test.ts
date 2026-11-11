/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  idemKey,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M55 — plan runs through the real Gateway on PostgreSQL.
 *
 * The point of these tests is the boundary, not the throughput. A plan run exists to move work along a real dependency
 * graph and write down who has to act; the things that matter are the things it REFUSES to do:
 *   - it never approves a task that needs a person's approval, however long it waits;
 *   - it never claims a task whose agent is not allowed to do it, because it goes through the same capability check;
 *   - it never buys, hires, books, pays or contacts anyone, so no ledger row and no booking ever appears;
 *   - it stops when the mission is paused, and stops when the plan it was started on is replaced.
 * Everything it CAN do, it does durably: a second pass changes nothing, and a lost worker resumes.
 */
const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  "M55 plan runs (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate: TRUNCATE + ",plan_run_actions,plan_runs,automation_jobs",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const worker = () => post(ADMIN_TOKEN, "/v1/admin/ops/automation/run");

    const scene = () => activeMission(h, contract());
    const MISSIONS = "/v1/admin/org/missions";

    /** The deterministic template planner: a real four-task graph derived from the contract alone. */
    const templatePlan = (owner: string, id: string) =>
      post(owner, `${MISSIONS}/${id}/plans`, {
        source: "TEMPLATE",
        idempotencyKey: idemKey("tpl"),
      });
    const humanPlan = (owner: string, id: string, tasks: unknown[]) =>
      post(owner, `${MISSIONS}/${id}/plans`, {
        source: "HUMAN",
        idempotencyKey: idemKey("hum"),
        draft: { rationale: "for the test", tasks },
      });
    const start = (owner: string, id: string) =>
      post(owner, `${MISSIONS}/${id}/plan-runs`);
    const runsOf = async (owner: string, id: string) =>
      (await body(await get(owner, `${MISSIONS}/${id}/plan-runs`)))
        .runs as any[];
    /** Select by id, never by position: the harness freezes the clock, so two runs share created_at. */
    const runById = async (owner: string, id: string, runId: string) =>
      (await runsOf(owner, id)).find((r) => r.runId === runId)!;
    const tasksOf = async (owner: string, id: string) =>
      (await body(await get(owner, `${MISSIONS}/${id}/plans`))).tasks as any[];
    const byKey = (ts: any[], k: string) => ts.find((t) => t.key === k)!;
    const actionsFor = (run: any, k: string) =>
      run.actions.filter((a: any) => a.taskKey === k).map((a: any) => a.action);
    /** Nothing financial may ever move because of a plan run. */
    const money = async () =>
      (
        await h.repo
          .sql`select (select count(*)::int from mission_ledger_items) ledger,
                      (select count(*)::int from mission_purchase_orders) orders,
                      (select count(*)::int from mission_messages) messages`
      )[0]!;

    it("a run drives the real dependency graph, hands off what nothing can do, and says who acts next", async () => {
      const { owner, id } = await scene();
      expect((await templatePlan(owner, id)).status).toBe(201);
      const before = await money();

      const created = await body(await start(owner, id));
      expect(created.state).toBe("QUEUED");
      expect(created.planVersion).toBe(1);
      expect(created.notice).toContain("never approves anything");
      // Nothing happens until the worker runs.
      expect((await runsOf(owner, id))[0].state).toBe("QUEUED");

      expect((await worker()).status).toBe(200);
      const run = (await runsOf(owner, id))[0];

      // The run moved everything it could and then stopped, rather than claiming success.
      expect(run.state).toBe("WAITING_ON_PEOPLE");
      expect(run.finishedAt).toBeTruthy();
      expect(run.passes).toBeGreaterThanOrEqual(1);

      // clarify-requirements was READY and EXECUTABLE. No specialist is connected, so it is a handoff that says so.
      expect(actionsFor(run, "clarify-requirements")).toContain("HANDED_OFF");
      const tasks = await tasksOf(owner, id);
      expect(byKey(tasks, "clarify-requirements").state).toBe("HANDED_OFF");
      expect(byKey(tasks, "clarify-requirements").result.handoffNote).toMatch(
        /Prepared, not done/u,
      );
      expect(byKey(tasks, "clarify-requirements").result.handoffNote).toMatch(
        /Nothing was bought, hired, booked or paid/u,
      );

      // source-offers depends on it, so it was reported as blocked and NOT touched.
      expect(actionsFor(run, "source-offers")).toEqual(["BLOCKED"]);
      expect(byKey(tasks, "source-offers").state).toBe("BLOCKED");

      // The worklist is the product: one line per thing a person must do.
      const work = Object.fromEntries(
        run.worklist.map((w: any) => [w.taskKey, w.needs]),
      );
      expect(work["clarify-requirements"]).toBe(
        "CONFIRM_THE_HANDOFF_WHEN_IT_IS_DONE",
      );

      // And nothing financial moved.
      expect(await money()).toEqual(before);
    });

    it("confirming a handoff lets the next run advance the layer behind it", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      await start(owner, id);
      await worker();

      const first = await tasksOf(owner, id);
      expect(byKey(first, "clarify-requirements").state).toBe("HANDED_OFF");
      expect(byKey(first, "source-offers").state).toBe("BLOCKED");

      // The person confirms the work was really done. Only then is the dependency satisfied.
      const confirm = await post(
        owner,
        `/v1/admin/org/tasks/${byKey(first, "clarify-requirements").taskId}/confirm-handoff`,
        {
          summary: "done by hand",
          // The task declares the evidence it needs; confirming without it is refused, which is the point of the field.
          evidence: [
            { kind: "requirements-document", ref: "ref://requirements" },
          ],
        },
      );
      expect(confirm.status, await confirm.clone().text()).toBe(200);

      const mid = await tasksOf(owner, id);
      expect(byKey(mid, "clarify-requirements").state).toBe("COMPLETED");
      // The graph moved on its own: the dependent is no longer blocked.
      expect(byKey(mid, "source-offers").state).toBe("READY");

      // A second run picks it up and hands it off in turn.
      const second = await body(await start(owner, id));
      await worker();
      const latest = await runById(owner, id, second.runId);
      expect(latest.state).toBe("WAITING_ON_PEOPLE");
      expect(actionsFor(latest, "source-offers")).toContain("HANDED_OFF");
      const after = await tasksOf(owner, id);
      expect(byKey(after, "source-offers").state).toBe("HANDED_OFF");
      // It is a prepared handoff because no provider is commissioned, and the note says exactly that.
      expect(byKey(after, "source-offers").result.handoffNote).toMatch(
        /NO_CONNECTOR_COMMISSIONED/u,
      );
    });

    it("the run reports a task awaiting approval and never approves it; a person still has to", async () => {
      const { owner, id } = await scene();
      expect(
        (
          await humanPlan(owner, id, [
            {
              key: "draft-brief",
              title: "Draft the brief",
              intendedOutcome: "A brief the owner can approve",
              taskType: "DRAFTING",
              requiredCapabilities: ["DRAFT"],
              assignedAgentId: "a",
              requiresOwnerApproval: true,
              explanation: "the owner wants to see it first",
            },
          ])
        ).status,
      ).toBe(201);

      let tasks = await tasksOf(owner, id);
      expect(byKey(tasks, "draft-brief").state).toBe("AWAITING_APPROVAL");

      const first = await body(await start(owner, id));
      await worker();
      const run = await runById(owner, id, first.runId);
      expect(actionsFor(run, "draft-brief")).toEqual(["WAITING_FOR_APPROVAL"]);
      expect(run.worklist[0]).toMatchObject({
        taskKey: "draft-brief",
        needs: "APPROVE_OR_REJECT_THIS_TASK",
      });

      // The executor did NOT approve it, and running the worker again does not change that.
      await worker();
      tasks = await tasksOf(owner, id);
      expect(byKey(tasks, "draft-brief").state).toBe("AWAITING_APPROVAL");
      expect(byKey(tasks, "draft-brief").approvedBy).toBe(null);

      // A person approves. Now, and only now, a run may move it.
      const ap = await post(
        owner,
        `/v1/admin/org/tasks/${byKey(tasks, "draft-brief").taskId}/approve`,
      );
      expect(ap.status, await ap.clone().text()).toBe(200);
      expect(
        (await tasksOf(owner, id)).find((t) => t.key === "draft-brief")!.state,
      ).toBe("READY");

      const after = await body(await start(owner, id));
      await worker();
      expect(
        actionsFor(await runById(owner, id, after.runId), "draft-brief"),
      ).toContain("HANDED_OFF");
    });

    it("a paused mission stops the executor: it refuses rather than acting, and says so", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      // Queue the run while the mission is still ACTIVE, then pause it before the worker gets there.
      expect((await start(owner, id)).status).toBe(201);
      expect((await post(owner, `${MISSIONS}/${id}/pause`)).status).toBe(200);

      await worker();
      const run = (await runsOf(owner, id))[0];
      // It reached the task, was refused by the authorized transition, recorded it, and advanced nothing.
      expect(actionsFor(run, "clarify-requirements")).toEqual(["REFUSED"]);
      expect(
        run.actions.find((a: any) => a.taskKey === "clarify-requirements")
          .detail,
      ).toMatch(/MISSION_NOT_ACTIVE/u);
      expect(run.worklist[0].needs).toBe(
        "GRANT_WHAT_IS_MISSING_OR_CHANGE_THE_PLAN",
      );
      const tasks = await tasksOf(owner, id);
      expect(byKey(tasks, "clarify-requirements").state).toBe("READY");
      expect(byKey(tasks, "clarify-requirements").result).toBe(null);
    });

    it("replacing the plan under a running run stops it instead of acting on a plan nobody started it for", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      expect((await start(owner, id)).status).toBe(201);
      // A second plan is activated before the worker runs. The run was started on version 1.
      expect(
        (
          await humanPlan(owner, id, [
            {
              key: "only-task",
              title: "Something else entirely",
              intendedOutcome: "A different plan",
              taskType: "DRAFTING",
              requiredCapabilities: ["DRAFT"],
              assignedAgentId: "a",
              explanation: "the owner changed their mind",
            },
          ])
        ).status,
      ).toBe(201);

      await worker();
      const run = (await runsOf(owner, id))[0];
      expect(run.state).toBe("FAILED");
      expect(run.note).toMatch(/the plan was replaced/u);
      expect(run.actions).toEqual([]);
      // The new plan's task was not touched by the old run.
      expect(byKey(await tasksOf(owner, id), "only-task").state).toBe("READY");
    });

    it("a second worker pass changes nothing, and only one run may be open per mission", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      expect((await start(owner, id)).status).toBe(201);
      // A second run while the first is unfinished is refused.
      const dup = await start(owner, id);
      expect(dup.status).toBe(409);
      expect((await body(dup)).reason).toBe("RUN_ALREADY_OPEN");

      await worker();
      const once = (await runsOf(owner, id))[0];
      await worker();
      await worker();
      // Byte-for-byte identical: the run is finished and nothing re-ran.
      expect((await runsOf(owner, id))[0]).toEqual(once);
    });

    it("cancelling before the worker runs advances nothing; a finished run cannot be cancelled", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      const r = await body(await start(owner, id));
      const cancelled = await body(
        await post(owner, `/v1/admin/org/plan-runs/${r.runId}/cancel`),
      );
      expect(cancelled.state).toBe("CANCELLED");

      await worker();
      const run = (await runsOf(owner, id))[0];
      expect(run.state).toBe("CANCELLED");
      expect(run.actions).toEqual([]);
      // Nothing in the plan moved.
      expect(
        byKey(await tasksOf(owner, id), "clarify-requirements").state,
      ).toBe("READY");
      expect(
        (await post(owner, `/v1/admin/org/plan-runs/${r.runId}/cancel`)).status,
      ).toBe(409);
    });

    it("another organization can neither see nor cancel this run", async () => {
      const { owner, id } = await scene();
      await templatePlan(owner, id);
      const r = await body(await start(owner, id));

      const stranger = await h.ownerOf("other-org");
      expect((await get(stranger, `${MISSIONS}/${id}/plan-runs`)).status).toBe(
        404,
      );
      expect(
        (await post(stranger, `/v1/admin/org/plan-runs/${r.runId}/cancel`))
          .status,
      ).toBe(404);
      // And the run is untouched.
      expect((await runsOf(owner, id))[0].state).toBe("QUEUED");
    });
  },
);
