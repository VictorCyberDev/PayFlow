import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member } from "./rbac.js";
import type { Permission } from "./rbac.js";
import type { MissionService } from "../missions/service.js";
import {
  type MissionCaller,
  type MissionRefusal,
  type MissionStatus,
  type Result,
} from "../missions/service.js";

/**
 * HTTP surface of the Mission Contract. Tenant, environment and identity come from the authenticated MEMBER (or agent
 * credential), never from the path or body. Members use /v1/admin/org/missions...; an agent uses /v1/agent/missions...
 * and can only read the part of a mission it is assigned to, or propose a revision that waits for an owner.
 */
export interface MissionRouteDeps {
  readonly service: MissionService;
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
  /** Resolves an authenticated agent credential to its tenant and agent id, or null. */
  readonly agent: (request: RestRequest) => Promise<MissionCaller | null>;
  /** True when the organization is paused (new proposals are refused while paused). */
  readonly paused: (caller: MissionCaller) => Promise<boolean>;
  /** What was compiled from a mission into stored Authorities, and what could not be (M29). */
  readonly authorities?: (
    caller: MissionCaller,
    missionId: string,
  ) => Promise<object | null>;
}

const STATUS: Record<MissionRefusal, number> = {
  MALFORMED: 400,
  INVALID_CONTRACT: 422,
  EXPIRY_IN_PAST: 422,
  ALREADY_EXPIRED: 409,
  AGENT_NOT_IN_ORGANIZATION: 422,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  STALE_ROW_VERSION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ILLEGAL_TRANSITION: 409,
  MISSION_TERMINAL: 409,
  NOTHING_TO_APPROVE: 409,
  VERSION_MISMATCH: 409,
  NOT_ASSIGNED: 403,
};

const ID = "msn_[a-f0-9]{24}";
const MEMBER_OPS = new Set([
  "authorities",
  "history",
  "revisions",
  "submit",
  "approve",
  "reject",
  "pause",
  "resume",
  "cancel",
  "revoke",
  "complete",
]);
const PERMISSION_FOR: Record<string, Permission> = {
  submit: "mission:control",
  resume: "mission:control",
  cancel: "mission:control",
  complete: "mission:control",
  pause: "mission:contain",
  revoke: "mission:contain",
  approve: "mission:approve",
  reject: "mission:approve",
  revisions: "mission:revise",
};

export function createMissionRoutes(deps: MissionRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: { refusal: MissionRefusal; detail?: string },
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "INVALID_CONTRACT",
        "STALE_VERSION",
        "STALE_ROW_VERSION",
        "EXPIRY_IN_PAST",
      ].includes(r.refusal),
      humanSummary:
        "Nothing changed. A mission only changes through an authorized, current, well-formed request.",
      nextAction: "RELOAD_THE_MISSION_AND_RETRY",
    });
  const done = <T extends object>(
    requestId: string,
    status: number,
    r: Result<T>,
  ) =>
    r.ok
      ? reply(requestId, status, { mission: r.value })
      : refuse(requestId, r);

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const base = request.path === "/v1/admin/org/missions";
    const one = new RegExp(
      `^/v1/admin/org/missions/(${ID})(?:/([a-z]+))?$`,
      "u",
    ).exec(request.path);
    if (!base && !one) return null;
    const requestId = `req_${randomUUID()}`;
    const op = one?.[2];
    if (one && op !== undefined && !MEMBER_OPS.has(op)) return null;
    const isRead =
      (base && request.method === "GET") ||
      (one &&
        (!op || op === "history" || op === "authorities") &&
        request.method === "GET");
    const permission: Permission = isRead
      ? "view:missions"
      : base
        ? "mission:create"
        : (PERMISSION_FOR[op ?? ""] ?? "mission:control");
    // Method/shape checks before authorization would leak routing; authorize first, then dispatch.
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (base && request.method === "POST") {
      const r = await service.create(caller, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, { mission: r.value })
        : refuse(requestId, r);
    }
    if (base && request.method === "GET") {
      const q = new URL(request.path + (request.query ?? ""), "http://x")
        .searchParams;
      const status = q.get("status") as MissionStatus | null;
      const limit = Number(q.get("limit") ?? 25);
      const list = await service.list(caller, {
        ...(status ? { status } : {}),
        limit: Number.isFinite(limit) ? limit : 25,
        ...(q.get("after") ? { after: q.get("after")! } : {}),
      });
      return reply(requestId, 200, {
        missions: list.missions,
        next: list.next,
      });
    }
    if (!one) return null;
    const id = one[1]!;
    if (request.method === "GET" && !op)
      return done(requestId, 200, await service.get(caller, id));
    if (request.method === "GET" && op === "authorities" && deps.authorities) {
      const a = await deps.authorities(caller, id);
      return a
        ? reply(requestId, 200, a)
        : refuse(requestId, { refusal: "NOT_FOUND" });
    }
    if (request.method === "GET" && op === "history") {
      const r = await service.history(caller, id);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (request.method !== "POST") return null;
    if (op === "revisions") {
      const r = await service.revise(caller, id, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, { mission: r.value })
        : refuse(requestId, r);
    }
    if (op === "approve")
      return done(
        requestId,
        200,
        await service.decide(caller, id, request.body, "APPROVE"),
      );
    if (op === "reject")
      return done(
        requestId,
        200,
        await service.decide(caller, id, request.body, "REJECT"),
      );
    if (
      op &&
      ["submit", "pause", "resume", "cancel", "revoke", "complete"].includes(op)
    )
      return done(
        requestId,
        200,
        await service.control(caller, id, request.body, op as "submit"),
      );
    return null;
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const base = request.path === "/v1/agent/missions";
    const one = new RegExp(
      `^/v1/agent/missions/(${ID})(?:/(revisions))?$`,
      "u",
    ).exec(request.path);
    if (!base && !one) return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (base && request.method === "GET")
      return reply(requestId, 200, {
        missions: await service.forAgent(caller),
      });
    if (one && !one[2] && request.method === "GET") {
      const [m] = await service.forAgent(caller, one[1]);
      return m
        ? reply(requestId, 200, { mission: m })
        : refuse(requestId, { refusal: "NOT_FOUND" });
    }
    if (one && one[2] === "revisions" && request.method === "POST") {
      if (await deps.paused(caller))
        return reply(requestId, 423, {
          reason: "ORGANIZATION_PAUSED",
          recoverable: true,
          humanSummary: "The organization is paused.",
          nextAction: "WAIT_FOR_RESUME",
        });
      // An agent may propose only on a mission it holds REQUEST_APPROVAL on; the result always waits for an owner.
      const gate = await service.authorizeCapability(
        caller,
        one[1]!,
        caller.id,
        "REQUEST_APPROVAL",
      );
      if (!gate.allowed)
        return refuse(requestId, {
          refusal: "NOT_ASSIGNED",
          detail: gate.reason,
        });
      const r = await service.revise(caller, one[1]!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 202, {
            mission: r.value,
            applied: r.value.applied,
          })
        : refuse(requestId, r);
    }
    return null;
  }

  return { member, agent };
}
