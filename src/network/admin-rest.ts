import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { CredentialStore } from "./credentials.js";
import type { RestRequest, RestResponse } from "./rest.js";

export interface AdminContext {
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
}

export class AdminAuthError extends Error {
  constructor() {
    super("ADMIN_AUTH_REQUIRED");
  }
}

/**
 * Authenticates the administrative caller against a configured secret. The secret is compared by
 * digest in constant time and is never logged or echoed. Binds the caller to one tenant and
 * environment, so an administrator cannot issue or revoke credentials for another tenant.
 */
export function staticAdminAuthenticator(config: {
  readonly token: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
}) {
  const expected = createHash("sha256").update(config.token).digest();
  return (authorization: string | undefined): AdminContext => {
    const presented = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const actual = createHash("sha256").update(presented).digest();
    if (!presented || !timingSafeEqual(actual, expected))
      throw new AdminAuthError();
    return {
      organizationId: config.organizationId,
      environment: config.environment,
    };
  };
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

export function createCredentialAdminHandler(
  store: CredentialStore,
  deps: {
    authenticateAdmin(authorization: string | undefined): AdminContext;
    now(): string;
  },
) {
  return async (request: RestRequest): Promise<RestResponse> => {
    const requestId = `req_${crypto.randomUUID()}`;
    try {
      const admin = deps.authenticateAdmin(request.authorization);
      const now = deps.now();
      if (
        request.method === "POST" &&
        request.path === "/v1/admin/credentials"
      ) {
        const { token, credential } = await store.issue(
          {
            ...(request.body as object),
            organizationId: admin.organizationId,
            environment: admin.environment,
          },
          now,
        );
        return json(201, requestId, {
          requestId,
          credential,
          // Shown exactly once. PayFlow stores only a digest and cannot show it again.
          token,
          notice: "Store this token now. It cannot be retrieved again.",
        });
      }
      if (
        request.method === "GET" &&
        request.path === "/v1/admin/credentials"
      ) {
        return json(200, requestId, {
          requestId,
          credentials: await store.list(
            admin.organizationId,
            admin.environment,
          ),
        });
      }
      const revoke = request.path.match(
        /^\/v1\/admin\/credentials\/(pfc_[a-f0-9]{24})\/revoke$/u,
      );
      if (request.method === "POST" && revoke?.[1]) {
        const result = await store.revoke(
          admin.organizationId,
          admin.environment,
          revoke[1],
          now,
        );
        return json(result === "REVOKED" ? 200 : 404, requestId, {
          requestId,
          result,
        });
      }
      return json(404, requestId, { requestId, reason: "ROUTE_NOT_FOUND" });
    } catch (error) {
      if (error instanceof AdminAuthError)
        return json(401, requestId, {
          requestId,
          reason: "ADMIN_AUTH_REQUIRED",
          nextAction: "USE_ADMIN_CREDENTIAL",
        });
      if (
        error instanceof ZodError ||
        (error as Error).message === "AGENT_NOT_FOUND"
      )
        return json(400, requestId, {
          requestId,
          reason: "REQUEST_MALFORMED",
          nextAction: "FIX_REQUEST",
        });
      return json(500, requestId, { requestId, reason: "INTERNAL_ERROR" });
    }
  };
}
