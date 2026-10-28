import { z } from "zod";

export const GatewayScopeSchema = z.enum([
  "authority:read",
  "action:request",
  "verify:read",
  "proof:read",
  "reconcile:request",
]);
export type GatewayScope = z.infer<typeof GatewayScopeSchema>;

export const ExternalAgentAccessSchema = z
  .object({
    clientId: z.string().min(1),
    agentId: z.string().min(1),
    principalId: z.string().min(1),
    audience: z.string().min(1),
    scopes: z.array(GatewayScopeSchema).min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
  })
  .strict();
export type ExternalAgentAccess = Readonly<
  z.infer<typeof ExternalAgentAccessSchema>
>;

export class GatewayAccessError extends Error {
  readonly code:
    | "ACCESS_MALFORMED"
    | "ACCESS_INACTIVE"
    | "ACCESS_EXPIRED"
    | "ACCESS_WRONG_AUDIENCE"
    | "ACCESS_SCOPE_DENIED";

  constructor(code: GatewayAccessError["code"]) {
    super(code);
    this.name = "GatewayAccessError";
    this.code = code;
  }
}

export function requireAgentAccess(
  raw: unknown,
  requiredScope: GatewayScope,
  now: string,
  audience: string,
): ExternalAgentAccess {
  const parsed = ExternalAgentAccessSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(Date.parse(now))) {
    throw new GatewayAccessError("ACCESS_MALFORMED");
  }
  const access = parsed.data;
  if (access.status !== "ACTIVE") {
    throw new GatewayAccessError("ACCESS_INACTIVE");
  }
  const at = Date.parse(now);
  if (at < Date.parse(access.issuedAt) || at >= Date.parse(access.expiresAt)) {
    throw new GatewayAccessError("ACCESS_EXPIRED");
  }
  if (access.audience !== audience) {
    throw new GatewayAccessError("ACCESS_WRONG_AUDIENCE");
  }
  if (!access.scopes.includes(requiredScope)) {
    throw new GatewayAccessError("ACCESS_SCOPE_DENIED");
  }
  return access;
}

/**
 * Adapter for OAuth/OIDC-style claims. Authentication and token signature
 * verification happen upstream; this function only normalizes already-trusted
 * claims into PayFlow's bounded access model.
 */
export function accessFromTrustedOAuthClaims(raw: unknown): ExternalAgentAccess {
  const ClaimsSchema = z
    .object({
      client_id: z.string().min(1),
      sub: z.string().min(1),
      principal_id: z.string().min(1),
      aud: z.string().min(1),
      scope: z.string().min(1),
      iat: z.number().int().safe().nonnegative(),
      exp: z.number().int().safe().positive(),
    })
    .passthrough();
  const claims = ClaimsSchema.parse(raw);
  const scopes = claims.scope
    .split(/\s+/u)
    .filter(Boolean)
    .map((scope) => GatewayScopeSchema.parse(scope));
  return ExternalAgentAccessSchema.parse({
    clientId: claims.client_id,
    agentId: claims.sub,
    principalId: claims.principal_id,
    audience: claims.aud,
    scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    status: "ACTIVE",
  });
}
