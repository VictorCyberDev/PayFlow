import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  CommRefusal,
  CommResult,
  CommunicationService,
} from "../missions/communication-service.js";

/** HTTP surface of supplier communication. Tenant and identity come from the authenticated caller, never the path or body. */
export interface CommunicationRouteDeps {
  readonly service: CommunicationService;
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
const STATUS: Record<CommRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CAPABILITY_REFUSED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONTACT_NOT_USABLE: 409,
  RULES_REFUSE: 422,
  LEAK_BLOCKED: 422,
  ILLEGAL_MOVE: 409,
  CHANNEL_UNAVAILABLE: 409,
  MISSION_NOT_ACTIVE: 409,
  NOT_THE_AUTHOR: 403,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const SID = "sup_[a-f0-9]{24}";
const CID = "cnt_[a-f0-9]{24}";
const GID = "msg_[a-f0-9]{24}";

export function createCommunicationRoutes(deps: CommunicationRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<CommResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: ["MALFORMED", "RULES_REFUSE", "LEAK_BLOCKED"].includes(
        r.refusal,
      ),
      humanSummary:
        "Nothing was sent. Messages to suppliers are approved by a person, follow the negotiation rules, never reveal the budget or other suppliers, and go only to addresses a person registered.",
      nextAction: "CHECK_THE_MESSAGE_AND_ASK_A_PERSON",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const contacts = new RegExp(
      `^/v1/admin/org/missions/(${MID})/contacts$`,
      "u",
    ).exec(request.path);
    const addContact = new RegExp(
      `^/v1/admin/org/suppliers/(${SID})/contacts$`,
      "u",
    ).exec(request.path);
    const contactOp = new RegExp(
      `^/v1/admin/org/contacts/(${CID})/(block|restore)$`,
      "u",
    ).exec(request.path);
    const msgs = new RegExp(
      `^/v1/admin/org/missions/(${MID})/messages$`,
      "u",
    ).exec(request.path);
    const inbound = new RegExp(
      `^/v1/admin/org/missions/(${MID})/messages/inbound$`,
      "u",
    ).exec(request.path);
    const events = new RegExp(
      `^/v1/admin/org/messages/(${GID})/events$`,
      "u",
    ).exec(request.path);
    const op = new RegExp(
      `^/v1/admin/org/messages/(${GID})/(approve|reject|send|resolve)$`,
      "u",
    ).exec(request.path);
    if (
      !contacts &&
      !addContact &&
      !contactOp &&
      !msgs &&
      !inbound &&
      !events &&
      !op
    )
      return null;
    const get = request.method === "GET";
    if (
      ((contacts || msgs || events) &&
        !(get || (msgs && request.method === "POST"))) ||
      ((addContact || contactOp || inbound || op) && request.method !== "POST")
    )
      return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission =
      op || (contactOp && contactOp[2] === "restore")
        ? "mission:communicate"
        : contactOp
          ? "mission:contain"
          : get
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
    if (contacts) {
      const c = await service.contacts(caller, contacts[1]!);
      return c
        ? reply(requestId, 200, { contacts: c })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    if (addContact) {
      const r = await service.addContact(caller, addContact[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (contactOp) {
      const r = await service.setContactStatus(
        caller,
        contactOp[1]!,
        contactOp[2] === "block" ? "DO_NOT_CONTACT" : "ACTIVE",
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (msgs && get) {
      const q = new URL(
        request.path + (request.query ?? ""),
        "http://x",
      ).searchParams.get("supplierId");
      const r = await service.list(
        caller,
        msgs[1]!,
        q && new RegExp(`^${SID}$`, "u").test(q) ? { supplierId: q } : {},
      );
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (msgs) {
      const r = await service.draft(caller, msgs[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (inbound) {
      const r = await service.recordInbound(caller, inbound[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (events) {
      const e = await service.events(caller, events[1]!);
      return e
        ? reply(requestId, 200, { events: e })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    const [, id, what] = op!;
    const r =
      what === "approve"
        ? await service.decide(caller, id!, "APPROVED", request.body)
        : what === "reject"
          ? await service.decide(caller, id!, "REJECTED", request.body)
          : what === "send"
            ? await service.send(caller, id!, request.body)
            : await service.resolve(caller, id!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const msgs = new RegExp(`^/v1/agent/missions/(${MID})/messages$`, "u").exec(
      request.path,
    );
    const send = new RegExp(`^/v1/agent/messages/(${GID})/send$`, "u").exec(
      request.path,
    );
    if (!msgs && !send) return null;
    const get = request.method === "GET";
    if ((send && get) || (!get && request.method !== "POST")) return null;
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
    if (msgs && get) {
      const r = await service.list(caller, msgs[1]!);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (msgs) {
      const r = await service.draft(caller, msgs[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.send(caller, send![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
