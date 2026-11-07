import { createHash, randomBytes } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JSONWebKeySet,
} from "jose";
import type { Sql } from "postgres";
import {
  GatewayScopeSchema,
  type ExternalAgentAccess,
} from "../network/access.js";
import type { ProtocolAuthenticator } from "./http-auth.js";

/**
 * OAuth resource-server authentication for PayFlow's MCP surface.
 *
 * PayFlow does NOT issue OAuth tokens (see docs/chatgpt/OAUTH-PROVIDER-EVALUATION.md). An external, proven identity provider
 * does; PayFlow only decides whether to accept a token it presents, and what that token may act as:
 *
 *   - the token's `iss` must equal the one configured issuer EXACTLY (no prefix, case or trailing-slash tolerance);
 *   - its `aud` must contain this resource's canonical identifier (RFC 8707 / RFC 9728), so a token minted for another
 *     resource is useless here;
 *   - signature algorithms are an allowlist (never `none`, never HMAC with a public key as secret); keys come from the
 *     configured JWKS, never from the token;
 *   - exp, iat and sub are required; a token from the future or past its expiry is refused;
 *   - tenant, environment, agent, principal and the MAXIMUM scopes come from `oauth_identity_mappings`, set by an
 *     authorized member. Nothing about tenancy or authority is read from token claims. The token's scope can only NARROW
 *     what the mapping allows;
 *   - a mapped agent that is no longer ACTIVE/REGISTERED in its tenant is refused;
 *   - every failure returns `null` (HTTP 401) without saying which check failed.
 */
export interface OAuthResourceConfig {
  /** Exact `iss` value of the authorization server. */
  readonly issuer: string;
  /** This resource's canonical identifier: the value ChatGPT sends as the `resource` parameter. */
  readonly resource: string;
  /** Production: `createRemoteJWKSet`. Tests may pass a local JWKS. Never derived from a token. */
  readonly keys: JWTVerifyGetKey;
  readonly sql: Sql;
  /** The audience the Gateway expects on the access it builds. Defaults to `resource`. */
  readonly accessAudience?: string;
  readonly now?: () => number;
}

export const remoteKeys = (jwksUrl: string): JWTVerifyGetKey => {
  if (new URL(jwksUrl).protocol !== "https:")
    throw new Error("OAUTH_HTTPS_REQUIRED");
  return createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 3000,
    cooldownDuration: 30_000,
  });
};
export const localKeys = (jwks: JSONWebKeySet): JWTVerifyGetKey =>
  createLocalJWKSet(jwks);

export function createTenantOAuthAuthenticator(
  config: OAuthResourceConfig,
): ProtocolAuthenticator {
  for (const v of [config.issuer, config.resource]) {
    const u = new URL(v);
    if (
      u.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(u.hostname)
    )
      throw new Error("OAUTH_HTTPS_REQUIRED");
  }
  return async (request) => {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, config.keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "iat", "sub"],
        ...(config.now ? { currentDate: new Date(config.now()) } : {}),
      });
      // jose does not reject a token issued in the future; a small skew is the only tolerance.
      const nowMs = config.now ? config.now() : Date.now();
      if (Number(payload.iat) * 1000 > nowMs + 60_000) return null;
      const subject = String(payload.sub);
      const [m] = await config.sql`
        select m.mapping_id, m.organization_id, m.environment, m.agent_id, m.max_scopes,
               a.sponsor_principal_id, a.lifecycle
        from oauth_identity_mappings m
        join organization_agents a
          on a.organization_id = m.organization_id and a.environment = m.environment and a.agent_id = m.agent_id
        where m.issuer = ${config.issuer} and m.subject = ${subject} and m.status = 'ACTIVE'`;
      if (
        !m ||
        ["SUSPENDED", "REVOKED", "RETIRED"].includes(String(m.lifecycle))
      )
        return null;
      const allowed = new Set(m.max_scopes as string[]);
      const requested =
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/u).filter(Boolean)
          : [];
      // The token can only narrow: unknown scopes and scopes beyond the mapping are dropped, never honoured.
      const scopes = requested.filter(
        (s) => GatewayScopeSchema.safeParse(s).success && allowed.has(s),
      );
      if (scopes.length === 0) return null;
      const at = (n: unknown) => new Date(Number(n) * 1000).toISOString();
      const access: ExternalAgentAccess = {
        // Bound to the mapping, not to a client-chosen id, so rate limits and audit attribute to one identity.
        clientId: String(m.mapping_id),
        agentId: String(m.agent_id),
        principalId: String(m.sponsor_principal_id),
        audience: config.accessAudience ?? config.resource,
        scopes: scopes as ExternalAgentAccess["scopes"],
        issuedAt: at(payload.iat),
        expiresAt: at(payload.exp),
        status: "ACTIVE",
      };
      return { subject: access.agentId, scopes: access.scopes, access };
    } catch {
      return null;
    }
  };
}

