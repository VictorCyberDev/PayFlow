import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  OResult,
  OrdRefusal,
  OrderService,
} from "../missions/order-service.js";

/** HTTP surface of orders. Tenant and identity come from the authenticated caller, never the path or body. */
export interface OrderRouteDeps {
  readonly service: OrderService;
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
const STATUS: Record<OrdRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_SETTLED: 409,
  ALREADY_CREATED: 409,
  NOT_THE_BUYER: 403,
  EVIDENCE_REQUIRED: 422,
  ILLEGAL_MOVE: 409,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const OID = "ord_[a-f0-9]{24}";
const PID = "po_[a-f0-9]{24}";

export function createOrderRoutes(deps: OrderRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<OResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "EVIDENCE_REQUIRED"].includes(r.refusal),
      humanSummary:
        "Nothing was changed. An order's status moves only when a person records it with evidence; reports are shown as claims.",
      nextAction: "CHECK_THE_ORDER",
    });
  const unauth = (requestId: string) =>
    reply(requestId, 401, {
      reason: "AGENT_AUTH_REQUIRED",
      recoverable: false,
      humanSummary: "A valid agent credential is required.",
      nextAction: "PRESENT_AGENT_CREDENTIAL",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const create = new RegExp(
      `^/v1/admin/org/purchase-orders/(${PID})/order$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/orders$`,
      "u",
    ).exec(request.path);
    const ev = new RegExp(`^/v1/admin/org/orders/(${OID})/events$`, "u").exec(
      request.path,
    );
    if (!create && !list && !ev) return null;
    const get = request.method === "GET";
    if ((list && !get) || ((create || ev) && request.method !== "POST"))
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      list ? "view:missions" : "mission:ledger",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (list) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (create) {
      const r = await service.create(caller, create[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.record(caller, ev![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const create = new RegExp(
      `^/v1/agent/purchase-orders/(${PID})/order$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(`^/v1/agent/missions/(${MID})/orders$`, "u").exec(
      request.path,
    );
    const ev = new RegExp(`^/v1/agent/orders/(${OID})/events$`, "u").exec(
      request.path,
    );
    if (!create && !list && !ev) return null;
    const get = request.method === "GET";
    if ((list && !get) || ((create || ev) && request.method !== "POST"))
      return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller) return unauth(requestId);
    if (!get && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    if (list) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (create) {
      const r = await service.create(caller, create[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.record(caller, ev![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
