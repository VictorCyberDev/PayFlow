import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  WsRefusal,
  WsResult,
  WorkspaceService,
} from "../missions/workspace-service.js";

/** HTTP surface of workspace sources and searches. Tenant and identity come from the authenticated caller, never the path or body. */
export interface WorkspaceRouteDeps {
  readonly service: WorkspaceService;
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
const STATUS: Record<WsRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  MISSION_NOT_ACTIVE: 409,
  PROVIDER_TYPE_NOT_APPROVED: 403,
  CURRENCY_MISMATCH: 422,
  EXPOSURE_ABOVE_COMMITMENT: 422,
  UNKNOWN_SOURCE: 404,
  SOURCE_NOT_ALLOWED_HERE: 403,
  SOURCE_FAILED: 502,
};
const MID = "msn_[a-f0-9]{24}";

export function createWorkspaceRoutes(deps: WorkspaceRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<WsResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "SOURCE_FAILED"].includes(r.refusal),
      humanSummary:
        "Nothing was reserved, booked, paid or signed, and no one was contacted. A search only observes what a source returns.",
      nextAction: "CHECK_THE_MISSION_AND_SOURCE",
    });
  function match(prefix: string, request: RestRequest) {
    const sources = new RegExp(
      `^${prefix}/missions/(${MID})/workspace-sources$`,
      "u",
    ).exec(request.path);
    const col = new RegExp(
      `^${prefix}/missions/(${MID})/workspaces$`,
      "u",
    ).exec(request.path);
    if (!sources && !col) return null;
    const get = request.method === "GET";
    if (sources ? !get : !get && request.method !== "POST") return null;
    return { sources, col, get };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: NonNullable<ReturnType<typeof match>>,
    request: RestRequest,
  ) {
    if (m.sources)
      return reply(requestId, 200, { sources: service.sources(caller) });
    if (m.get) {
      const r = await service.list(caller, m.col![1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.search(caller, m.col![1]!, request.body);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      m.get ? "view:missions" : "mission:plan",
    );
    if (!("member" in gate)) return gate;
    return run(
      requestId,
      {
        organizationId: gate.member.organizationId,
        environment: gate.member.environment,
        id: gate.member.memberId,
        kind: "MEMBER",
      },
      m,
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
    if (!m.get && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    return run(requestId, caller, m, request);
  }
  return { member, agent };
}
