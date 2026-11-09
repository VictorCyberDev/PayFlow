import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  ServiceMarketService,
  SmRefusal,
} from "../missions/service-market-service.js";

/** HTTP surface of service-package search. Tenant and identity come from the caller. A search only observes. */
export interface ServiceMarketRouteDeps {
  readonly service: ServiceMarketService;
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
const STATUS: Record<SmRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  MISSION_NOT_ACTIVE: 409,
  PROVIDER_TYPE_NOT_APPROVED: 403,
  CURRENCY_MISMATCH: 422,
  PRICE_ABOVE_COMMITMENT: 422,
  UNKNOWN_SOURCE: 404,
  SOURCE_NOT_ALLOWED_HERE: 403,
  SOURCE_FAILED: 502,
};
const MID = "msn_[a-f0-9]{24}";

export function createServiceMarketRoutes(deps: ServiceMarketRouteDeps) {
  const { service, reply } = deps;
  const match = (prefix: string, r: RestRequest) => {
    const m = new RegExp(
      `^${prefix}/missions/(${MID})/services/search$`,
      "u",
    ).exec(r.path);
    return m && r.method === "POST" ? m : null;
  };
  async function run(
    requestId: string,
    caller: MissionCaller,
    missionId: string,
    request: RestRequest,
  ) {
    const r = await service.search(caller, missionId, request.body);
    return r.ok
      ? reply(requestId, 200, r.value)
      : reply(requestId, STATUS[r.refusal], {
          reason: r.refusal,
          ...(r.detail ? { detail: r.detail } : {}),
          recoverable: ["MALFORMED", "SOURCE_FAILED"].includes(r.refusal),
          humanSummary:
            "Nothing was bought, paid or signed, and no one was contacted. A search only observes what a source returns.",
          nextAction: "CHECK_THE_MISSION_AND_SOURCE",
        });
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(requestId, request, "mission:plan");
    if (!("member" in gate)) return gate;
    return run(
      requestId,
      {
        organizationId: gate.member.organizationId,
        environment: gate.member.environment,
        id: gate.member.memberId,
        kind: "MEMBER",
      },
      m[1]!,
      request,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/agent", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (await deps.paused(caller))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    return run(requestId, caller, m[1]!, request);
  }
  return { member, agent };
}
