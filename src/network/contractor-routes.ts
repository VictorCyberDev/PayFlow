import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  CtRefusal,
  ContractorService,
} from "../missions/contractor-service.js";

/** HTTP surface of talent contracts' deliverables, payment instructions and termination. Tenant and identity come from the authenticated caller. */
export interface ContractorRouteDeps {
  readonly service: ContractorService;
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
const STATUS: Record<CtRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  MEMBER_ONLY: 403,
  NO_SUCH_MILESTONE: 422,
  CONTRACT_TERMINATED: 409,
  ALREADY_ACCEPTED: 409,
  ALREADY_OPEN: 409,
  ALREADY_DECIDED: 409,
  NOT_ACCEPTED: 409,
  ALREADY_ISSUED: 409,
  NO_AUTHORITY: 422,
  ABOVE_AUTHORITY: 422,
  PAYEE_NOT_IN_AUTHORITY: 422,
  MILESTONE_NOT_COMMITTED: 409,
  NOT_THE_BUYER: 403,
  TRACE_UNAVAILABLE: 409,
  LEDGER_REFUSED: 409,
  EVIDENCE_REQUIRED: 422,
};
const MID = "msn_[a-f0-9]{24}";
const CID = "tct_[a-f0-9]{24}";
const DID = "dlv_[a-f0-9]{24}";
const PID = "cpy_[a-f0-9]{24}";

export function createContractorRoutes(deps: ContractorRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: { refusal: CtRefusal; detail?: string },
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "EVIDENCE_REQUIRED",
        "TRACE_UNAVAILABLE",
      ].includes(r.refusal),
      humanSummary:
        "No money moved and the budget was not changed by this call. A deliverable is accepted by a person with evidence, and a payment instruction is not a payment: payment goes through PayFlow's Authority.",
      nextAction: "CHECK_THE_MILESTONE_AND_AUTHORITY",
    });
  function match(prefix: string, request: RestRequest) {
    const list = new RegExp(
      `^${prefix}/missions/(${MID})/contracts$`,
      "u",
    ).exec(request.path);
    const sub = new RegExp(
      `^${prefix}/contracts/(${CID})/milestones/(\\d{1,2})/deliverables$`,
      "u",
    ).exec(request.path);
    const dec = new RegExp(
      `^${prefix}/deliverables/(${DID})/decide$`,
      "u",
    ).exec(request.path);
    const pay = new RegExp(
      `^${prefix}/deliverables/(${DID})/payment$`,
      "u",
    ).exec(request.path);
    const rec = new RegExp(
      `^${prefix}/contractor-payments/(${PID})/reconcile$`,
      "u",
    ).exec(request.path);
    const term = new RegExp(
      `^${prefix}/contracts/(${CID})/terminate$`,
      "u",
    ).exec(request.path);
    if (!list && !sub && !dec && !pay && !rec && !term) return null;
    const get = request.method === "GET";
    if (list ? !get : request.method !== "POST") return null;
    return { list, sub, dec, pay, rec, term, get };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: NonNullable<ReturnType<typeof match>>,
    payload: unknown,
  ) {
    if (m.list) {
      const r = await service.list(caller, m.list[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (m.sub) {
      const r = await service.submit(
        caller,
        m.sub[1]!,
        Number(m.sub[2]),
        payload,
      );
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (m.dec) {
      const r = await service.decide(caller, m.dec[1]!, payload);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (m.pay) {
      const r = await service.issuePayment(caller, m.pay[1]!, payload);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (m.rec) {
      const r = await service.reconcile(caller, m.rec[1]!, payload);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    const r = await service.terminate(caller, m.term![1]!, payload);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = m.get
      ? "view:missions"
      : m.dec || m.pay
        ? "mission:approve"
        : m.term
          ? "mission:contain"
          : "mission:ledger";
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
      request.body,
    );
  }
  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/agent", request);
    if (!m || m.dec || m.term) return null; // agents neither accept deliverables nor terminate contracts
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
    return run(requestId, caller, m, request.body);
  }
  return { member, agent };
}
