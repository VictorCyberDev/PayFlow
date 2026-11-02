import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
import {
  GatewayAccessError,
  GatewayScopeSchema,
  type ExternalAgentAccess,
} from "./access.js";
import { GATEWAY_AUDIENCE } from "./gateway.js";

/**
 * Developer-preview credential lifecycle. A credential is a bearer token
 * `pf_<env>_<credentialId>.<secret>`. Only the SHA-256 digest of the 256-bit secret is stored
 * (a high-entropy random secret needs no slow KDF). The secret is returned exactly once.
 * Principal is derived from the agent passport, never from the caller.
 */
export const CredentialIssueSchema = z
  .object({
    organizationId: z.string().min(1).max(128),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    agentId: z.string().min(1).max(128),
    scopes: z.array(GatewayScopeSchema).min(1).max(5),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(90 * 24 * 3600),
    label: z.string().max(128).default(""),
    audience: z.string().min(1).max(128).default(GATEWAY_AUDIENCE),
  })
  .strict();
export type CredentialIssue = z.input<typeof CredentialIssueSchema>;

export interface CredentialRecord {
  readonly credentialId: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly agentId: string;
  readonly principalId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly label: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

const digest = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

const iso = (v: unknown): string => new Date(String(v)).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

function toRecord(r: Record<string, unknown>): CredentialRecord {
  return Object.freeze({
    credentialId: String(r.credential_id),
    organizationId: String(r.organization_id),
    environment: r.environment as CredentialRecord["environment"],
    agentId: String(r.agent_id),
    principalId: String(r.principal_id),
    audience: String(r.audience),
    scopes: Object.freeze([...(r.scopes as readonly string[])]),
    label: String(r.label),
    status: r.status as CredentialRecord["status"],
    issuedAt: iso(r.issued_at),
    expiresAt: iso(r.expires_at),
    revokedAt: isoOrNull(r.revoked_at),
    lastUsedAt: isoOrNull(r.last_used_at),
  });
}

export class CredentialStore {
  constructor(private readonly sql: Sql) {}

  /** Returns the bearer token once. It cannot be recovered later. */
  async issue(
    raw: unknown,
    now: string,
  ): Promise<{ token: string; credential: CredentialRecord }> {
    const input = CredentialIssueSchema.parse(raw);
    const agents = await this.sql`
      select principal_id from agent_passports where id = ${input.agentId}`;
    const principalId: unknown = agents[0]?.principal_id;
    if (typeof principalId !== "string" || !principalId)
      throw new Error("AGENT_NOT_FOUND");
    const credentialId = `pfc_${randomBytes(12).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.parse(now) + input.ttlSeconds * 1000,
    ).toISOString();
    const rows = await this.sql`
      insert into agent_credentials
        (credential_id, secret_hash, organization_id, environment, agent_id, principal_id,
         audience, scopes, label, issued_at, expires_at)
      values (${credentialId}, ${digest(secret)}, ${input.organizationId}, ${input.environment},
        ${input.agentId}, ${principalId}, ${input.audience}, ${input.scopes},
        ${input.label}, ${now}, ${expiresAt})
      returning *`;
    const env = input.environment === "SANDBOX" ? "sbx" : "live";
    return {
      token: `pf_${env}_${credentialId}.${secret}`,
      credential: toRecord(rows[0]!),
    };
  }

  /** Never selects or returns the secret digest. */
  async list(
    organizationId: string,
    environment: "SANDBOX" | "PRODUCTION",
  ): Promise<CredentialRecord[]> {
    const rows = await this.sql`
      select credential_id, organization_id, environment, agent_id, principal_id, audience,
             scopes, label, status, issued_at, expires_at, revoked_at, last_used_at
      from agent_credentials
      where organization_id = ${organizationId} and environment = ${environment}
      order by issued_at desc, credential_id limit 200`;
    return rows.map((r) => toRecord(r));
  }

  /** Idempotent. Tenant/environment scoped: another tenant's id behaves as absent. */
  async revoke(
    organizationId: string,
    environment: "SANDBOX" | "PRODUCTION",
    credentialId: string,
    now: string,
  ): Promise<"REVOKED" | "NOT_FOUND"> {
    const rows = await this.sql`
      update agent_credentials
      set status = 'REVOKED', revoked_at = coalesce(revoked_at, ${now})
      where credential_id = ${credentialId} and organization_id = ${organizationId}
        and environment = ${environment}
      returning credential_id`;
    return rows.length ? "REVOKED" : "NOT_FOUND";
  }

  /**
   * Authenticates an Authorization header into the bounded access model. Every failure is the
   * same `ACCESS_INACTIVE`-class error so the caller cannot probe which part was wrong.
   */
  async authenticate(
    authorization: string | undefined,
    now: string,
  ): Promise<ExternalAgentAccess> {
    const match = authorization?.match(
      /^Bearer pf_(?:sbx|live)_(pfc_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/u,
    );
    if (!match) throw new GatewayAccessError("ACCESS_MALFORMED");
    const rows = await this.sql`
      select * from agent_credentials where credential_id = ${match[1]!}`;
    const row = rows[0];
    const presented = Buffer.from(digest(match[2]!), "hex");
    // Compare against a fixed-length value even when the row is absent.
    const stored = Buffer.from(
      row ? String(row.secret_hash) : "0".repeat(64),
      "hex",
    );
    if (!row || !timingSafeEqual(presented, stored))
      throw new GatewayAccessError("ACCESS_INACTIVE");
    const rec = toRecord(row);
    if (rec.status !== "ACTIVE")
      throw new GatewayAccessError("ACCESS_INACTIVE");
    if (Date.parse(now) >= Date.parse(rec.expiresAt))
      throw new GatewayAccessError("ACCESS_EXPIRED");
    // A suspended or revoked agent loses API access immediately, even with a live credential.
    const life = await this.sql`
      select lifecycle from organization_agents
      where organization_id = ${rec.organizationId} and environment = ${rec.environment}
        and agent_id = ${rec.agentId}`;
    const lifecycle = life[0]?.lifecycle as string | undefined;
    if (lifecycle && ["SUSPENDED", "REVOKED", "RETIRED"].includes(lifecycle))
      throw new GatewayAccessError("ACCESS_INACTIVE");
    await this.sql`
      update agent_credentials set last_used_at = ${now} where credential_id = ${rec.credentialId}`;
    return Object.freeze({
      clientId: rec.credentialId,
      agentId: rec.agentId,
      principalId: rec.principalId,
      audience: rec.audience,
      scopes: rec.scopes.map((s) => GatewayScopeSchema.parse(s)),
      issuedAt: rec.issuedAt,
      expiresAt: rec.expiresAt,
      status: "ACTIVE" as const,
    });
  }
}
