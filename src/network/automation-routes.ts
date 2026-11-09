import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RestRequest, RestResponse } from "./rest.js";
import type { Member, Permission } from "./rbac.js";
import type { AutomationService } from "../automation/automation-service.js";

/**
 * Member view of automation: what ran on their behalf, and the one decision only a person can make: settling a job whose outcome PayFlow could
 * not see. Tenant and identity come from the authenticated member, never the path or body.
 */
export interface AutomationRouteDeps {
  readonly service: AutomationService;
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
const Settle = z
  .object({
    outcome: z.enum(["SUCCEEDED", "FAILED"]),
    note: z.string().trim().min(1).max(300),
  })
  .strict();
const JID = "job_[a-f0-9]{24}";

export function createAutomationRoutes(deps: AutomationRouteDeps) {
  const { service, reply } = deps;
  async function member(request: RestRequest): Promise<RestResponse | null> {
    const list = request.path === "/v1/admin/org/automation/jobs";
    const settle = new RegExp(
      `^/v1/admin/org/automation/jobs/(${JID})/settle$`,
      "u",
    ).exec(request.path);
    if (!list && !settle) return null;
    if (list && request.method !== "GET") return null;
    if (settle && request.method !== "POST") return null;
    const requestId = `req_${randomUUID()}`;
    const gate = await deps.authorize(
      requestId,
      request,
      list ? "view:missions" : "mission:control",
    );
    if (!("member" in gate)) return gate;
    const tenant = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
    };
    if (list)
      return reply(requestId, 200, {
        jobs: await service.list(tenant),
        notice:
          "A job with an unclear outcome is never run again by PayFlow. Only you can settle it, with what you know.",
      });
    const b = Settle.safeParse(request.body);
    if (!b.success)
      return reply(requestId, 400, {
        reason: "MALFORMED",
        recoverable: true,
        humanSummary: "Say what happened and add a short note.",
        nextAction: "FIX_THE_REQUEST",
      });
    const ok = await service.settle(
      tenant,
      settle![1]!,
      b.data.outcome,
      gate.member.memberId,
      b.data.note,
    );
    return ok
      ? reply(requestId, 200, { jobId: settle![1]!, state: b.data.outcome })
      : reply(requestId, 404, {
          reason: "NOT_FOUND",
          recoverable: false,
          humanSummary:
            "There is no unclear job with that id for your organization.",
          nextAction: "RELOAD_THE_LIST",
        });
  }
  return { member };
}
