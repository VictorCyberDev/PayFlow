import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  PResult,
  ProcRefusal,
  ProcurementService,
} from "../missions/procurement-service.js";

/** HTTP surface of purchase orders and reconciliation. Tenant and identity come from the authenticated caller, never the path or body. */
export interface ProcurementRouteDeps {
  readonly service: ProcurementService;
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
const STATUS: Record<ProcRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_ACCEPTED: 409,
  ALREADY_ISSUED: 409,
  QUOTE_EXPIRED: 409,
  NO_AUTHORITY: 422,
  ABOVE_AUTHORITY: 422,
  MERCHANT_NOT_IN_AUTHORITY: 422,
  NOT_THE_BUYER: 403,
  ORDER_EXPIRED: 409,
  TRACE_UNAVAILABLE: 409,
  LEDGER_REFUSED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const AID = "acc_[a-f0-9]{24}";
const PID = "po_[a-f0-9]{24}";

export function createProcurementRoutes(deps: ProcurementRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<PResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "TRACE_UNAVAILABLE"].includes(r.refusal),
      humanSummary:
        "No money moved and the budget was not changed by this call. A purchase order is an instruction; payment still goes through PayFlow's Authority.",
      nextAction: "CHECK_THE_ORDER_AND_AUTHORITY",
    });
  const unauth = (requestId: string) =>
    reply(requestId, 401, {
      reason: "AGENT_AUTH_REQUIRED",
      recoverable: false,
      humanSummary: "A valid agent credential is required.",
      nextAction: "PRESENT_AGENT_CREDENTIAL",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const issue = new RegExp(
      `^/v1/admin/org/acceptances/(${AID})/purchase-order$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/purchase-orders$`,
      "u",
    ).exec(request.path);
    const rec = new RegExp(
      `^/v1/admin/org/purchase-orders/(${PID})/reconcile$`,
      "u",
    ).exec(request.path);
    if (!issue && !list && !rec) return null;
    const get = request.method === "GET";
    if ((list && !get) || ((issue || rec) && request.method !== "POST"))
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      list ? "view:missions" : rec ? "mission:ledger" : "mission:approve",
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
    if (issue) {
      const r = await service.issue(caller, issue[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.reconcile(caller, rec![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const issue = new RegExp(
      `^/v1/agent/acceptances/(${AID})/purchase-order$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/purchase-orders$`,
      "u",
    ).exec(request.path);
    const rec = new RegExp(
      `^/v1/agent/purchase-orders/(${PID})/reconcile$`,
      "u",
    ).exec(request.path);
    if (!issue && !list && !rec) return null;
    const get = request.method === "GET";
    if ((list && !get) || ((issue || rec) && request.method !== "POST"))
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
    if (issue) {
      const r = await service.issue(caller, issue[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.reconcile(caller, rec![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
