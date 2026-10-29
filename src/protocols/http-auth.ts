import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  ExternalAgentAccessSchema,
  type ExternalAgentAccess,
} from "../network/access.js";

export interface ProtocolIdentity {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly access: ExternalAgentAccess;
}
export type ProtocolAuthenticator = (
  request: Request,
) => Promise<ProtocolIdentity | null>;

/** Fixed issuer/JWKS/audience configuration; no key URL is taken from an untrusted JWT. */
export function createOAuthAuthenticator(config: {
  issuer: string;
  jwksUrl: string;
  audience: string;
}): ProtocolAuthenticator {
  if (
    ![config.issuer, config.jwksUrl, config.audience].every(
      (value) => new URL(value).protocol === "https:",
    )
  )
    throw new Error("OAUTH_HTTPS_REQUIRED");
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 3000,
  });
  return async (request) => {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "iat", "sub"],
      });
      const access = ExternalAgentAccessSchema.parse({
        clientId: payload.client_id,
        agentId: payload.sub,
        principalId: payload.principal_id,
        audience: config.audience,
        scopes:
          typeof payload.scope === "string"
            ? payload.scope.split(/\s+/).filter(Boolean)
            : [],
        issuedAt: new Date(Number(payload.iat) * 1000).toISOString(),
        expiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
        status: "ACTIVE",
      });
      if (Date.parse(access.issuedAt) > Date.now()) return null;
      return { subject: access.agentId, scopes: access.scopes, access };
    } catch {
      return null;
    }
  };
}

/** Local commissioning only. Credentials are server-owned, identity-bound, and never accepted in JSON arguments. */
export function createLocalTokenAuthenticator(
  entries: readonly { token: string; access: ExternalAgentAccess }[],
  now = () => Date.now(),
): ProtocolAuthenticator {
  const credentials = entries.map((entry) => {
    if (entry.token.length < 32) throw new Error("LOCAL_TOKEN_TOO_SHORT");
    return {
      digest: createHash("sha256").update(entry.token).digest(),
      access: ExternalAgentAccessSchema.parse(entry.access),
    };
  });
  return (request) => {
    const token =
      request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ??
      "";
    const digest = createHash("sha256").update(token).digest();
    const entry = credentials.find((item) =>
      timingSafeEqual(item.digest, digest),
    );
    if (
      !entry ||
      entry.access.status !== "ACTIVE" ||
      now() < Date.parse(entry.access.issuedAt) ||
      now() >= Date.parse(entry.access.expiresAt)
    )
      return Promise.resolve(null);
    return Promise.resolve({
      subject: entry.access.agentId,
      scopes: entry.access.scopes,
      access: entry.access,
    });
  };
}
