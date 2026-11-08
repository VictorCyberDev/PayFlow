import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  OResult,
  OfRefusal,
  TalentOfferService,
} from "../missions/talent-offer-service.js";

/** HTTP surface of contractor checks, offers and contracts. Tenant and identity come from the authenticated caller. */
export interface TalentOfferRouteDeps {
  readonly service: TalentOfferService;
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
const STATUS: Record<OfRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  NO_SCOPE_IN_FORCE: 409,
  NOT_SHORTLISTED: 422,
  TERMS_INVALID: 422,
  CHECKS_NOT_PASSED: 422,
  ILLEGAL_MOVE: 409,
  OFFER_EXPIRED: 409,
  SCOPE_CHANGED: 409,
  ALREADY_LIVE: 409,
  LEDGER_REFUSED: 409,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const CID = "tcd_[a-f0-9]{24}";
const OID = "ofr_[a-f0-9]{24}";

export function createTalentOfferRoutes(deps: TalentOfferRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<OResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "TERMS_INVALID", "CHECKS_NOT_PASSED"].includes(
        r.refusal,
      ),
      humanSummary:
        "Nothing was sent or committed. An offer needs the scope's checks passed by a person, is approved, sent and answered by a person, and PayFlow is not a party to it.",
      nextAction: "CHECK_THE_OFFER_AND_ASK_A_PERSON",
    });
  type Parts = {
    checks?: RegExpExecArray;
    candChecks?: RegExpExecArray;
    offers?: RegExpExecArray;
    act?: RegExpExecArray;
  };
  function match(
    prefix: string,
    request: RestRequest,
    actions: string,
  ): (Parts & { get: boolean }) | null {
    const checks = new RegExp(
      `^${prefix}/missions/(${MID})/talent-checks$`,
      "u",
    ).exec(request.path);
    const candChecks = new RegExp(
      `^${prefix}/missions/(${MID})/talent-candidates/(${CID})/checks$`,
      "u",
    ).exec(request.path);
    const offers = new RegExp(
      `^${prefix}/missions/(${MID})/talent-offers$`,
      "u",
    ).exec(request.path);
    const act = new RegExp(
      `^${prefix}/talent-offers/(${OID})/(${actions})$`,
      "u",
    ).exec(request.path);
    if (!checks && !candChecks && !offers && !act) return null;
    const get = request.method === "GET";
    if (
      candChecks
        ? !get
        : checks || act
          ? request.method !== "POST"
          : !get && request.method !== "POST"
    )
      return null;
    return {
      ...(checks ? { checks } : {}),
      ...(candChecks ? { candChecks } : {}),
      ...(offers ? { offers } : {}),
      ...(act ? { act } : {}),
      get,
    };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: Parts & { get: boolean },
    request: RestRequest,
  ) {
    if (m.checks) {
      const r = await service.recordCheck(caller, m.checks[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (m.candChecks) {
      const r = await service.checks(
        caller,
        m.candChecks[1]!,
        m.candChecks[2]!,
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (m.offers) {
      if (m.get) {
        const r = await service.list(caller, m.offers[1]!);
        return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
      }
      const r = await service.draft(caller, m.offers[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const id = m.act![1]!;
    const a = m.act![2]!;
    const r =
      a === "approve"
        ? await service.approve(caller, id)
        : a === "sent"
          ? await service.markSent(caller, id, request.body)
          : a === "answer"
            ? await service.answer(caller, id, request.body)
            : await service.withdraw(caller, id, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request, "approve|sent|answer|withdraw");
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = m.get
      ? "view:missions"
      : m.offers && !m.get
        ? "mission:plan"
        : "mission:approve";
    const gate = await deps.authorize(requestId, request, permission);
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
    const m = match("/v1/agent", request, "withdraw");
    if (!m || m.checks) return null; // agents record no checks
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
