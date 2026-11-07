import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type { CResult } from "../missions/connector-service.js";
import { CONNECTOR_STATUS } from "./connector-routes.js";
import type { QualificationService } from "../missions/qualification-service.js";

/** HTTP surface of supplier qualification. Tenant and identity come from the authenticated caller, never the path or body. */
export interface QualificationRouteDeps {
  readonly service: QualificationService;
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
const MID = "msn_[a-f0-9]{24}";
const SID = "sup_[a-f0-9]{24}";

export function createQualificationRoutes(deps: QualificationRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<CResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, CONNECTOR_STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: r.refusal === "MALFORMED",
      humanSummary:
        "Nothing was changed. A supplier is qualified only by evidence a person has verified; agents can claim or report failures, not verify.",
      nextAction: "CHECK_THE_REQUEST_AND_EVIDENCE",
    });

  type Op = "list" | "add" | "policy" | "fact" | "history";
  async function serve(
    requestId: string,
    caller: MissionCaller,
    op: Op,
    id: string,
    request: RestRequest,
  ): Promise<RestResponse | null> {
    const post = request.method === "POST";
    const get = request.method === "GET";
    if (op === "list" && get) {
      const r = await service.list(caller, id);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (op === "add" && post) {
      const r = await service.addSupplier(caller, id, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (op === "policy" && post) {
      const r = await service.setPolicy(caller, id, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (op === "fact" && post) {
      const r = await service.recordFact(caller, id, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    if (op === "history" && get) {
      const h = await service.history(caller, id);
      return h
        ? reply(requestId, 200, { facts: h })
        : refuse(requestId, { ok: false, refusal: "NOT_FOUND" });
    }
    return null;
  }

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const sup = new RegExp(
      `^/v1/admin/org/missions/(${MID})/suppliers$`,
      "u",
    ).exec(request.path);
    const pol = new RegExp(
      `^/v1/admin/org/missions/(${MID})/qualification-policy$`,
      "u",
    ).exec(request.path);
    const fact = new RegExp(
      `^/v1/admin/org/suppliers/(${SID})/facts$`,
      "u",
    ).exec(request.path);
    if (!sup && !pol && !fact) return null;
    const requestId = `req_${randomUUID()}`;
    const read = request.method === "GET";
    const gate = await deps.authorize(
      requestId,
      request,
      read ? "view:missions" : "mission:plan",
    );
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (sup)
      return serve(requestId, caller, read ? "list" : "add", sup[1]!, request);
    if (pol) return serve(requestId, caller, "policy", pol[1]!, request);
    return serve(
      requestId,
      caller,
      read ? "history" : "fact",
      fact![1]!,
      request,
    );
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const sup = new RegExp(`^/v1/agent/missions/(${MID})/suppliers$`, "u").exec(
      request.path,
    );
    const fact = new RegExp(`^/v1/agent/suppliers/(${SID})/facts$`, "u").exec(
      request.path,
    );
    if (!sup && !fact) return null;
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
    if (sup)
      return serve(
        requestId,
        caller,
        request.method === "GET" ? "list" : "add",
        sup[1]!,
        request,
      );
    return serve(requestId, caller, "fact", fact![1]!, request);
  }
  return { member, agent };
}
