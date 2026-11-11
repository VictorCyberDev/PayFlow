import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type {
  RcRefusal,
  RecurringService,
} from "../missions/recurring-service.js";

/** Members set up, list and stop recurring renewal checks. A check only observes and asks; it never buys. */
export interface RecurringRouteDeps {
  readonly service: RecurringService;
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
const STATUS: Record<RcRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  MISSION_NOT_ACTIVE: 409,
  NOT_DUE: 409,
  ALREADY_DECIDED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const SID = "sch_[a-f0-9]{24}";
const CID = "rck_[a-f0-9]{24}";

export function createRecurringRoutes(deps: RecurringRouteDeps) {
  const { service, reply } = deps;
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const col = new RegExp(
      `^/v1/admin/org/missions/(${MID})/recurring$`,
      "u",
    ).exec(request.path);
    const stop = new RegExp(
      `^/v1/admin/org/missions/(${MID})/recurring/(${SID})/stop$`,
      "u",
    ).exec(request.path);
    const resume = new RegExp(
      `^/v1/admin/org/missions/(${MID})/recurring/(${SID})/resume$`,
      "u",
    ).exec(request.path);
    // The owner's answer to a recurrence that came due. Approving records intent; it buys nothing.
    const decide = new RegExp(
      `^/v1/admin/org/recurring-checks/(${CID})/(approve|decline)$`,
      "u",
    ).exec(request.path);
    if (!col && !stop && !resume && !decide) return null;
    const get = request.method === "GET";
    const posting = stop || resume || decide;
    if (posting ? request.method !== "POST" : !get && request.method !== "POST")
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      get
        ? "view:missions"
        : decide
          ? "mission:approve"
          : stop || resume
            ? "mission:control"
            : "mission:plan",
    );
    if (!("member" in gate)) return gate;
    const caller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER" as const,
    };
    const refuse = (r: { refusal: RcRefusal }) =>
      reply(requestId, STATUS[r.refusal], {
        reason: r.refusal,
        recoverable: r.refusal === "MALFORMED",
        humanSummary:
          "Nothing was bought, renewed or paid. A recurring item is only checked, and only for an active mission. " +
          "A due item takes one answer, and saying yes records what you want rather than buying it.",
        nextAction: "CHECK_THE_MISSION_AND_REQUEST",
      });
    if (get) {
      const r = await service.list(caller, col![1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    if (stop) {
      const r = await service.stop(caller, stop[1]!, stop[2]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    if (resume) {
      const r = await service.resume(caller, resume[1]!, resume[2]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    if (decide) {
      const r = await service.decide(
        caller,
        decide[1]!,
        decide[2] === "approve" ? "APPROVED" : "DECLINED",
        request.body,
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(r);
    }
    const r = await service.create(caller, col![1]!, request.body);
    return r.ok ? reply(requestId, 201, r.value) : refuse(r);
  }
  return { member };
}
