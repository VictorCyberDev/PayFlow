import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  PfRefusal,
  PortfolioService,
} from "../missions/portfolio-service.js";

/** HTTP surface of the multi-vendor portfolio. Read-only. Tenant and identity come from the authenticated caller. */
export interface PortfolioRouteDeps {
  readonly service: PortfolioService;
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
const STATUS: Record<PfRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
};
const MID = "msn_[a-f0-9]{24}";

/** `?maxShareBps=N` (1..10000). Anything else in the query is ignored; a bad value is refused, not guessed. */
function share(query: string | undefined): number | undefined | "BAD" {
  if (!query) return undefined;
  const v = new URLSearchParams(query).get("maxShareBps");
  if (v === null) return undefined;
  return /^\d{1,5}$/u.test(v) ? Number(v) : "BAD";
}

export function createPortfolioRoutes(deps: PortfolioRouteDeps) {
  const { service, reply } = deps;
  async function run(
    requestId: string,
    caller: MissionCaller,
    missionId: string,
    query: string | undefined,
  ) {
    const s = share(query);
    const r = await service.get(caller, missionId, s === "BAD" ? -1 : s);
    return r.ok
      ? reply(requestId, 200, r.value)
      : reply(requestId, STATUS[r.refusal], {
          reason: r.refusal,
          ...(r.detail ? { detail: r.detail } : {}),
          recoverable: r.refusal === "MALFORMED",
          humanSummary: "Nothing was changed. The portfolio is read-only.",
          nextAction: "CHECK_THE_REQUEST",
        });
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = new RegExp(
      `^/v1/admin/org/missions/(${MID})/portfolio$`,
      "u",
    ).exec(request.path);
    if (!m || request.method !== "GET") return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(requestId, request, "view:missions");
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
      request.query,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = new RegExp(`^/v1/agent/missions/(${MID})/portfolio$`, "u").exec(
      request.path,
    );
    if (!m || request.method !== "GET") return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    return run(requestId, caller, m[1]!, request.query);
  }
  return { member, agent };
}
