import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  DResult,
  DspRefusal,
  DisputeService,
} from "../missions/dispute-service.js";

/** HTTP surface of disputes and refunds. Tenant and identity come from the authenticated caller, never the path or body. */
export interface DisputeRouteDeps {
  readonly service: DisputeService;
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
const STATUS: Record<DspRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_THE_BUYER: 403,
  MEMBER_ONLY: 403,
  DISPUTE_NOT_ALLOWED: 422,
  ALREADY_RESOLVED: 409,
  REFUND_NOT_ALLOWED: 422,
  LEDGER_REFUSED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const OID = "ord_[a-f0-9]{24}";
const DID = "dsp_[a-f0-9]{24}";

export function createDisputeRoutes(deps: DisputeRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<DResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "DISPUTE_NOT_ALLOWED",
        "REFUND_NOT_ALLOWED",
      ].includes(r.refusal),
      humanSummary:
        "Nothing was refunded. A dispute needs a ground the receipts support, and a refund is recorded only with Proof or a provider confirmation by a person.",
      nextAction: "CHECK_THE_FULFILLMENT_AND_EVIDENCE",
    });
  const unauth = (requestId: string) =>
    reply(requestId, 401, {
      reason: "AGENT_AUTH_REQUIRED",
      recoverable: false,
      humanSummary: "A valid agent credential is required.",
      nextAction: "PRESENT_AGENT_CREDENTIAL",
    });

  async function run(
    requestId: string,
    caller: MissionCaller,
    parts: { open?: string; list?: string; id?: string; action?: string },
    payload: unknown,
  ) {
    if (parts.list) {
      const r = await service.list(caller, parts.list);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (parts.open) {
      const r = await service.open(caller, parts.open, payload);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r =
      parts.action === "resolve"
        ? await service.resolve(caller, parts.id!, payload)
        : parts.action === "withdraw"
          ? await service.withdraw(caller, parts.id!, payload)
          : await service.addEvent(caller, parts.id!, payload);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  function match(prefix: string, request: RestRequest, actions: string) {
    const open = new RegExp(`^${prefix}/orders/(${OID})/disputes$`, "u").exec(
      request.path,
    );
    const list = new RegExp(`^${prefix}/missions/(${MID})/disputes$`, "u").exec(
      request.path,
    );
    const act = new RegExp(
      `^${prefix}/disputes/(${DID})/(${actions})$`,
      "u",
    ).exec(request.path);
    if (!open && !list && !act) return null;
    const get = request.method === "GET";
    if (list ? !get : request.method !== "POST") return null;
    return {
      parts: {
        ...(open ? { open: open[1]! } : {}),
        ...(list ? { list: list[1]! } : {}),
        ...(act ? { id: act[1]!, action: act[2]! } : {}),
      },
      get,
      action: act?.[2],
    };
  }

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request, "resolve|withdraw|events");
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      m.get
        ? "view:missions"
        : m.action === "resolve"
          ? "mission:approve"
          : "mission:ledger",
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
      m.parts,
      request.body,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/agent", request, "withdraw|events");
    if (!m) return null;
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
    return run(requestId, caller, m.parts, request.body);
  }
  return { member, agent };
}
