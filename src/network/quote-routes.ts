import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  QResult,
  QuoteRefusal,
  QuoteService,
} from "../missions/quote-service.js";

/** HTTP surface of supplier quotes and landed cost. Tenant and identity come from the authenticated caller, never the path or body. */
export interface QuoteRouteDeps {
  readonly service: QuoteService;
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
const STATUS: Record<QuoteRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  SUPPLIER_NOT_ALLOWED_BY_CONTRACT: 403,
  SOURCE_EVIDENCE_INVALID: 400,
  QUOTE_EXPIRED: 409,
  QUOTE_SUPERSEDED: 409,
  QUOTE_INCOMPLETE: 422,
  CURRENCY_MISMATCH: 422,
  LEDGER_REFUSED: 409,
  LINK_INTEGRITY_FAILURE: 409,
};
const MID = "msn_[a-f0-9]{24}";
const QID = "qte_[a-f0-9]{24}";

export function createQuoteRoutes(deps: QuoteRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<QResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "QUOTE_EXPIRED",
        "QUOTE_SUPERSEDED",
        "QUOTE_INCOMPLETE",
      ].includes(r.refusal),
      humanSummary:
        "Nothing was changed. A quote is recorded as the supplier stated it; it is never an acceptance, and a total is shown only when nothing in it is unknown.",
      nextAction: "CHECK_THE_QUOTE_AND_EVIDENCE",
    });
  type Op = "list" | "record" | "compare" | "ledger";
  async function serve(
    requestId: string,
    caller: MissionCaller,
    op: Op,
    id: string,
    request: RestRequest,
  ) {
    const post = request.method === "POST";
    if (op === "list" && request.method === "GET") {
      const r = await service.list(caller, id);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (op === "record" && post) {
      const r = await service.record(caller, id, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (op === "compare" && post) {
      const r = await service.compare(caller, id, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (op === "ledger" && post) {
      const r = await service.toLedger(caller, id, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    return null;
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/quotes$`,
      "u",
    ).exec(request.path);
    const cmp = new RegExp(
      `^/v1/admin/org/missions/(${MID})/quotes/compare$`,
      "u",
    ).exec(request.path);
    const led = new RegExp(`^/v1/admin/org/quotes/(${QID})/ledger$`, "u").exec(
      request.path,
    );
    if (!list && !cmp && !led) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = led
      ? "mission:ledger"
      : cmp
        ? "view:missions"
        : request.method === "GET"
          ? "view:missions"
          : "mission:plan";
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (led) return serve(requestId, caller, "ledger", led[1]!, request);
    if (cmp) return serve(requestId, caller, "compare", cmp[1]!, request);
    return serve(
      requestId,
      caller,
      request.method === "GET" ? "list" : "record",
      list![1]!,
      request,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(`^/v1/agent/missions/(${MID})/quotes$`, "u").exec(
      request.path,
    );
    const cmp = new RegExp(
      `^/v1/agent/missions/(${MID})/quotes/compare$`,
      "u",
    ).exec(request.path);
    const led = new RegExp(`^/v1/agent/quotes/(${QID})/ledger$`, "u").exec(
      request.path,
    );
    if (!list && !cmp && !led) return null;
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
    if (led) return serve(requestId, caller, "ledger", led[1]!, request);
    if (cmp) return serve(requestId, caller, "compare", cmp[1]!, request);
    return serve(
      requestId,
      caller,
      request.method === "GET" ? "list" : "record",
      list![1]!,
      request,
    );
  }
  return { member, agent };
}
