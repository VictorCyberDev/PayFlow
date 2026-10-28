import type { MerchantRisk } from "../domain.js";
import {
  GatewayAccessError,
  type ExternalAgentAccess,
} from "./access.js";
import {
  FinancialAuthorityGateway,
  GatewayActionRequestSchema,
  GatewayRequestError,
} from "./gateway.js";

export interface RestRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization?: string;
  readonly body?: unknown;
}

export interface RestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface GatewayRestDependencies {
  authenticate(authorization: string | undefined): Promise<ExternalAgentAccess>;
  trustedMerchantRisk(merchantId: string): Promise<MerchantRisk>;
  now(): string;
}

function response(status: number, requestId: string, body: unknown): RestResponse {
  return {
    status,
    headers: {
      "content-type": "application/json",
      "x-payflow-request-id": requestId,
      "cache-control": "no-store",
    },
    body,
  };
}

export function createGatewayRestHandler(
  gateway: FinancialAuthorityGateway,
  deps: GatewayRestDependencies,
) {
  return async (request: RestRequest): Promise<RestResponse> => {
    const requestId = `req_${crypto.randomUUID()}`;
    try {
      const access = await deps.authenticate(request.authorization);
      const now = deps.now();
      const authorityMatch = request.path.match(/^\/v1\/authorities\/([^/]+)$/u);
      if (request.method === "GET" && authorityMatch?.[1]) {
        const authority = await gateway.readAuthority(
          access,
          decodeURIComponent(authorityMatch[1]),
          now,
        );
        return response(200, requestId, { requestId, authority });
      }
      if (request.method === "POST" && request.path === "/v1/actions") {
        const parsed = GatewayActionRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return response(400, requestId, {
            requestId,
            error: { code: "REQUEST_MALFORMED", message: "Invalid action request." },
          });
        }
        const risk = await deps.trustedMerchantRisk(parsed.data.merchant.id);
        const result = await gateway.requestAction(access, parsed.data, {
          now,
          merchantRisk: risk,
        });
        return response(200, requestId, result);
      }
      return response(404, requestId, {
        requestId,
        error: { code: "ROUTE_NOT_FOUND", message: "Route not found." },
      });
    } catch (error) {
      if (error instanceof GatewayAccessError) {
        return response(403, requestId, {
          requestId,
          error: { code: error.code, message: "Agent access denied." },
        });
      }
      if (error instanceof GatewayRequestError) {
        const status = error.code.endsWith("NOT_FOUND") ? 404 : 403;
        return response(status, requestId, {
          requestId,
          error: { code: error.code, message: "Financial authority request denied." },
        });
      }
      return response(500, requestId, {
        requestId,
        error: { code: "INTERNAL_ERROR", message: "Request could not be completed." },
      });
    }
  };
}
