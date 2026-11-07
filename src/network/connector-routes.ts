import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { MissionCaller } from "../missions/service.js";
import type {
  ConnectorRefusal,
  ConnectorService,
  CResult,
} from "../missions/connector-service.js";

/** HTTP surface of connectors. Tenant and identity come from the authenticated caller, never the path or body. */
export interface ConnectorRouteDeps {
  readonly service: ConnectorService;
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
const STATUS: Record<ConnectorRefusal, number> = {
  MALFORMED: 400,
  NOT_FOUND: 404,
  CONNECTOR_NOT_FOUND: 404,
  CAPABILITY_NOT_OBSERVABLE: 403,
  CAPABILITY_REFUSED: 403,
  PROVIDER_TYPE_NOT_APPROVED: 403,
  CONNECTOR_NOT_INSTALLED: 409,
  CONNECTOR_DISABLED: 409,
  CONNECTOR_SUSPENDED: 423,
  CREDENTIAL_REQUIRED: 409,
  ENVIRONMENT_MISMATCH: 409,
  CONNECTOR_DEGRADED: 503,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REUSED: 409,
  CALL_IN_PROGRESS: 409,
  CONNECTOR_FAILED: 502,
  CONNECTOR_TIMEOUT: 504,
  CONNECTOR_INVALID_OUTPUT: 502,
  AGENT_ONLY: 403,
  MEMBER_ONLY: 403,
};
const MID = "msn_[a-f0-9]{24}";
const CID = "[a-z0-9][a-z0-9._-]{0,62}";

export function createConnectorRoutes(deps: ConnectorRouteDeps) {
  const { service, reply } = deps;
  const refuse = (
    requestId: string,
    r: Extract<CResult<unknown>, { ok: false }>,
  ) =>
    reply(requestId, STATUS[r.refusal], {
      reason: r.refusal,
      ...(r.detail ? { detail: r.detail } : {}),
      recoverable: [
        "MALFORMED",
        "RATE_LIMITED",
        "CONNECTOR_DEGRADED",
        "CALL_IN_PROGRESS",
      ].includes(r.refusal),
      humanSummary:
        "Nothing was fetched or changed beyond what is recorded. Connectors only observe, and only inside the mission's rules.",
      nextAction:
        r.refusal === "RATE_LIMITED" || r.refusal === "CONNECTOR_DEGRADED"
          ? "WAIT_AND_RETRY_WITH_A_NEW_IDEMPOTENCY_KEY"
          : "CHECK_THE_MISSION_AND_CONNECTOR_SETTINGS",
    });

  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = request.path === "/v1/admin/org/connectors";
    const calls = request.path === "/v1/admin/org/connector-calls";
    const op = new RegExp(
      `^/v1/admin/org/connectors/(${CID})/(install|enable|disable|suspend)$`,
      "u",
    ).exec(request.path);
    if (!list && !calls && !op) return null;
    const requestId = `req_${randomUUID()}`;
    const read = request.method === "GET";
    if ((list || calls) && !read) return null;
    if (op && request.method !== "POST") return null;
    const permission: Permission = read
      ? "view:missions"
      : op![2] === "suspend"
        ? "connector:contain"
        : "connector:manage";
    const gate = await deps.authorize(requestId, request, permission);
    if (!("member" in gate)) return gate;
    const caller: MissionCaller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (list)
      return reply(requestId, 200, {
        connectors: await service.catalog(caller),
      });
    if (calls) {
      const q = new URL(request.path + (request.query ?? ""), "http://x")
        .searchParams;
      const limit = Number(q.get("limit") ?? 50);
      const m = q.get("missionId");
      return reply(requestId, 200, {
        calls: await service.calls(caller, {
          ...(m && new RegExp(`^${MID}$`, "u").test(m) ? { missionId: m } : {}),
          limit: Number.isFinite(limit) ? limit : 50,
        }),
      });
    }
    const [, id, what] = op!;
    if (what === "install") {
      const r = await service.install(caller, id!, request.body);
      return r.ok
        ? reply(requestId, r.value.replayed ? 200 : 201, r.value)
        : refuse(requestId, r);
    }
    const r = await service.setState(
      caller,
      id!,
      what as "enable" | "disable" | "suspend",
      request.body,
    );
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }

  async function agent(request: RestRequest): Promise<RestResponse | null> {
    const list = request.path === "/v1/agent/connectors";
    const invoke = new RegExp(
      `^/v1/agent/missions/(${MID})/connectors/invoke$`,
      "u",
    ).exec(request.path);
    if (!list && !invoke) return null;
    if (list && request.method !== "GET") return null;
    if (invoke && request.method !== "POST") return null;
    const requestId = `req_${randomUUID()}`;
    const caller = await deps.agent(request);
    if (!caller)
      return reply(requestId, 401, {
        reason: "AGENT_AUTH_REQUIRED",
        recoverable: false,
        humanSummary: "A valid agent credential is required.",
        nextAction: "PRESENT_AGENT_CREDENTIAL",
      });
    if (invoke && (await deps.paused(caller)))
      return reply(requestId, 423, {
        reason: "ORGANIZATION_PAUSED",
        recoverable: true,
        humanSummary: "The organization is paused.",
        nextAction: "WAIT_FOR_RESUME",
      });
    if (list) {
      // An agent learns what exists and what is usable; it does not see installation details.
      const all = await service.catalog(caller);
      return reply(requestId, 200, {
        connectors: all.map((c) => ({
          connectorId: c.connectorId,
          displayName: c.displayName,
          providerTypes: c.providerTypes,
          mode: c.mode,
          capabilities: c.capabilities,
          dataUse: c.dataUse,
          status: c.status,
        })),
      });
    }
    const r = await service.invoke(caller, invoke![1]!, request.body);
    return r.ok ? reply(requestId, 200, r.value) : refuse(requestId, r);
  }
  return { member, agent };
}
