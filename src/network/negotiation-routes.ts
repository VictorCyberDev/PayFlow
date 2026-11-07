import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type { CounterofferService } from "../missions/counteroffer-service.js";
import type {
  NResult,
  NegRefusal,
  NegotiationService,
} from "../missions/negotiation-service.js";

/** HTTP surface of negotiation rulebooks. Tenant and identity come from the authenticated caller, never the path or body. */
export interface NegotiationRouteDeps {
  readonly service: NegotiationService;
  readonly counteroffers: CounterofferService;
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
const STATUS: Record<NegRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  DOCUMENT_INVALID: 422,
  NEGOTIATION_REVOKED: 409,
  NOT_PENDING: 409,
  NOT_THE_NEGOTIATOR: 403,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const NID = "ngt_[a-f0-9]{24}";

export function createNegotiationRoutes(deps: NegotiationRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<NResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "DOCUMENT_INVALID"].includes(r.refusal),
      humanSummary:
        "Nothing was sent or accepted. Negotiation rules only take effect once a person approves them, and they are checked again at that moment.",
      nextAction: "CHECK_THE_RULES_AND_ASK_A_PERSON",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/negotiations$`,
      "u",
    ).exec(request.path);
    const decide = new RegExp(
      `^/v1/admin/org/negotiations/(${NID})/versions/(\\d{1,6})/(approve|reject)$`,
      "u",
    ).exec(request.path);
    const revoke = new RegExp(
      `^/v1/admin/org/negotiations/(${NID})/revoke$`,
      "u",
    ).exec(request.path);
    const check = new RegExp(
      `^/v1/admin/org/negotiations/(${NID})/check$`,
      "u",
    ).exec(request.path);
    const timeline = new RegExp(
      `^/v1/admin/org/negotiations/(${NID})/timeline$`,
      "u",
    ).exec(request.path);
    if (timeline && request.method === "GET") {
      const requestId = `req_${randomUUID()}`;
      const gate = await deps.authorize(requestId, request, "view:missions");
      if (!("member" in gate)) return gate;
      const r = await deps.counteroffers.timeline(
        {
          organizationId: gate.member.organizationId,
          environment: gate.member.environment,
          id: gate.member.memberId,
          kind: "MEMBER",
        },
        timeline[1]!,
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (!list && !decide && !revoke && !check) return null;
    const get = request.method === "GET";
    if (
      (list && !get && request.method !== "POST") ||
      ((decide || revoke || check) && request.method !== "POST")
    )
      return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = decide
      ? "mission:approve"
      : revoke
        ? "mission:contain"
        : check
          ? "view:missions"
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
    if (decide) {
      const r = await service.decide(
        caller,
        decide[1]!,
        Number(decide[2]),
        decide[3] === "approve" ? "APPROVED" : "REJECTED",
        request.body,
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (revoke) {
      const r = await service.revoke(caller, revoke[1]!, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.check(caller, check![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/negotiations$`,
      "u",
    ).exec(request.path);
    const check = new RegExp(
      `^/v1/agent/negotiations/(${NID})/check$`,
      "u",
    ).exec(request.path);
    const timeline = new RegExp(
      `^/v1/agent/negotiations/(${NID})/timeline$`,
      "u",
    ).exec(request.path);
    if (timeline && request.method === "GET") {
      const requestId = `req_${randomUUID()}`;
      const caller = await deps.agent(request);
      if (!caller)
        return reply(requestId, 401, {
          reason: "AGENT_AUTH_REQUIRED",
          recoverable: false,
          humanSummary: "A valid agent credential is required.",
          nextAction: "PRESENT_AGENT_CREDENTIAL",
        });
      const r = await deps.counteroffers.timeline(caller, timeline[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (!list && !check) return null;
    const get = request.method === "GET";
    if (check && get) return null;
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
    const r = await service.check(caller, check![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