export interface IdentityMappingRecord {
  readonly mappingId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly agentId: string;
  readonly maxScopes: readonly string[];
  readonly status: "ACTIVE" | "REVOKED";
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Tenant-owned management of who an external identity acts as. Every query is scoped to the caller's tenant. */
export class OAuthIdentityMappings {
  constructor(private readonly sql: Sql) {}

  async create(
    tenant: { organizationId: string; environment: "SANDBOX" | "PRODUCTION" },
    createdBy: string,
    issuer: string,
    input: { subject: string; agentId: string; maxScopes: readonly string[] },
    now: string,
  ): Promise<
    | { ok: true; mapping: IdentityMappingRecord }
    | {
        ok: false;
        reason:
          "MALFORMED" | "AGENT_NOT_IN_ORGANIZATION" | "IDENTITY_ALREADY_MAPPED";
      }
  > {
    const scopes = [...new Set(input.maxScopes)];
    if (
      !input.subject ||
      input.subject.length > 300 ||
      scopes.length === 0 ||
      !scopes.every((s) => GatewayScopeSchema.safeParse(s).success)
    )
      return { ok: false, reason: "MALFORMED" };
    const [agent] = await this.sql`
      select 1 from organization_agents
      where organization_id = ${tenant.organizationId} and environment = ${tenant.environment} and agent_id = ${input.agentId}
        and lifecycle not in ('SUSPENDED','REVOKED','RETIRED')`;
    if (!agent) return { ok: false, reason: "AGENT_NOT_IN_ORGANIZATION" };
    const id = `oim_${randomBytes(12).toString("hex")}`;
    const rows = await this.sql`
      insert into oauth_identity_mappings
        (mapping_id, issuer, subject, organization_id, environment, agent_id, max_scopes, created_by, created_at)
      values (${id}, ${issuer}, ${input.subject}, ${tenant.organizationId}, ${tenant.environment}, ${input.agentId},
              ${scopes}, ${createdBy}, ${now})
      on conflict do nothing
      returning *`;
    if (!rows[0]) return { ok: false, reason: "IDENTITY_ALREADY_MAPPED" };
    return { ok: true, mapping: toRecord(rows[0]) };
  }

  async list(tenant: {
    organizationId: string;
    environment: "SANDBOX" | "PRODUCTION";
  }): Promise<readonly IdentityMappingRecord[]> {
    const rows = await this.sql`
      select * from oauth_identity_mappings
      where organization_id = ${tenant.organizationId} and environment = ${tenant.environment}
      order by created_at, mapping_id`;
    return rows.map(toRecord);
  }

  async revoke(
    tenant: { organizationId: string; environment: "SANDBOX" | "PRODUCTION" },
    mappingId: string,
    now: string,
  ): Promise<{ found: boolean; alreadyRevoked: boolean }> {
    const rows = await this.sql`
      update oauth_identity_mappings set status = 'REVOKED', revoked_at = ${now}
      where mapping_id = ${mappingId} and organization_id = ${tenant.organizationId}
        and environment = ${tenant.environment} and status = 'ACTIVE'
      returning mapping_id`;
    if (rows.length === 1) return { found: true, alreadyRevoked: false };
    const [exists] = await this.sql`
      select 1 from oauth_identity_mappings where mapping_id = ${mappingId}
        and organization_id = ${tenant.organizationId} and environment = ${tenant.environment}`;
    return { found: !!exists, alreadyRevoked: !!exists };
  }
}

const toRecord = (r: Record<string, unknown>): IdentityMappingRecord => ({
  mappingId: String(r.mapping_id),
  issuer: String(r.issuer),
  subject: String(r.subject),
  organizationId: String(r.organization_id),
  environment: r.environment as IdentityMappingRecord["environment"],
  agentId: String(r.agent_id),
  maxScopes: r.max_scopes as string[],
  status: r.status as IdentityMappingRecord["status"],
  createdBy: String(r.created_by),
  createdAt: new Date(r.created_at as string).toISOString(),
});

/** A stable digest for logs: never log a raw subject or token. */
export const subjectDigest = (issuer: string, subject: string) =>
  createHash("sha256")
    .update(`${issuer}\n${subject}`)
    .digest("hex")
    .slice(0, 16);
