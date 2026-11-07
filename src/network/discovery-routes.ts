import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type { CResult } from "../missions/connector-service.js";
import { CONNECTOR_STATUS } from "./connector-routes.js";
import type { DiscoveryService } from "../missions/discovery-service.js";
import {
  RequirementsSchema,
  type Requirements,
} from "../missions/discovery.js";

/** HTTP surface of product discovery. Tenant and identity come from the authenticated caller, never the path or body. */
export interface DiscoveryRouteDeps {
  readonly service: DiscoveryService;
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
const CID = "cnd_[a-f0-9]{24}";

/** ?maxUnitPriceMinor=&currency=&minQuantity=&maxAgeMinutes=&claim.condition=NEW ... */
export function requirementsFromQuery(
  query: string | undefined,
): Requirements | null {
  const q = new URL("http://x/?" + (query ?? "").replace(/^\?/u, ""))
    .searchParams;
  const raw: Record<string, unknown> = {};
  for (const k of ["maxUnitPriceMinor", "minQuantity", "maxAgeMinutes"])
    if (q.has(k)) raw[k] = Number(q.get(k));
  if (q.has("currency")) raw["currency"] = q.get("currency");
  const claims: Record<string, string | number | boolean> = {};
  for (const [k, v] of q.entries())
    if (k.startsWith("claim.")) claims[k.slice(6)] = v;
  if (Object.keys(claims).length) raw["claims"] = claims;
  const parsed = RequirementsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createDiscoveryRoutes(deps: DiscoveryRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<CResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, CONNECTOR_STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "RATE_LIMITED",
        "CONNECTOR_DEGRADED",
        "CALL_IN_PROGRESS",
      ].includes(r.refusal),
      humanSummary:
        "Nothing was changed. Discovery only observes and records; it never quotes, approves or commits.",
      nextAction: "CHECK_THE_MISSION_AND_REQUEST",
    });

  async function serve(
    requestId: string,
    caller: MissionCaller,
    method: string,
    kind: "list" | "compare" | "mark" | "search",
    ids: { mission?: string; candidate?: string },
    request: RestRequest,
  ): Promise<RestResponse | null> {
    if (kind === "search") {
      if (method !== "POST") return null;
      const r = await service.search(caller, ids.mission!, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (kind === "list") {
      if (method !== "GET") return null;
      const g = await service.gate(caller, ids.mission!, "READ");
      if (!g.ok) return refuse(requestId, g);
      const req = requirementsFromQuery(request.query);
      if (!req)
        return refuse(requestId, {
          ok: false,
          refusal: "MALFORMED",
          detail: "requirements",
        });
      const r = await service.list(caller, ids.mission!, req);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (kind === "compare") {
      if (method !== "POST") return null;
      const g = await service.gate(caller, ids.mission!, "COMPARE");
      if (!g.ok) return refuse(requestId, g);
      const r = await service.compare(caller, ids.mission!, request.body);
      return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
    }
    if (method !== "POST") return null;
    const r = await service.mark(caller, ids.candidate!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = new RegExp(
      `^/v1/admin/org/missions/(${MID})/candidates$`,
      "u",
    ).exec(request.path);
    const cmp = new RegExp(
      `^/v1/admin/org/missions/(${MID})/candidates/compare$`,
      "u",
    ).exec(request.path);
    const mark = new RegExp(
      `^/v1/admin/org/candidates/(${CID})/mark$`,
      "u",
    ).exec(request.path);
    if (!list && !cmp && !mark) return null;
    const requestId = `req_${randomUUID()}`;
    const permission: Permission = mark ? "mission:plan" : "view:missions";
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    return serve(
      requestId,
      caller,
      request.method,
      mark ? "mark" : cmp ? "compare" : "list",
      {
        ...(list || cmp ? { mission: (list ?? cmp)![1]! } : {}),
        ...(mark ? { candidate: mark[1]! } : {}),
      },
      request,
    );
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const search = new RegExp(
      `^/v1/agent/missions/(${MID})/discovery/search$`,
      "u",
    ).exec(request.path);
    const list = new RegExp(
      `^/v1/agent/missions/(${MID})/candidates$`,
      "u",
    ).exec(request.path);
    const cmp = new RegExp(
      `^/v1/agent/missions/(${MID})/candidates/compare$`,
      "u",
    ).exec(request.path);
    const mark = new RegExp(`^/v1/agent/candidates/(${CID})/mark$`, "u").exec(
      request.path,
    );
    if (!search && !list && !cmp && !mark) return null;
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
    const m = search ?? list ?? cmp;
    return serve(
      requestId,
      caller,
      request.method,
      search ? "search" : cmp ? "compare" : list ? "list" : "mark",
      {
        ...(m ? { mission: m[1]! } : {}),
        ...(mark ? { candidate: mark[1]! } : {}),
      },
      request,
    );
  }
  return { member, agent };
}
