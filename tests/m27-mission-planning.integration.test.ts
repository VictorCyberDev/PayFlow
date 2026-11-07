import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  PayFlowAgentMissionClient,
  PayFlowMemberClient,
} from "../packages/sdk-typescript/src/member.js";

/**
 * V3 M27 — the mission planning engine against the real host: PostgreSQL, real HTTP, real member roles and agent credentials.
 * The "model" in these tests is a fixture that returns JSON; it is labelled as such and proves only that model output goes
 * through the same strict validation and owner gate as everything else.
 */
const url = process.env.TEST_DATABASE_URL;
const MISSIONS = "/v1/admin/org/missions";

(url ? describe : describe.skip)(
  "M27 Mission planning (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_plans,mission_tasks,mission_task_deps,mission_task_events,operational_alerts",
    });
    let n = 0;
    const key = () => `m27-idem-key-${String(++n).padStart(10, "0")}`;
    const contract = (over: Record<string, unknown> = {}) => ({
      objective: "Find and buy equipment for the studio",
      intendedOutcome: "Equipment delivered within budget",
      successCriteria: ["Three comparable quotes", "Purchase under budget"],
      currency: "USD",
      totalBudgetMinor: 150_000,
      maxCommitmentMinor: 60_000,
      spendingCategories: ["EQUIPMENT"],
      approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      merchantRestrictions: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
      agents: [
        { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE", "DRAFT"] },
        { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
      ],
      approvalConditions: { humanApprovalAboveMinor: 30_000 },
      expiresAt: "2026-11-23T10:00:00.000Z",
      ...over,
    });
    type Task = {
      taskId: string;
      key: string;
      state: string;
      readiness: string;
      readinessReason: string | null;
      estimateSource: string;
      estimatedCostMinor: number | null;
      blockReason: string | null;
      planVersion: number;
      result: { reportedBy?: string } | null;
      assignedAgentId: string | null;
    };
    type Current = {
      plans: {
        planVersion: number;
        status: string;
        source: string;
        sourceLabel: string | null;
      }[];
      activePlanVersion: number | null;
      tasks: Task[];
      progress: Record<string, number>;
    };
    const act = (token: string, path: string, payload: unknown = {}) =>
      h.call(token, "POST", path, payload);

    const setup = async (c: unknown = contract()) => {
      await h.ownerOf();
      for (const id of ["a", "b", "c"]) await h.agentToken(id);
      const owner = await h.ownerOf();
      const r = await act(owner, MISSIONS, {
        contract: c,
        idempotencyKey: key(),
      });
      const id = ((await r.json()) as { mission: { missionId: string } })
        .mission.missionId;
      expect(
        (await act(owner, `${MISSIONS}/${id}/approve`, { version: 1 })).status,
      ).toBe(200);
      return {
        owner,
        id,
        a: await h.agentToken("a"),
        c: await h.agentToken("c"),
      };
    };
    const current = async (token: string, id: string) =>
      (await (
        await h.call(token, "GET", `${MISSIONS}/${id}/plans`)
      ).json()) as Current;
    const template = (token: string, id: string) =>
      act(token, `${MISSIONS}/${id}/plans`, {
        source: "TEMPLATE",
        idempotencyKey: key(),
      });
    const byKey = (cur: Current, k: string) =>
      cur.tasks.find((t) => t.key === k)!;
    const agentTasks = async (token: string) =>
      (
        (await (await h.call(token, "GET", "/v1/agent/tasks")).json()) as {
          tasks: Task[];
        }
      ).tasks;
    const claim = (token: string, taskId: string, runKey = key()) =>
      act(token, `/v1/agent/tasks/${taskId}/claim`, { runKey });
    const evidence = (...kinds: string[]) =>
      kinds.map((kind) => ({ kind, ref: `ref://${kind}` }));

    it("the template planner derives a dependency-aware plan from the contract alone: no invented prices, honest readiness", async () => {
      const { owner, id } = await setup();
      const r = await template(owner, id);
      expect(r.status).toBe(201);
      const cur = await current(owner, id);
      expect(cur.activePlanVersion).toBe(1);
      expect(cur.plans[0]).toMatchObject({
        status: "ACTIVE",
        source: "DETERMINISTIC_TEMPLATE",
      });
      expect(cur.tasks.map((t) => t.key).sort()).toEqual([
        "clarify-requirements",
        "compare-offers",
        "owner-decision",
        "source-offers",
      ]);
      expect(byKey(cur, "clarify-requirements")).toMatchObject({
        state: "READY",
        readiness: "EXECUTABLE",
        assignedAgentId: "a",
      });
      // Sourcing needs a connected provider; none is commissioned, so it is a prepared handoff, not "automated".
      expect(byKey(cur, "source-offers")).toMatchObject({
        state: "BLOCKED",
        readiness: "PREPARED_HANDOFF",
      });
      expect(byKey(cur, "source-offers").readinessReason).toMatch(
        /NO_CONNECTOR_COMMISSIONED/u,
      );
      expect(byKey(cur, "source-offers").blockReason).toMatch(
        /clarify-requirements/u,
      );
      // Pure comparison over held data is something a granted agent can do today.
      expect(byKey(cur, "compare-offers").readiness).toBe("EXECUTABLE");
      expect(byKey(cur, "owner-decision")).toMatchObject({ state: "BLOCKED" });
      for (const t of cur.tasks) {
        expect(t.estimatedCostMinor).toBeNull();
        expect(t.estimateSource).toBe("NONE");
      }
    });

    it("agents work the plan: only the assigned agent claims, once; evidence is required; handoffs need a person; owner gates hold", async () => {
      const { owner, id, a, c } = await setup();
      await template(owner, id);
      const tasks = await agentTasks(a);
      expect(tasks.map((t) => t.key).sort()).toEqual([
        "clarify-requirements",
        "compare-offers",
        "source-offers",
      ]);
      const clarify = (await current(owner, id)).tasks.find(
        (t) => t.key === "clarify-requirements",
      )!;
      // Only the assigned agent.
      expect((await claim(c, clarify.taskId)).status).toBe(403);
      // Blocked tasks cannot be claimed.
      const source = (await current(owner, id)).tasks.find(
        (t) => t.key === "source-offers",
      )!;
      expect((await claim(a, source.taskId)).status).toBe(409);
      const run = key();
      expect((await claim(a, clarify.taskId, run)).status).toBe(200);
      expect((await claim(a, clarify.taskId, run)).status).toBe(200); // same run key: replay
      expect((await claim(a, clarify.taskId, key())).status).toBe(409); // someone else's run
      // Completion needs the evidence the task asked for and the right run key.
      expect(
        (
          await act(a, `/v1/agent/tasks/${clarify.taskId}/complete`, {
            runKey: run,
            evidence: [],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await act(a, `/v1/agent/tasks/${clarify.taskId}/complete`, {
            runKey: key(),
            evidence: evidence("requirements-document"),
          })
        ).status,
      ).toBe(409);
      const done = await act(a, `/v1/agent/tasks/${clarify.taskId}/complete`, {
        runKey: run,
        summary: "done",
        evidence: evidence("requirements-document"),
      });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { task: Task }).task.result).toMatchObject(
        { reportedBy: "AGENT_REPORTED" },
      );
      expect(
        (
          await act(a, `/v1/agent/tasks/${clarify.taskId}/complete`, {
            runKey: run,
            evidence: evidence("requirements-document"),
          })
        ).status,
      ).toBe(200); // idempotent
      // Dependents unblock.
      let cur = await current(owner, id);
      expect(byKey(cur, "source-offers").state).toBe("READY");
      expect(byKey(cur, "compare-offers").state).toBe("BLOCKED");
      // A PREPARED_HANDOFF task: the agent prepares, hands off; a person confirms; nothing is claimed as automated.
      const run2 = key();
      expect((await claim(a, source.taskId, run2)).status).toBe(200);
      expect(
        (
          await act(a, `/v1/agent/tasks/${source.taskId}/handoff`, {
            runKey: run2,
            note: "Needs a person to query the marketplace",
          })
        ).status,
      ).toBe(200);
      expect(byKey(await current(owner, id), "source-offers").state).toBe(
        "HANDED_OFF",
      );
      expect(
        (
          await act(
            owner,
            `/v1/admin/org/tasks/${source.taskId}/confirm-handoff`,
            { summary: "Pulled 3 offers", evidence: [] },
          )
        ).status,
      ).toBe(422); // missing offer-provenance
      const confirmed = await act(
        owner,
        `/v1/admin/org/tasks/${source.taskId}/confirm-handoff`,
        { summary: "Pulled 3 offers", evidence: evidence("offer-provenance") },
      );
      expect(
        ((await confirmed.json()) as { task: Task }).task.result,
      ).toMatchObject({ reportedBy: "OWNER_REPORTED" });
      cur = await current(owner, id);
      expect(byKey(cur, "compare-offers").state).toBe("READY");
      const cmp = byKey(cur, "compare-offers");
      const run3 = key();
      await claim(a, cmp.taskId, run3);
      expect(
        (
          await act(a, `/v1/agent/tasks/${cmp.taskId}/complete`, {
            runKey: run3,
            evidence: evidence("comparison"),
          })
        ).status,
      ).toBe(200);
      // The owner-decision task waits for an owner, and an agent cannot approve it.
      cur = await current(owner, id);
      const decision = byKey(cur, "owner-decision");
      expect(decision.state).toBe("AWAITING_APPROVAL");
      expect((await claim(c, decision.taskId)).status).toBe(409);
      expect([401, 403]).toContain(
        (await act(c, `/v1/admin/org/tasks/${decision.taskId}/approve`, {}))
          .status,
      );
      const finance = await h.member("FINANCE_ADMIN");
      expect(
        (
          await act(
            finance,
            `/v1/admin/org/tasks/${decision.taskId}/approve`,
            {},
          )
        ).status,
      ).toBe(403);
      expect(
        (await act(owner, `/v1/admin/org/tasks/${decision.taskId}/approve`, {}))
          .status,
      ).toBe(200);
      expect(byKey(await current(owner, id), "owner-decision").state).toBe(
        "READY",
      );
      // The whole history is append-only and attributable.
      const hist = (await (
        await h.call(
          owner,
          "GET",
          `/v1/admin/org/tasks/${clarify.taskId}/history`,
        )
      ).json()) as { events: { event: string; actorKind: string }[] };
      expect(hist.events.map((e) => e.event)).toEqual(
        expect.arrayContaining(["RECOMPUTED", "CLAIMED", "COMPLETED"]),
      );
      await expect(
        h.repo
          .sql`delete from mission_task_events where task_id = ${clarify.taskId}`,
      ).rejects.toThrow(/append-only/u);
    });

    it("invalid plans are refused whole and store nothing: cycles, unknown or self dependencies, duplicate keys, ungranted work, unapproved providers, late deadlines", async () => {
      const { owner, id } = await setup();
      const t = (key_: string, over: Record<string, unknown> = {}) => ({
        key: key_,
        title: key_,
        intendedOutcome: "x",
        taskType: "DRAFTING",
        requiredCapabilities: ["DRAFT"],
        assignedAgentId: "a",
        explanation: "because",
        ...over,
      });
      const post = (tasks: unknown[]) =>
        act(owner, `${MISSIONS}/${id}/plans`, {
          source: "HUMAN",
          draft: { tasks },
          idempotencyKey: key(),
        });
      const problem = async (tasks: unknown[]) => {
        const r = await post(tasks);
        const j = (await r.json()) as {
          reason: string;
          problems?: { code: string }[];
        };
        return {
          status: r.status,
          codes: (j.problems ?? []).map((p) => p.code),
          reason: j.reason,
        };
      };
      expect(
        await problem([
          t("x", { dependsOn: [{ key: "y" }] }),
          t("y", { dependsOn: [{ key: "x" }] }),
        ]),
      ).toMatchObject({ status: 422, codes: ["CYCLE"] });
      expect(
        (await problem([t("x", { dependsOn: [{ key: "x" }] })])).codes,
      ).toContain("SELF_DEPENDENCY");
      expect(
        (await problem([t("x", { dependsOn: [{ key: "ghost" }] })])).codes,
      ).toContain("UNKNOWN_DEPENDENCY");
      expect((await problem([t("x"), t("x")])).codes).toContain(
        "DUPLICATE_KEY",
      );
      expect(
        (await problem([t("x", { assignedAgentId: "b" })])).codes,
      ).toContain("AGENT_NOT_ASSIGNED_TO_MISSION");
      expect(
        (
          await problem([
            t("x", {
              requiredCapabilities: ["PURCHASE"],
              assignedAgentId: "a",
            }),
          ])
        ).codes,
      ).toContain("CAPABILITY_NOT_GRANTED");
      expect(
        (await problem([t("x", { providerTypes: ["TALENT_MARKETPLACE"] })]))
          .codes,
      ).toContain("PROVIDER_TYPE_NOT_APPROVED");
      expect(
        (await problem([t("x", { deadline: "2027-01-01T00:00:00.000Z" })]))
          .codes,
      ).toContain("DEADLINE_AFTER_MISSION");
      // Shape problems are refused by the strict schema (not as plan problems).
      for (const bad of [
        [t("x", { estimateSource: "VERIFIED_QUOTE" })], // only the quote engine may ever write that
        [t("x", { smuggled: true })],
        [t("x", { requiredCapabilities: [] })],
        [t("x", { explanation: "" })],
        [t("bad key!")],
      ])
        expect((await post(bad)).status).toBe(400);
      const [{ n: plans }] = (await h.repo
        .sql`select count(*)::int n from mission_plans`) as unknown as [
        { n: number },
      ];
      expect(plans).toBe(0);
      // A plan with no tasks and one with 61 tasks are refused.
      expect((await post([])).status).toBe(400);
      expect(
        (await post(Array.from({ length: 61 }, (_, i) => t(`t${i}`)))).status,
      ).toBe(400);
    });

    it("a model's plan is labelled, inert until a member activates it, and goes through the same validation; estimates stay estimates", async () => {
      const { owner, id, a, c } = await setup();
      // A fixture standing in for a model's JSON answer. It over-estimates and tries to claim a verified quote.
      const modelDraft = {
        rationale: "FIXTURE MODEL OUTPUT",
        tasks: [
          {
            key: "m1",
            title: "Draft requirements",
            intendedOutcome: "doc",
            taskType: "DRAFTING",
            requiredCapabilities: ["DRAFT"],
            assignedAgentId: "a",
            estimatedCostMinor: 120_000,
            estimateSource: "AI_ESTIMATE",
            explanation: "model says so",
          },
          {
            key: "m2",
            title: "Compare",
            intendedOutcome: "table",
            taskType: "QUOTE_COMPARISON",
            requiredCapabilities: ["COMPARE"],
            assignedAgentId: "a",
            estimatedCostMinor: 60_000,
            estimateSource: "AI_ESTIMATE",
            dependsOn: [{ key: "m1" }],
            explanation: "after drafting",
          },
        ],
      };
      const bodyOf = (draft: unknown, source = "MODEL") => ({
        source,
        sourceLabel: "fixture-model",
        draft,
        idempotencyKey: key(),
      });
      // A member cannot submit a plan labelled MODEL, and an agent cannot submit one labelled HUMAN.
      expect(
        (await act(owner, `${MISSIONS}/${id}/plans`, bodyOf(modelDraft)))
          .status,
      ).toBe(400);
      expect(
        (
          await act(
            a,
            `/v1/agent/missions/${id}/plans`,
            bodyOf(modelDraft, "HUMAN"),
          )
        ).status,
      ).toBe(403);
      // An agent without DRAFT cannot propose at all.
      expect(
        (await act(c, `/v1/agent/missions/${id}/plans`, bodyOf(modelDraft)))
          .status,
      ).toBe(403);
      // An agent with DRAFT proposes; nothing runs.
      const proposed = await act(
        a,
        `/v1/agent/missions/${id}/plans`,
        bodyOf(modelDraft),
      );
      expect(proposed.status).toBe(202);
      const pj = (await proposed.json()) as {
        plan: {
          planVersion: number;
          status: string;
          overBudget: boolean;
          estimatedTotalMinor: number;
        };
      };
      expect(pj.plan).toMatchObject({
        status: "PROPOSED",
        overBudget: true,
        estimatedTotalMinor: 180_000,
      }); // flagged, not hidden
      expect(await agentTasks(a)).toEqual([]);
      expect((await current(owner, id)).activePlanVersion).toBeNull();
      // Agents cannot activate.
      expect([401, 403]).toContain(
        (await act(a, `${MISSIONS}/${id}/plans/1/activate`, {})).status,
      );
      const preview = (await (
        await h.call(owner, "GET", `${MISSIONS}/${id}/plans/1`)
      ).json()) as { tasks: Task[] };
      expect(preview.tasks.map((t) => t.estimateSource)).toEqual([
        "AI_ESTIMATE",
        "AI_ESTIMATE",
      ]);
      expect(
        (await act(owner, `${MISSIONS}/${id}/plans/1/activate`, {})).status,
      ).toBe(200);
      const cur = await current(owner, id);
      expect(cur.plans[0]).toMatchObject({
        status: "ACTIVE",
        source: "MODEL",
        sourceLabel: "fixture-model",
      });
      expect((await agentTasks(a)).map((t) => t.key).sort()).toEqual([
        "m1",
        "m2",
      ]);
      // Activating a proposal that is no longer valid is refused: the mission narrowed in the meantime.
      const second = await act(
        a,
        `/v1/agent/missions/${id}/plans`,
        bodyOf({
          tasks: [
            modelDraft.tasks[1]!,
            { ...modelDraft.tasks[0]!, key: "m1", dependsOn: [] },
          ],
        }),
      );
      expect(second.status).toBe(202);
      const narrower = contract({
        agents: [
          { agentId: "a", capabilities: ["SEARCH", "READ", "DRAFT"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
      });
      expect(
        (
          await act(owner, `${MISSIONS}/${id}/revisions`, {
            baseVersion: 1,
            contract: narrower,
            idempotencyKey: key(),
          })
        ).status,
      ).toBe(201);
      const refused = await act(
        owner,
        `${MISSIONS}/${id}/plans/2/activate`,
        {},
      );
      expect(refused.status).toBe(422);
      expect(
        (
          (await refused.json()) as { problems: { code: string }[] }
        ).problems.map((p) => p.code),
      ).toContain("CAPABILITY_NOT_GRANTED");
      expect(
        (await act(owner, `${MISSIONS}/${id}/plans/2/reject`, {})).status,
      ).toBe(200);
      expect(
        (await act(owner, `${MISSIONS}/${id}/plans/2/activate`, {})).status,
      ).toBe(409); // already decided
    });

    it("a new plan supersedes the old one: unfinished tasks are invalidated, finished work stays recorded under its own version", async () => {
      const { owner, id, a } = await setup();
      await template(owner, id);
      const clarify = byKey(await current(owner, id), "clarify-requirements");
      const run = key();
      await claim(a, clarify.taskId, run);
      await act(a, `/v1/agent/tasks/${clarify.taskId}/complete`, {
        runKey: run,
        evidence: evidence("requirements-document"),
      });
      const second = await template(owner, id);
      expect(second.status).toBe(201);
      const cur = await current(owner, id);
      expect(cur.activePlanVersion).toBe(2);
      expect(cur.plans.map((p) => p.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
      const old = await h.repo
        .sql`select task_key, state from mission_tasks where plan_version = 1 order by task_key`;
      expect(
        Object.fromEntries(
          old.map((r) => [String(r.task_key), String(r.state)]),
        ),
      ).toMatchObject({
        "clarify-requirements": "COMPLETED",
        "source-offers": "INVALIDATED",
        "compare-offers": "INVALIDATED",
        "owner-decision": "INVALIDATED",
      });
      // Agents see only the new plan, and its first task is fresh: no work is silently carried over.
      expect([
        ...new Set((await agentTasks(a)).map((t) => t.planVersion)),
      ]).toEqual([2]);
      // Replaying the same plan request is a replay, not a third plan.
      const idem = key();
      const body = { source: "TEMPLATE", idempotencyKey: idem };
      const x = await act(owner, `${MISSIONS}/${id}/plans`, body);
      const y = await act(owner, `${MISSIONS}/${id}/plans`, body);
      expect([x.status, y.status]).toEqual([201, 200]);
      expect(
        (
          await act(owner, `${MISSIONS}/${id}/plans`, {
            source: "TEMPLATE",
            idempotencyKey: idem,
            sourceLabel: "different",
          })
        ).status,
      ).toBe(409);
    });

    it("changed assumptions invalidate tasks: a revoked capability or removed agent breaks the task and its dependents on the next read", async () => {
      const { owner, id, a } = await setup();
      await template(owner, id);
      const finance = await h.member("FINANCE_ADMIN");
      // Narrow the mission: agent a loses COMPARE.
      const narrower = contract({
        agents: [
          { agentId: "a", capabilities: ["SEARCH", "READ", "DRAFT"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
      });
      expect(
        (
          await act(finance, `${MISSIONS}/${id}/revisions`, {
            baseVersion: 1,
            contract: narrower,
            idempotencyKey: key(),
          })
        ).status,
      ).toBe(201);
      const cur = await current(owner, id);
      expect(byKey(cur, "compare-offers").state).toBe("INVALIDATED");
      expect(byKey(cur, "owner-decision")).toMatchObject({ state: "BLOCKED" });
      expect(byKey(cur, "owner-decision").blockReason).toMatch(
        /DEPENDENCY_BROKEN.*compare-offers/u,
      );
      const hist = await h.repo
        .sql`select detail from mission_task_events where event = 'ASSUMPTION_CHANGED'`;
      expect(String(hist[0]!.detail)).toBe("CAPABILITY_REVOKED:a:COMPARE");
      // The invalidated task can no longer be claimed, even if it were otherwise ready.
      expect((await claim(a, byKey(cur, "compare-offers").taskId)).status).toBe(
        409,
      );
      // A person can skip a broken dependency's task deliberately; hard dependents stay blocked, conditional ones would not.
      expect(
        (
          await act(
            owner,
            `/v1/admin/org/tasks/${byKey(cur, "compare-offers").taskId}/skip`,
            {},
          )
        ).status,
      ).toBe(409); // already terminal
    });

    it("pausing or revoking the mission stops claims immediately; resuming restores them; nothing duplicates across a restart", async () => {
      const { owner, id, a } = await setup();
      await template(owner, id);
      const clarify = byKey(await current(owner, id), "clarify-requirements");
      const security = await h.member("SECURITY_ADMIN");
      expect((await act(security, `${MISSIONS}/${id}/pause`, {})).status).toBe(
        200,
      );
      expect((await claim(a, clarify.taskId)).status).toBe(409);
      expect(await agentTasks(a)).toEqual([]); // a paused mission's work is not offered
      expect((await act(owner, `${MISSIONS}/${id}/resume`, {})).status).toBe(
        200,
      );
      const run = key();
      expect((await claim(a, clarify.taskId, run)).status).toBe(200);
      // Restart mid-plan: the claim is durable and completing with the same run key finishes it exactly once.
      await h.restart();
      const a2 = await h.agentToken("a");
      expect(
        (await agentTasks(a2)).find((t) => t.key === "clarify-requirements")
          ?.state,
      ).toBe("IN_PROGRESS");
      expect((await claim(a2, clarify.taskId, key())).status).toBe(409);
      expect(
        (
          await act(a2, `/v1/agent/tasks/${clarify.taskId}/complete`, {
            runKey: run,
            evidence: evidence("requirements-document"),
          })
        ).status,
      ).toBe(200);
      const [{ n: completions }] = (await h.repo
        .sql`select count(*)::int n from mission_task_events where task_id = ${clarify.taskId} and event = 'COMPLETED'`) as unknown as [
        { n: number },
      ];
      expect(completions).toBe(1);
      expect(
        (await act(await h.ownerOf(), `${MISSIONS}/${id}/revoke`, {})).status,
      ).toBe(200);
      expect(
        (
          await claim(
            a2,
            byKey(await current(await h.ownerOf(), id), "source-offers").taskId,
          )
        ).status,
      ).toBe(409);
    });

    it("concurrent claims of one task by competing runs: exactly one wins", async () => {
      const { owner, id, a } = await setup();
      await template(owner, id);
      const clarify = byKey(await current(owner, id), "clarify-requirements");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => claim(a, clarify.taskId, key())),
      );
      expect(
        results.map((r) => r.status).filter((s) => s === 200),
      ).toHaveLength(1);
      expect(
        results.map((r) => r.status).filter((s) => s === 409),
      ).toHaveLength(7);
      const [{ n: claims }] = (await h.repo
        .sql`select count(*)::int n from mission_task_events where task_id = ${clarify.taskId} and event = 'CLAIMED'`) as unknown as [
        { n: number },
      ];
      expect(claims).toBe(1);
    });

    it("is tenant isolated and role-checked on the server", async () => {
      const { owner, id } = await setup();
      await template(owner, id);
      const task = byKey(await current(owner, id), "clarify-requirements");
      const theirs = await h.ownerOf("org-other");
      expect(
        (await h.call(theirs, "GET", `${MISSIONS}/${id}/plans`)).status,
      ).toBe(404);
      expect((await template(theirs, id)).status).toBe(404);
      expect(
        (await act(theirs, `/v1/admin/org/tasks/${task.taskId}/skip`, {}))
          .status,
      ).toBe(404);
      expect(
        (
          await h.call(
            theirs,
            "GET",
            `/v1/admin/org/tasks/${task.taskId}/history`,
          )
        ).status,
      ).toBe(404);
      // Roles: reading is broad, planning is not.
      for (const role of [
        "AUDITOR",
        "VIEWER",
        "DEVELOPER",
        "SECURITY_ADMIN",
        "APPROVER",
      ]) {
        const t = await h.member(role);
        expect(
          (await h.call(t, "GET", `${MISSIONS}/${id}/plans`)).status,
          `${role} view`,
        ).toBe(200);
        expect((await template(t, id)).status, `${role} plan`).toBe(403);
        expect(
          (await act(t, `/v1/admin/org/tasks/${task.taskId}/skip`, {})).status,
          `${role} skip`,
        ).toBe(403);
      }
      expect((await template(await h.member("FINANCE_ADMIN"), id)).status).toBe(
        201,
      );
      expect(
        (await h.call(null, "GET", `${MISSIONS}/${id}/plans`)).status,
      ).toBe(401);
      // An agent credential cannot use member routes, and an unassigned agent sees nothing.
      expect([401, 403]).toContain(
        (await template(await h.agentToken("a"), id)).status,
      );
      expect(await agentTasks(await h.agentToken("b"))).toEqual([]);
    });

    it("the SDK clients run the real workflow: plan, claim, complete with evidence, hand off, confirm", async () => {
      const { owner, id } = await setup();
      const member = new PayFlowMemberClient({
        baseUrl: h.origin,
        memberToken: owner,
      });
      const agent = new PayFlowAgentMissionClient({
        baseUrl: h.origin,
        agentToken: await h.agentToken("a"),
      });
      const plan = await member.plans.create(id, {
        source: "TEMPLATE",
        idempotencyKey: key(),
      });
      expect(plan).toMatchObject({
        ok: true,
        plan: { planVersion: 1, status: "ACTIVE" },
      });
      const first = (await agent.tasks()).find((t) => t.state === "READY")!;
      expect(first.key).toBe("clarify-requirements");
      const run = key();
      expect((await agent.claim(first.taskId, run)).ok).toBe(true);
      expect(
        await agent.complete(first.taskId, { runKey: run, evidence: [] }),
      ).toMatchObject({
        ok: false,
        httpStatus: 422,
        reason: "MISSING_EVIDENCE",
      });
      expect(
        (
          await agent.complete(first.taskId, {
            runKey: run,
            evidence: evidence("requirements-document"),
          })
        ).ok,
      ).toBe(true);
      const source = (await agent.tasks()).find(
        (t) => t.key === "source-offers",
      )!;
      expect(source.state).toBe("READY");
      const run2 = key();
      await agent.claim(source.taskId, run2);
      expect(
        (
          await agent.handoff(source.taskId, {
            runKey: run2,
            note: "needs a person",
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await member.tasks.confirmHandoff(source.taskId, {
            evidence: evidence("offer-provenance"),
          })
        ).ok,
      ).toBe(true);
      const cur = await member.plans.current(id);
      expect(cur.progress).toMatchObject({ COMPLETED: 2 });
      expect((await member.tasks.skip("tsk_" + "0".repeat(24))).ok).toBe(false);
    });
  },
);
