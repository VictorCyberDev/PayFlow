import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type {
  LaunchRunService,
  LrRefusal,
} from "../missions/launch-run-service.js";

/** Members start, list and cancel launch runs. A run only looks; it never books, buys, hires or pays. */
export interface LaunchRunRouteDeps {
  readonly service: LaunchRunService;
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
const STATUS: Record<LrRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  MISSION_NOT_ACTIVE: 409,
  RUN_ALREADY_OPEN: 409,
  ALREADY_FINISHED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const RID = "lrn_[a-f0-9]{24}";

export function createLaunchRunRoutes(deps: LaunchRunRouteDeps) {
  const { service, reply } = deps;
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const col = new RegExp(
      `^/v1/admin/org/missions/(${MID})/launch-runs$`,
      "u",
    ).exec(request.path);
    const cancel = new RegExp(
      `^/v1/admin/org/launch-runs/(${RID})/cancel$`,
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
    const refuse = (r: { refusal: LrRefusal }) =>
      reply(requestId, STATUS[r.refusal], {
        reason: r.refusal,
        recoverable: r.refusal === "MALFORMED",
        humanSummary:
          "Nothing was booked, bought, hired or paid. A launch run only looks, and only for an active mission with no other run open.",
        nextAction: "CHECK_THE_MISSION_AND_REQUEST",
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
