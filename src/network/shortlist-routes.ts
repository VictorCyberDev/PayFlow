import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  SResult,
  ShRefusal,
  ShortlistService,
} from "../missions/shortlist-service.js";

/** HTTP surface of talent ranking and shortlists. Tenant and identity come from the authenticated caller, never the path or body. */
export interface ShortlistRouteDeps {
  readonly service: ShortlistService;
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
}
const STATUS: Record<ShRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NO_SCOPE_IN_FORCE: 409,
  NO_SUCH_ROLE: 422,
  SHORTLIST_INVALID: 422,
  ALREADY_ACTIVE: 409,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const SID = "tsl_[a-f0-9]{24}";
const ROLE = "[A-Za-z0-9][A-Za-z0-9._-]{0,39}";

export function createShortlistRoutes(deps: ShortlistRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<SResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "SHORTLIST_INVALID"].includes(r.refusal),
      humanSummary:
        "Nothing was shortlisted or contacted. Only a person adopts a shortlist, and only from candidates the scope's checks do not rule out.",
      nextAction: "CHECK_THE_RANKING_AND_ASK_A_PERSON",
    });
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const rank = new RegExp(
      `^/v1/admin/org/missions/(${MID})/talent-roles/(${ROLE})/ranking$`,
      "u",
    ).exec(request.path);
    const col = new RegExp(
      `^/v1/admin/org/missions/(${MID})/talent-shortlists$`,
      "u",
    ).exec(request.path);
    const wd = new RegExp(
      `^/v1/admin/org/talent-shortlists/(${SID})/withdraw$`,
      "u",
    ).exec(request.path);
    if (!rank && !col && !wd) return null;
    const get = request.method === "GET";
    if (
      rank
        ? !get
        : wd
          ? request.method !== "POST"
          : !get && request.method !== "POST"
    )
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      get ? "view:missions" : "mission:approve",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (rank) {
      const r = await service.ranking(caller, rank[1]!, rank[2]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (wd) {
      const r = await service.withdraw(caller, wd[1]!, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (get) {
      const r = await service.list(caller, col![1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.adopt(caller, col![1]!, request.body);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const rank = new RegExp(
      `^/v1/agent/missions/(${MID})/talent-roles/(${ROLE})/ranking$`,
      "u",
    ).exec(request.path);
    const col = new RegExp(
      `^/v1/agent/missions/(${MID})/talent-shortlists$`,
      "u",
    ).exec(request.path);
    if ((!rank && !col) || request.method !== "GET") return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    const r = rank
      ? await service.ranking(caller, rank[1]!, rank[2]!)
      : await service.list(caller, col![1]!);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
