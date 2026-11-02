import { GatewayAccessError, type ExternalAgentAccess } from "./access.js";
import { GatewayRequestError } from "./gateway.js";
import type { ExecutingGateway } from "./gateway-execution.js";
import type { RestRequest, RestResponse } from "./rest.js";

export interface ExecutingRestDependencies {
  authenticate(authorization: string | undefined): Promise<ExternalAgentAccess>;
}

const json = (
  status: number,
  requestId: string,
  body: unknown,
): RestResponse => ({
  status,
  headers: {
    "content-type": "application/json",
    "x-payflow-request-id": requestId,
    "cache-control": "no-store",
  },
  body,
});

/**
 * POST /v1/actions/execute — the protocol adapter for real execution. It only translates HTTP
 * into the canonical Gateway request; every decision happens in the one Authority path.
 * Failures return a structured, actionable body, never a bare status code.
 */
export function createExecutingRestHandler(
  gateway: ExecutingGateway,
  deps: ExecutingRestDependencies,
) {
  return async (request: RestRequest): Promise<RestResponse> => {
    const requestId = `req_${crypto.randomUUID()}`;
    if (request.method !== "POST" || request.path !== "/v1/actions/execute")
      return json(404, requestId, {
        requestId,
        decision: "DENY",
        reason: "ROUTE_NOT_FOUND",
        recoverable: false,
        humanSummary: "That route does not exist.",
        nextAction: "CHECK_DOCUMENTATION",
      });
    try {
      const access = await deps.authenticate(request.authorization);
      const result = await gateway.requestPurchase(access, request.body);
      return json(200, requestId, result);
    } catch (error) {
      if (error instanceof GatewayAccessError)
        return json(
          error.code === "ACCESS_SCOPE_DENIED" ? 403 : 401,
          requestId,
          {
            requestId,
            decision: "DENY",
            effectCount: 0,
            reason: error.code,
            recoverable: false,
            humanSummary: "This credential cannot make this request. $0 moved.",
            nextAction: "USE_A_VALID_CREDENTIAL",
          },
        );
      if (error instanceof GatewayRequestError) {
        const malformed = error.code === "REQUEST_MALFORMED";
        return json(
          malformed ? 400 : error.code.endsWith("NOT_FOUND") ? 404 : 403,
          requestId,
          {
            requestId,
            decision: "DENY",
            effectCount: 0,
            reason: error.code,
            recoverable: malformed,
            humanSummary: malformed
              ? "The request is not valid. $0 moved."
              : "This credential does not match that Authority. $0 moved.",
            nextAction: malformed
              ? "FIX_REQUEST_AND_RETRY_WITH_NEW_NONCE"
              : "USE_THE_AGENT_CREDENTIAL_FOR_THIS_AUTHORITY",
          },
        );
      }
      // Unknown failure after a request was accepted: do not claim zero effect.
      return json(500, requestId, {
        requestId,
        decision: "DENY",
        effectCount: null,
        reason: "INTERNAL_ERROR",
        recoverable: false,
        doNotRetry: true,
        humanSummary:
          "We couldn't complete this request. If a payment was started we're confirming whether money moved.",
        nextAction: "DO_NOT_RETRY_CHECK_PROOF",
      });
    }
  };
}
