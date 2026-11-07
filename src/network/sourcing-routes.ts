import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  SRefusal,
  SResult,
  SourcingService,
} from "../missions/sourcing-service.js";

/** HTTP surface of sourcing optimization. Tenant and identity come from the authenticated caller, never the path or body. */
export interface SourcingRouteDeps {
  readonly service: SourcingService;
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
const STATUS: Record<SRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  TOO_MANY_ELIGIBLE_QUOTES: 422,
  RUN_NOT_ADOPTABLE: 409,
  ADOPTION_INCOMPLETE: 409,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const RID = "src_[a-f0-9]{24}";

export function createSourcingRoutes(deps: SourcingRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<SResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "TOO_MANY_ELIGIBLE_QUOTES",
        "ADOPTION_INCOMPLETE",
      ].includes(r.refusal),
      humanSummary:
        "Nothing was committed. A sourcing run only recommends, and only from quotes that are current, complete, in the mission currency and from a qualified supplier.",
      nextAction: "CHECK_THE_REQUEST",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const runs = new RegExp(
      `^/v1/admin/org/missions/(${MID})/sourcing/runs$`,
      "u",
    ).exec(request.path);
    const one = new RegExp(`^/v1/admin/org/sourcing/runs/(${RID})$`, "u").exec(
      request.path,
    );
    const adopt = new RegExp(
      `^/v1/admin/org/sourcing/runs/(${RID})/adopt$`,
      "u",
    ).exec(request.path);
    if (!runs && !one && !adopt) return null;
    const get = request.method === "GET";
    if ((one && !get) || (adopt && get)) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = adopt
      ? "mission:ledger"
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
    if (runs && get) {
      const r = await service.list(caller, runs[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (runs) {
      const r = await service.run(caller, runs[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (one) {
      const run = await service.get(caller, one[1]!);
      return run
        ? reply(requestId, 200, { run })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    const r = await service.adopt(caller, adopt![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const runs = new RegExp(
      `^/v1/agent/missions/(${MID})/sourcing/runs$`,
      "u",
    ).exec(request.path);
    if (!runs) return null;
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
      const r = await service.list(caller, runs[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.run(caller, runs[1]!, request.body);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  return { member, agent };
}
