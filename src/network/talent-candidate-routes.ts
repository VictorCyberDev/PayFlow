import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  CResult,
  TcRefusal,
  TalentCandidateService,
} from "../missions/talent-candidate-service.js";

/** HTTP surface of talent sources and candidates. Tenant and identity come from the authenticated caller, never the path or body. */
export interface TalentCandidateRouteDeps {
  readonly service: TalentCandidateService;
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
const STATUS: Record<TcRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NO_SCOPE_IN_FORCE: 409,
  NO_SUCH_ROLE: 422,
  UNKNOWN_SOURCE: 404,
  SOURCE_NOT_ALLOWED_HERE: 403,
  SOURCE_FAILED: 502,
};
const MID = "msn_[a-f0-9]{24}";

export function createTalentCandidateRoutes(deps: TalentCandidateRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<CResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "SOURCE_FAILED"].includes(r.refusal),
      humanSummary:
        "Nothing was imported or contacted. Sources only observe; what they return is a claim, never verified, and a talent scope must be in force first.",
      nextAction: "CHECK_THE_SCOPE_AND_SOURCE",
    });
  function match(prefix: string, request: RestRequest) {
    const sources = new RegExp(
      `^${prefix}/missions/(${MID})/talent-sources$`,
      "u",
    ).exec(request.path);
    const imp = new RegExp(
      `^${prefix}/missions/(${MID})/talent-candidates/import$`,
      "u",
    ).exec(request.path);
    const col = new RegExp(
      `^${prefix}/missions/(${MID})/talent-candidates$`,
      "u",
    ).exec(request.path);
    if (!sources && !imp && !col) return null;
    const get = request.method === "GET";
    if (
      sources
        ? !get
        : imp
          ? request.method !== "POST"
          : !get && request.method !== "POST"
    )
      return null;
    return { sources, imp, col, get };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: NonNullable<ReturnType<typeof match>>,
    request: RestRequest,
  ) {
    if (m.sources)
      return reply(requestId, 200, { sources: service.sources(caller) });
    if (m.imp) {
      const r = await service.importFromSource(caller, m.imp[1]!, request.body);
      return r.ok ? reply(requestId, 201, r.value) : refuse(requestId, r);
    }
    if (m.get) {
      const role = request.query
        ? new URLSearchParams(request.query).get("roleId")
        : null;
      const r = await service.list(caller, m.col![1]!, role ?? undefined);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.addManual(caller, m.col![1]!, request.body);
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
