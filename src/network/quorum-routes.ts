import { randomUUID } from "node:crypto";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { QuorumService } from "../missions/quorum-service.js";

/** Read and set the organization's approval quorum. Setting it is a member-management decision, so it needs `member:manage`. */
export interface QuorumRouteDeps {
  readonly service: QuorumService;
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
}

export function createQuorumRoutes(deps: QuorumRouteDeps) {
  const { service, reply } = deps;
  async function member(request: RestRequest): Promise<RestResponse | null> {
    if (request.path !== "/v1/admin/org/quorum-policy") return null;
    if (request.method !== "GET" && request.method !== "POST") return null;
    const requestId = `req_${randomUUID()}`;
    const read = request.method === "GET";
    const gate = await deps.authorize(
      requestId,
      request,
      read ? "view:missions" : "member:manage",
    );
    if (!("member" in gate)) return gate;
    const tenant = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
    };
    if (read)
      return reply(requestId, 200, { policy: await service.getPolicy(tenant) });
    const raw = (request.body as { policy?: unknown } | undefined)?.policy;
    if (raw === undefined)
      return reply(requestId, 400, {
        reason: "MALFORMED",
        recoverable: true,
        humanSummary: "Send a policy, or null to remove it.",
        nextAction: "FIX_THE_REQUEST",
      });
    const r = await service.setPolicy(tenant, raw, gate.member.memberId);
    return r.ok
      ? reply(requestId, 200, { policy: await service.getPolicy(tenant) })
      : reply(requestId, 400, {
          reason: "MALFORMED",
          recoverable: true,
          humanSummary:
            "That policy is not valid: each tier needs a distinct threshold, 1 to 10 approvals and at least one role.",
          nextAction: "FIX_THE_REQUEST",
        });
  }
  return { member };
}
