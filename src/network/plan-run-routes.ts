import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type {
  PlanRunService,
  PrRefusal,
} from "../missions/plan-run-service.js";

/**
 * V3 M55 — members start, list and cancel plan runs. A run drives the plan's dependency graph and writes down who has to
 * act; it never approves anything and never buys, hires, books, pays or contacts anyone.
 */
export interface PlanRunRouteDeps {
  readonly service: PlanRunService;
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
}
const STATUS: Record<PrRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  MISSION_NOT_ACTIVE: 409,
  NO_ACTIVE_PLAN: 409,
  RUN_ALREADY_OPEN: 409,
  ALREADY_FINISHED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const RID = "prn_[a-f0-9]{24}";

export function createPlanRunRoutes(deps: PlanRunRouteDeps) {
  const { service, reply } = deps;
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const col = new RegExp(
      `^/v1/admin/org/missions/(${MID})/plan-runs$`,
      "u",
    ).exec(request.path);
    const cancel = new RegExp(
      `^/v1/admin/org/plan-runs/(${RID})/cancel$`,
      "u",
    ).exec(request.path);
    if (!col && !cancel) return null;
    const get = request.method === "GET";
    if (cancel ? request.method !== "POST" : !get && request.method !== "POST")
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      get ? "view:missions" : cancel ? "mission:control" : "mission:plan",
    );
    if (!("member" in gate)) return gate;
    const caller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER" as const,
    };
    const refuse = (r: { refusal: PrRefusal }) =>
      reply(requestId, STATUS[r.refusal], {
        reason: r.refusal,
        recoverable: r.refusal === "MALFORMED",
        humanSummary:
          "Nothing was approved, bought, hired, booked or paid. A plan run needs an active mission with an active plan, " +
          "and only one run may be open at a time.",
        nextAction: "CHECK_THE_MISSION_AND_ITS_PLAN",
      });
    if (get) {
      const r = await service.list(caller, col![1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    if (cancel) {
      const r = await service.cancel(caller, cancel[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    const r = await service.create(caller, col![1]!, request.body);
    return r.ok ? reply(requestId, 201, r.value) : refuse(r);
  }
  return { member };
}
