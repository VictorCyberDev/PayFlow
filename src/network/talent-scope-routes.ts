import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  TResult,
  TsRefusal,
  TalentScopeService,
} from "../missions/talent-scope-service.js";

/** HTTP surface of talent scopes. Tenant and identity come from the authenticated caller, never the path or body. */
export interface TalentScopeRouteDeps {
  readonly service: TalentScopeService;
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
const STATUS: Record<TsRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  SCOPE_INVALID: 422,
  NOT_PENDING: 409,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const SID = "tsc_[a-f0-9]{24}";

export function createTalentScopeRoutes(deps: TalentScopeRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<TResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "SCOPE_INVALID"].includes(r.refusal),
      humanSummary:
        "Nothing was changed. A talent scope takes effect only when the owner approves it, and it may not screen on protected attributes.",
      nextAction: "CHECK_THE_SCOPE_AND_ASK_A_PERSON",
    });
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/talent-scopes$`,
      "u",
    ).exec(request.path);
    const act = new RegExp(
      `^/v1/admin/org/talent-scopes/(${SID})/(approve|reject|revoke)$`,
      "u",
    ).exec(request.path);
    if (!list && !act) return null;
    const get = request.method === "GET";
    if (list ? !get && request.method !== "POST" : request.method !== "POST")
      return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = act
      ? act[2] === "revoke"
        ? "mission:contain"
        : "mission:approve"
      : get
        ? "view:missions"
        : "mission:plan";
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (list && get) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (list) {
      const r = await service.propose(caller, list[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r =
      act![2] === "revoke"
        ? await service.revoke(caller, act![1]!, request.body)
        : await service.decide(
            caller,
            act![1]!,
            act![2] === "approve" ? "APPROVED" : "REJECTED",
            request.body,
          );
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/talent-scopes$`,
      "u",
    ).exec(request.path);
    if (!list) return null;
    const get = request.method === "GET";
    if (!get && request.method !== "POST") return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (!get && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    if (get) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.propose(caller, list[1]!, request.body);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  return { member, agent };
}
