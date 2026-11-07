import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  PlanRefusal,
  PlanService,
  PResult,
} from "../missions/plan-service.js";

/** HTTP surface of mission plans and tasks. Tenant and identity come from the authenticated caller, never the path or body. */
export interface PlanRouteDeps {
  readonly service: PlanService;
  readonly reply: (
    requestId: string,
    status: number,
    body: object,
  ) => RestResponse;
  readonly authorize: (
    requestId: string,
    request: RestRequest,
    permission: Permission,
  ) => Promise<{ member: Member } | RestResponse>;
  readonly agent: (request: RestRequest) => Promise<MissionCaller | null>;
  readonly paused: (caller: MissionCaller) => Promise<boolean>;
}

const STATUS: Record<PlanRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  MISSION_TERMINAL: 409,
  MISSION_NOT_ACTIVE: 409,
  PLAN_INVALID: 422,
  STALE_MISSION_VERSION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_PROPOSED: 409,
  WRONG_STATE: 409,
  NOT_ASSIGNED: 403,
  CAPABILITY_REFUSED: 403,
  RUN_KEY_MISMATCH: 409,
  MISSING_EVIDENCE: 422,
  NOT_A_HANDOFF: 409,
  AGENT_CANNOT_PROPOSE: 403,
};
const MID = "msn_[a-f0-9]{24}";
const TID = "tsk_[a-f0-9]{24}";
const MEMBER_TASK_PERMISSION: Record<string, Permission> = {
  approve: "mission:approve",
  "confirm-handoff": "mission:control",
  skip: "mission:control",
  invalidate: "mission:control",
  retry: "mission:control",
};

export function createPlanRoutes(deps: PlanRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<PResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.problems ? { problems: r.problems } : {}),
      recoverable: ["MALFORMED", "PLAN_INVALID", "MISSING_EVIDENCE"].includes(
        r.refusal,
      ),
      humanSummary:
        "Nothing changed. Plans and tasks only change through an authorized, current, well-formed request.",
      nextAction: "RELOAD_THE_PLAN_AND_RETRY",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const plans = new RegExp(
      `^/v1/admin/org/missions/(${MID})/plans(?:/(\\d{1,6})(?:/(activate|reject))?)?$`,
      "u",
    ).exec(request.path);
    const task = new RegExp(
      `^/v1/admin/org/tasks/(${TID})/(history|approve|confirm-handoff|skip|invalidate|retry)$`,
      "u",
    ).exec(request.path);
    if (!plans && !task) return null;
    const requestId = `req_${randomUUID()}`;
    const read = request.method === "GET";
    const permission: Permission = read
      ? "view:missions"
      : plans
        ? "mission:plan"
        : (MEMBER_TASK_PERMISSION[task![2]!] ?? "mission:control");
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (plans) {
      const [, id, version, op] = plans;
      if (!version && request.method === "POST") {
        const r = await service.propose(caller, id!, request.body);
        return r.ok
          ? reply(requestId, r.value.replayed ? 200 : 201, { plan: r.value })
          : refuse(requestId, r);
      }
      if (!version && read) {
        const r = await service.current(caller, id!);
        return r.ok
          ? reply(requestId, 200, r.value)
          : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
      }
      if (version && !op && read) {
        const tasks = await service.proposedPlanTasks(
          caller,
          id!,
          Number(version),
        );
        return tasks && tasks.length
          ? reply(requestId, 200, { planVersion: Number(version), tasks })
          : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
      }
      if (version && op && request.method === "POST") {
        const r = await service.activate(
          caller,
          id!,
          Number(version),
          op === "activate" ? "ACTIVATE" : "REJECT",
        );
        return r.ok
          ? reply(requestId, 200, { plan: r.value })
          : refuse(requestId, r);
      }
      return null;
    }
    const [, taskId, op] = task!;
    if (read && op === "history") {
      const h = await service.history(caller, taskId!);
      return h
        ? reply(requestId, 200, { events: h })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    if (!read && op !== "history") {
      const r = await service.memberAction(
        caller,
        taskId!,
        op as "approve",
        request.body,
      );
      return r.ok
        ? reply(requestId, 200, { task: r.value })
        : refuse(requestId, r);
    }
    return null;
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const propose = new RegExp(`^/v1/agent/missions/(${MID})/plans$`, "u").exec(
      request.path,
    );
    const list = request.path === "/v1/agent/tasks";
    const op = new RegExp(
      `^/v1/agent/tasks/(${TID})/(claim|complete|fail|handoff)$`,
      "u",
    ).exec(request.path);
    if (!propose && !list && !op) return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (list && request.method === "GET")
      return reply(requestId, 200, { tasks: await service.forAgent(caller) });
    if ((propose || op) && request.method === "POST") {
      if (await deps.paused(caller))
        return reply(requestId, 423, {
          reason: "ORGANIZATION_PAUSED",
          recoverable: true,
          humanSummary: "The organization is paused.",
          nextAction: "WAIT_FOR_RESUME",
        });
      if (propose) {
        const r = await service.propose(caller, propose[1]!, request.body);
        return r.ok
          ? reply(requestId, r.value.replayed ? 200 : 202, { plan: r.value })
          : refuse(requestId, r);
      }
      const [, taskId, verb] = op!;
      const r =
        verb === "claim"
          ? await service.claim(caller, taskId!, request.body)
          : verb === "complete"
            ? await service.complete(caller, taskId!, request.body)
            : verb === "fail"
              ? await service.fail(caller, taskId!, request.body)
              : await service.handoff(caller, taskId!, request.body);
      return r.ok
        ? reply(requestId, 200, { task: r.value })
        : refuse(requestId, r);
    }
    return null;
  }
  return { member, agent };
}
