import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  AccRefusal,
  AccResult,
  AcceptanceService,
} from "../missions/acceptance-service.js";

/** HTTP surface of offer acceptance and escalation. Tenant and identity come from the authenticated caller, never the path or body. */
export interface AcceptanceRouteDeps {
  readonly service: AcceptanceService;
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
const STATUS: Record<AccRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  CHECKS_FAILED: 422,
  OVERRIDE_REQUIRED: 422,
  ALREADY_RESOLVED: 409,
  LEDGER_REFUSED: 409,
  MEMBER_ONLY: 403,
  NOT_ACCEPTED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const QID = "qte_[a-f0-9]{24}";
const AID = "acc_[a-f0-9]{24}";
const EID = "esc_[a-f0-9]{24}";

export function createAcceptanceRoutes(deps: AcceptanceRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<AccResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "CHECKS_FAILED", "OVERRIDE_REQUIRED"].includes(
        r.refusal,
      ),
      humanSummary:
        "Nothing was committed. A quote is accepted only when every check holds; a person decides what an agent may not, and nobody can exceed the approved walk-away.",
      nextAction: "CHECK_THE_QUOTE_AND_RULES",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const check = new RegExp(
      `^/v1/admin/org/quotes/(${QID})/acceptance-check$`,
      "u",
    ).exec(request.path);
    const accept = new RegExp(
      `^/v1/admin/org/quotes/(${QID})/accept$`,
      "u",
    ).exec(request.path);
    const withdraw = new RegExp(
      `^/v1/admin/org/acceptances/(${AID})/withdraw$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/acceptances$`,
      "u",
    ).exec(request.path);
    const resolve = new RegExp(
      `^/v1/admin/org/escalations/(${EID})/resolve$`,
      "u",
    ).exec(request.path);
    if (!check && !accept && !withdraw && !list && !resolve) return null;
    const get = request.method === "GET";
    if (
      ((check || list) && !get) ||
      ((accept || withdraw || resolve) && request.method !== "POST")
    )
      return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      get ? "view:missions" : "mission:approve",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (check) {
      const r = await service.evaluate(caller, check[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (list) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (accept) {
      const r = await service.accept(caller, accept[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (withdraw) {
      const r = await service.withdraw(caller, withdraw[1]!, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.resolve(caller, resolve![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const check = new RegExp(
      `^/v1/agent/quotes/(${QID})/acceptance-check$`,
      "u",
    ).exec(request.path);
    const accept = new RegExp(`^/v1/agent/quotes/(${QID})/accept$`, "u").exec(
      request.path,
    );
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/acceptances$`,
      "u",
    ).exec(request.path);
    const esc = new RegExp(
      `^/v1/agent/missions/(${MID})/escalations$`,
      "u",
    ).exec(request.path);
    if (!check && !accept && !list && !esc) return null;
    const get = request.method === "GET";
    if (
      ((check || list) && !get) ||
      ((accept || esc) && request.method !== "POST")
    )
      return null;
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
    if (check) {
      const r = await service.evaluate(caller, check[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (list) {
      const r = await service.list(caller, list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (accept) {
      const r = await service.accept(caller, accept[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.escalate(caller, request.body);
    return r.ok
      ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
      : refuse(requestId, r);
  }
  return { member, agent };
}
