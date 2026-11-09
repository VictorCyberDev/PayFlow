import { randomUUID } from "node:crypto";
import { toCsv } from "../missions/ap-export.js";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  LedgerRefusal,
  LedgerService,
  LResult,
} from "../missions/ledger-service.js";

/** HTTP surface of the mission commitment ledger. Tenant and identity come from the authenticated caller. */
export interface LedgerRouteDeps {
  readonly service: LedgerService;
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
const STATUS: Record<LedgerRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  CURRENCY_MISMATCH: 422,
  CAPACITY_EXCEEDED: 409,
  ABOVE_MAX_COMMITMENT: 409,
  ILLEGAL_MOVE: 409,
  EVIDENCE_INSUFFICIENT: 422,
  AGENT_NOT_PERMITTED: 403,
  MISSION_NOT_ACTIVE: 409,
  AMOUNT_FROZEN: 409,
  REFUND_EXCEEDS_SETTLED: 409,
  STALE_ROW_VERSION: 409,
  CAPABILITY_REFUSED: 403,
};
const MID = "msn_[a-f0-9]{24}";
const IID = "itm_[a-f0-9]{24}";

export function createLedgerRoutes(deps: LedgerRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<LResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "STALE_ROW_VERSION"].includes(r.refusal),
      humanSummary:
        "Nothing changed. The ledger only changes through an authorized, evidenced, within-ceiling request.",
      nextAction: "RELOAD_THE_LEDGER_AND_RETRY",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/ledger(?:/(items|export))?$`,
      "u",
    ).exec(request.path);
    const item = new RegExp(
      `^/v1/admin/org/ledger/items/(${IID})/(transition|history)$`,
      "u",
    ).exec(request.path);
    if (!list && !item) return null;
    const requestId = `req_${randomUUID()}`;
    const read = request.method === "GET";
    const gate = await deps.authorize(
      requestId,
      request,
      read ? "view:missions" : "mission:ledger",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (list) {
      if (read && !list[2]) {
        const r = await service.overview(caller, list[1]!);
        return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
      }
      if (read && list[2] === "export") {
        const r = await service.overview(caller, list[1]!);
        if (!r.ok) return refuse(requestId, r);
        return reply(requestId, 200, {
          filename: `payflow-ledger-${list[1]!}.csv`,
          csv: toCsv(r.value.items),
          notice:
            "An export for your bookkeeping. It is not connected to any accounting system and records nothing as booked.",
        });
      }
      if (!read && list[2] === "items") {
        const r = await service.createItem(caller, list[1]!, request.body);
        return r.ok
          ? reply(requestId, r.value.replayed ? 200 : 201, { item: r.value })
          : refuse(requestId, r);
      }
      return null;
    }
    const [, id, op] = item!;
    if (read && op === "history") {
      const h = await service.history(caller, id!);
      return h
        ? reply(requestId, 200, { entries: h })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    if (!read && op === "transition") {
      const r = await service.transition(caller, id!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 200, { item: r.value })
        : refuse(requestId, r);
    }
    return null;
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/ledger(?:/(items))?$`,
      "u",
    ).exec(request.path);
    const item = new RegExp(
      `^/v1/agent/ledger/items/(${IID})/transition$`,
      "u",
    ).exec(request.path);
    if (!list && !item) return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (request.method === "POST" && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    if (list && request.method === "GET" && !list[2]) {
      // An agent sees the capacity picture and its own items, not other agents' work.
      const r = await service.overview(caller, list[1]!);
      return r.ok
        ? reply(requestId, 200, {
            summary: r.value.summary,
            items: r.value.items.filter((i) => i.agentId === caller.id),
          })
        : refuse(requestId, r);
    }
    if (list && request.method === "POST" && list[2] === "items") {
      const r = await service.createItem(caller, list[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, { item: r.value })
        : refuse(requestId, r);
    }
    if (item && request.method === "POST") {
      const r = await service.transition(caller, item[1]!, request.body);
      return r.ok
        ? reply(requestId, 200, { item: r.value })
        : refuse(requestId, r);
    }
    return null;
  }
  return { member, agent };
}
