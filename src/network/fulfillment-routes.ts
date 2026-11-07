import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  FResult,
  FulRefusal,
  FulfillmentService,
} from "../missions/fulfillment-service.js";

/** HTTP surface of fulfillment. Tenant and identity come from the authenticated caller, never the path or body. */
export interface FulfillmentRouteDeps {
  readonly service: FulfillmentService;
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
const STATUS: Record<FulRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_THE_BUYER: 403,
  MEMBER_ONLY: 403,
  EVIDENCE_REQUIRED: 422,
  ORDER_NOT_SHIPPED: 409,
  NO_SUCH_LINE: 422,
};
const OID = "ord_[a-f0-9]{24}";

export function createFulfillmentRoutes(deps: FulfillmentRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<FResult<unknown>, { ok: false }>,
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
    const m = new RegExp(
      `^/v1/admin/org/orders/(${OID})/(shipments|receipts|fulfillment)$`,
      "u",
    ).exec(request.path);
    if (!m) return null;
    const what = m[2]!;
    const get = request.method === "GET";
    if (what === "fulfillment" ? !get : request.method !== "POST") return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      get ? "view:missions" : "mission:ledger",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    return run(requestId, caller, what, m[1]!, request.body);
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    what: string,
    id: string,
    payload: unknown,
  ) {
    if (what === "fulfillment") {
      const r = await service.view(caller, id);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (what === "shipments") {
      const r = await service.addShipment(caller, id, payload);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.addReceipt(caller, id, payload);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = new RegExp(
      `^/v1/agent/orders/(${OID})/(shipments|fulfillment)$`,
      "u",
    ).exec(request.path);
    if (!m) return null;
    const what = m[2]!;
    const get = request.method === "GET";
    if (what === "fulfillment" ? !get : request.method !== "POST") return null;
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
    return run(requestId, caller, what, m[1]!, request.body);
  }
  return { member, agent };
}
