import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  ObRefusal,
  OResult,
  ObligationService,
} from "../missions/obligation-service.js";

/** HTTP surface of obligations. Tenant and identity come from the authenticated caller, never the path or body. */
export interface ObligationRouteDeps {
  readonly service: ObligationService;
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
const STATUS: Record<ObRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  MEMBER_ONLY: 403,
  ALREADY_RESOLVED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const OID = "ord_[a-f0-9]{24}";
const BID = "obl_[a-f0-9]{24}";

export function createObligationRoutes(deps: ObligationRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<OResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: r.refusal === "MALFORMED",
      humanSummary:
        "Nothing was changed. Obligations are reminders; only a person closes one, and none of them moves money.",
      nextAction: "CHECK_THE_REQUEST",
    });
  const unauth = (requestId: string) =>
    reply(requestId, 401, {
      reason: "AGENT_AUTH_REQUIRED",
      recoverable: false,
      humanSummary: "A valid agent credential is required.",
      nextAction: "PRESENT_AGENT_CREDENTIAL",
    });
  function match(prefix: string, request: RestRequest) {
    const derive = new RegExp(
      `^${prefix}/orders/(${OID})/obligations/derive$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^${prefix}/missions/(${MID})/obligations$`,
      "u",
    ).exec(request.path);
    const resolve = new RegExp(
      `^${prefix}/obligations/(${BID})/resolve$`,
      "u",
    ).exec(request.path);
    if (!derive && !list && !resolve) return null;
    const get = request.method === "GET";
    // list answers GET and POST (create); derive and resolve answer POST only
    if (list ? !get && request.method !== "POST" : request.method !== "POST")
      return null;
    return { derive, list, resolve, get };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: NonNullable<ReturnType<typeof match>>,
    payload: unknown,
  ) {
    if (m.derive) {
      const r = await service.derive(caller, m.derive[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (m.resolve) {
      const r = await service.resolve(caller, m.resolve[1]!, payload);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (m.get) {
      const r = await service.list(caller, m.list![1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.create(caller, m.list![1]!, payload);
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
      m.get ? "view:missions" : "mission:ledger",
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
      request.body,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/agent", request);
    if (!m || m.derive || m.resolve) return null; // agents may list and add reminders only
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller) return unauth(requestId);
    if (!m.get && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    return run(requestId, caller, m, request.body);
  }
  return { member, agent };
}
