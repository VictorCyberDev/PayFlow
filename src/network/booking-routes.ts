import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  BkRefusal,
  BkResult,
  BookingService,
} from "../missions/booking-service.js";

/** HTTP surface of booking intents. Tenant and identity come from the authenticated caller. Agents may only propose and read. */
export interface BookingRouteDeps {
  readonly service: BookingService;
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
const STATUS: Record<BkRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  MEMBER_ONLY: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  MISSION_NOT_ACTIVE: 409,
  NOT_QUALIFIED: 422,
  ALREADY_LIVE: 409,
  BAD_DEADLINE: 422,
  ILLEGAL_MOVE: 409,
  EXPIRED: 409,
  LEDGER_REFUSED: 409,
  PENALTY_ABOVE_TERMS: 422,
  DEPOSIT_NOT_REQUIRED: 409,
};
const MID = "msn_[a-f0-9]{24}";
const BID = "bkg_[a-f0-9]{24}";
const OPS = [
  "approve",
  "handoff",
  "unknown",
  "confirm",
  "decline",
  "cancel",
  "deposit",
] as const;
type Op = (typeof OPS)[number];
const PERMISSION: Record<Op, Permission> = {
  approve: "mission:approve",
  handoff: "mission:control",
  unknown: "mission:control",
  confirm: "mission:control",
  decline: "mission:control",
  cancel: "mission:control",
  deposit: "mission:control",
};

export function createBookingRoutes(deps: BookingRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<BkResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "BAD_DEADLINE", "NOT_QUALIFIED"].includes(
        r.refusal,
      ),
      humanSummary:
        "Nothing was booked, reserved or paid. A booking only changes through an authorized request, and is reserved only with evidence a person attaches.",
      nextAction: "CHECK_THE_BOOKING_STATE",
    });
  function match(prefix: string, request: RestRequest) {
    const col = new RegExp(`^${prefix}/missions/(${MID})/bookings$`, "u").exec(
      request.path,
    );
    const op = new RegExp(
      `^${prefix}/bookings/(${BID})/(${OPS.join("|")})$`,
      "u",
    ).exec(request.path);
    if (!col && !op) return null;
    if (col && request.method !== "GET" && request.method !== "POST")
      return null;
    if (op && request.method !== "POST") return null;
    return { col, op, get: request.method === "GET" };
  }
  async function run(
    requestId: string,
    caller: MissionCaller,
    m: NonNullable<ReturnType<typeof match>>,
    request: RestRequest,
  ) {
    if (m.col) {
      if (m.get) {
        const r = await service.list(caller, m.col[1]!);
        return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
      }
      const r = await service.propose(caller, m.col[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const id = m.op![1]!;
    const op = m.op![2] as Op;
    const r =
      op === "approve"
        ? await service.approve(caller, id)
        : op === "handoff"
          ? await service.handOff(caller, id, request.body)
          : op === "unknown"
            ? await service.markUnknown(caller, id, request.body)
            : op === "confirm"
              ? await service.confirm(caller, id, request.body)
              : op === "decline"
                ? await service.decline(caller, id, request.body)
                : op === "cancel"
                  ? await service.cancel(caller, id, request.body)
                  : await service.recordDeposit(caller, id, request.body);
    return r.ok
      ? reply(
          requestId,
          200,
          "booking" in r.value ? r.value : { booking: r.value },
        )
      : refuse(requestId, r);
  }
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const m = match("/v1/admin/org", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = m.col
      ? m.get
        ? "view:missions"
        : "mission:plan"
      : PERMISSION[m.op![2] as Op];
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
    const m = match("/v1/agent", request);
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    // An agent may propose a booking and read; it can never approve, hand off, confirm, decline, cancel or record a deposit.
    if (m.op)
      return reply(requestId, 403, {
        reason: "MEMBER_ONLY",
        recoverable: false,
        humanSummary: "Only a person decides a booking.",
        nextAction: "ASK_THE_OWNER",
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
