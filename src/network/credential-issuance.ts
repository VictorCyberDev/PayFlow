import {
  createHash,
  randomBytes,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { mandateFingerprint } from "../canonical.js";
import type { PostgresTrustRepository } from "../persistence.js";
import {
  buildStatusList,
  CREDENTIAL_VERSION,
  issueCredential,
  type Credential,
  type RootClaims,
  type StatusList,
} from "../../packages/verifier/src/authority.js";
import type { AuditLog, Environment } from "./ops-controls.js";

/**
 * Issuing a portable Authority credential from a STORED Gateway Authority.
 *
 * Everything the credential says is read from the stored mandate (and checked against who is asking). The request can
 * only NARROW: it may pick a lifetime, a subset of the stored merchants, a smaller amount, an audience list and a holder
 * key. It cannot name a currency, an action kind, a merchant outside the stored scope, or an amount above the stored
 * autonomous limit; unknown fields are refused, not ignored. Model-supplied Authority data is never an input.
 */
export const MAX_CREDENTIAL_TTL_SECONDS = 24 * 3600;
export const DEFAULT_CREDENTIAL_TTL_SECONDS = 3600;
const STATUS_VALID_SECONDS = 15 * 60;

const HolderJwk = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export const IssueRequestSchema = z
  .object({
    /** The agent's public key. The credential is only usable by whoever holds the matching private key. */
    holder: HolderJwk,
    /** Retrying the same request with the same key returns the same credential; a different request is refused. */
    idempotencyKey: z.string().min(16).max(128),
    audience: z.array(z.string().url().max(200)).min(1).max(10).optional(),
    counterpartyIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u))
      .min(1)
      .max(100)
      .optional(),
    maxAmountMinor: z.number().int().safe().positive().optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_CREDENTIAL_TTL_SECONDS)
      .optional(),
    maxDepth: z.number().int().min(0).max(2).optional(),
  })
  .strict();
export type IssueRequest = z.infer<typeof IssueRequestSchema>;

export type IssueRefusal =
  | "MALFORMED_REQUEST"
  | "AUTHORITY_NOT_FOUND"
  | "AUTHORITY_INTEGRITY_FAILED"
  | "AUTHORITY_REVOKED"
  | "AUTHORITY_EXPIRED"
  | "AGENT_NOT_ACTIVE"
  | "MERCHANT_SCOPE_NOT_ENUMERABLE"
  | "COUNTERPARTY_NOT_IN_AUTHORITY"
  | "AMOUNT_ABOVE_AUTHORITY"
  | "NO_AUTONOMOUS_AMOUNT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "ISSUER_NOT_CONFIGURED";

export interface IssuedCredential {
  readonly credentialId: string;
  readonly credential: Credential;
  readonly authorityId: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}
export interface CredentialRecord {
  readonly credentialId: string;
  readonly authorityId: string;
  readonly agentId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED" | "AUTHORITY_REVOKED";
  readonly audience: readonly string[] | null;
  readonly maxAmountMinor: number;
}

export interface Issuer {
  /** The issuer id verifiers trust and fetch a directory for: an origin such as https://payflow.example */
  readonly id: string;
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: JsonWebKey;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const thumbprint = (jwk: { crv?: string; kty?: string; x?: string }) =>
  createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");

export class PortableCredentialIssuer {
  constructor(
    private readonly deps: {
      sql: Sql;
      repo: PostgresTrustRepository;
      audit: AuditLog;
      issuer: Issuer;
      now: () => string;
    },
  ) {}

  /** `actor` comes from the authenticated, authorized member, never from the request body. */
  async issue(
    actor: {
      organizationId: string;
      environment: Environment;
      memberId: string;
    },
    authorityId: string,
    rawRequest: unknown,
  ): Promise<
    { ok: true; value: IssuedCredential } | { ok: false; refusal: IssueRefusal }
  > {
    const parsed = IssueRequestSchema.safeParse(rawRequest);
    if (!parsed.success) return { ok: false, refusal: "MALFORMED_REQUEST" };
    const req = parsed.data;
    const now = this.deps.now();
    const requestDigest = digest({ authorityId, ...req });

    // Idempotent retry first: same key + same request = the same credential, nothing new is signed or recorded.
    const prior = await this.deps.sql`
      select credential, request_digest, authority_id, expires_at, jti
      from portable_credentials
      where organization_id = ${actor.organizationId} and environment = ${actor.environment}
        and idempotency_key = ${req.idempotencyKey}`;
    if (prior[0]) return this.fromPrior(prior[0], requestDigest);

    // The Authority is read from storage, and it must belong to THIS tenant and environment (another tenant's id is
    // indistinguishable from a missing one).
    const owned = await this.deps.sql`
      select 1 from authority_ownership
      where mandate_id = ${authorityId} and organization_id = ${actor.organizationId} and environment = ${actor.environment}`;
    let mandate: Awaited<ReturnType<PostgresTrustRepository["getMandate"]>> =
      null;
    if (owned[0]) {
      try {
        mandate = await this.deps.repo.getMandate(authorityId);
      } catch (error) {
        // A stored Authority that fails its own integrity check (fingerprint or column mismatch) is never vouched for.
        if (
          error instanceof z.ZodError ||
          (error instanceof Error &&
            error.message === "MALFORMED_PERSISTED_MANDATE")
        )
          return { ok: false, refusal: "AUTHORITY_INTEGRITY_FAILED" };
        throw error;
      }
    }
    if (!mandate) return { ok: false, refusal: "AUTHORITY_NOT_FOUND" };
    const [state] = await this.deps
      .sql`select revoked_at from mandates where id = ${authorityId}`;
    if (state?.revoked_at) return { ok: false, refusal: "AUTHORITY_REVOKED" };
    if (Date.parse(mandate.expiresAt) <= Date.parse(now))
      return { ok: false, refusal: "AUTHORITY_EXPIRED" };
    const [agent] = await this.deps.sql`
      select lifecycle from organization_agents
      where organization_id = ${actor.organizationId} and environment = ${actor.environment}
        and agent_id = ${mandate.authorizedAgentId}`;
    // REGISTERED and ACTIVE agents may act; SUSPENDED, REVOKED and RETIRED agents are never vouched for.
    if (
      agent &&
      ["SUSPENDED", "REVOKED", "RETIRED"].includes(String(agent.lifecycle))
    )
      return { ok: false, refusal: "AGENT_NOT_ACTIVE" };

    // What the stored Authority allows, and nothing more.
    if (mandate.merchantScope?.mode !== "ONLY")
      return { ok: false, refusal: "MERCHANT_SCOPE_NOT_ENUMERABLE" };
    const storedMerchants = mandate.merchantScope.ids;
    const ceiling = Math.min(
      mandate.maxSingleTransactionMinor,
      mandate.autonomousPurchaseThresholdMinor,
    );
    if (!(ceiling > 0)) return { ok: false, refusal: "NO_AUTONOMOUS_AMOUNT" };
    if (
      req.counterpartyIds &&
      !req.counterpartyIds.every((c) => storedMerchants.includes(c))
    )
      return { ok: false, refusal: "COUNTERPARTY_NOT_IN_AUTHORITY" };
    if (req.maxAmountMinor !== undefined && req.maxAmountMinor > ceiling)
      return { ok: false, refusal: "AMOUNT_ABOVE_AUTHORITY" };

    const ttl = (req.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000;
    const expiresMs = Math.min(
      Date.parse(now) + ttl,
      Date.parse(mandate.expiresAt),
    );
    const jti = `pac_${randomBytes(12).toString("hex")}`;
    const fingerprint = mandateFingerprint(mandate);
    const claims: RootClaims = {
      v: CREDENTIAL_VERSION,
      iss: this.deps.issuer.id,
      kid: this.deps.issuer.kid,
      jti,
      sub: mandate.authorizedAgentId,
      principal: mandate.principalId,
      holder: req.holder,
      scope: {
        actionKinds: ["PURCHASE"],
        currencies: [mandate.currency],
        counterpartyIds: req.counterpartyIds ?? storedMerchants,
        maxAmountMinor: req.maxAmountMinor ?? ceiling,
      },
      ...(req.audience ? { aud: req.audience } : {}),
      nbf: now,
      exp: new Date(expiresMs).toISOString(),
      maxDepth: req.maxDepth ?? 1,
      ref: { authority: authorityId, fingerprint },
    };
    const credential = issueCredential(claims, this.deps.issuer.privateKey);
    const inserted = await this.deps.sql`
      insert into portable_credentials
        (jti, organization_id, environment, authority_id, authority_fingerprint, agent_id, principal_id, issuer, kid,
         holder_thumbprint, audience, scope, not_before, expires_at, idempotency_key, request_digest, credential,
         issued_by_member_id, issued_at)
      values (${jti}, ${actor.organizationId}, ${actor.environment}, ${authorityId}, ${fingerprint},
        ${mandate.authorizedAgentId}, ${mandate.principalId}, ${this.deps.issuer.id}, ${this.deps.issuer.kid},
        ${thumbprint(req.holder)}, ${req.audience ?? null}, ${this.deps.sql.json(JSON.parse(JSON.stringify(claims.scope)) as never)}, ${now},
        ${claims.exp}, ${req.idempotencyKey}, ${requestDigest}, ${this.deps.sql.json(credential as never)},
        ${actor.memberId}, ${now})
      on conflict (organization_id, environment, idempotency_key) do nothing
      returning jti`;
    if (inserted.length === 0) {
      // A concurrent identical request won the race: serve what it stored.
      const raced = await this.deps.sql`
        select credential, request_digest, authority_id, expires_at, jti from portable_credentials
        where organization_id = ${actor.organizationId} and environment = ${actor.environment}
          and idempotency_key = ${req.idempotencyKey}`;
      return this.fromPrior(raced[0]!, requestDigest);
    }
    await this.deps.audit.append({
      organizationId: actor.organizationId,
      environment: actor.environment,
      actorKind: "MEMBER",
      actorId: actor.memberId,
      action: "PORTABLE_CREDENTIAL_ISSUED",
      subjectKind: "PORTABLE_CREDENTIAL",
      subjectId: jti,
      detail: {
        authorityId,
        agentId: mandate.authorizedAgentId,
        maxAmountMinor: claims.scope.maxAmountMinor,
        expiresAt: claims.exp,
        holderThumbprint: thumbprint(req.holder),
      },
      occurredAt: now,
    });
    return {
      ok: true,
      value: {
        credentialId: jti,
        credential,
        authorityId,
        expiresAt: claims.exp,
        replayed: false,
      },
    };
  }

  private fromPrior(
    row: Record<string, unknown>,
    requestDigest: string,
  ):
    | { ok: true; value: IssuedCredential }
    | { ok: false; refusal: IssueRefusal } {
    if (row.request_digest !== requestDigest)
      return { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    return {
      ok: true,
      value: {
        credentialId: String(row.jti),
        credential: row.credential as Credential,
        authorityId: String(row.authority_id),
        expiresAt: new Date(row.expires_at as string).toISOString(),
        replayed: true,
      },
    };
  }

  /** Revocation is idempotent and tenant-scoped; another tenant's id is indistinguishable from a missing one. */
  async revoke(
    actor: {
      organizationId: string;
      environment: Environment;
      memberId: string;
    },
    credentialId: string,
    reason: string,
  ): Promise<{ found: boolean; alreadyRevoked: boolean }> {
    const now = this.deps.now();
    const rows = await this.deps.sql`
      update portable_credentials
      set revoked_at = ${now}, revoked_by_member_id = ${actor.memberId}, revoked_reason = ${reason.slice(0, 200)}
      where jti = ${credentialId} and organization_id = ${actor.organizationId}
        and environment = ${actor.environment} and revoked_at is null
      returning jti`;
    if (rows.length === 1) {
      await this.deps.audit.append({
        organizationId: actor.organizationId,
        environment: actor.environment,
        actorKind: "MEMBER",
        actorId: actor.memberId,
        action: "PORTABLE_CREDENTIAL_REVOKED",
        subjectKind: "PORTABLE_CREDENTIAL",
        subjectId: credentialId,
        detail: { reason: reason.slice(0, 200) },
        occurredAt: now,
      });
      return { found: true, alreadyRevoked: false };
    }
    const exists = await this.deps.sql`
      select 1 from portable_credentials
      where jti = ${credentialId} and organization_id = ${actor.organizationId} and environment = ${actor.environment}`;
    return { found: exists.length === 1, alreadyRevoked: exists.length === 1 };
  }

  async list(
    organizationId: string,
    environment: Environment,
    authorityId?: string,
  ): Promise<readonly CredentialRecord[]> {
    const now = this.deps.now();
    const rows = await this.deps.sql`
      select c.jti, c.authority_id, c.agent_id, c.issued_at, c.expires_at, c.revoked_at, c.audience, c.scope,
             m.revoked_at authority_revoked_at
      from portable_credentials c join mandates m on m.id = c.authority_id
      where c.organization_id = ${organizationId} and c.environment = ${environment}
        and (${authorityId ?? null}::text is null or c.authority_id = ${authorityId ?? null})
      order by c.issued_at desc, c.jti limit 500`;
    return rows.map((r) => ({
      credentialId: String(r.jti),
      authorityId: String(r.authority_id),
      agentId: String(r.agent_id),
      issuedAt: new Date(r.issued_at as string).toISOString(),
      expiresAt: new Date(r.expires_at as string).toISOString(),
      status: r.revoked_at
        ? "REVOKED"
        : r.authority_revoked_at
          ? "AUTHORITY_REVOKED"
          : Date.parse(r.expires_at as string) <= Date.parse(now)
            ? "EXPIRED"
            : "ACTIVE",
      audience: (r.audience as string[] | null) ?? null,
      maxAmountMinor: Number(
        (r.scope as { maxAmountMinor: number }).maxAmountMinor,
      ),
    }));
  }

  /**
   * The signed revocation list verifiers fetch. A credential is listed when it was revoked, OR its source Authority was
   * revoked (so withdrawing an Authority withdraws every credential made from it), until it would have expired anyway.
   */
  async statusList(): Promise<StatusList> {
    const now = this.deps.now();
    const rows = await this.deps.sql`
      select c.jti from portable_credentials c join mandates m on m.id = c.authority_id
      where c.issuer = ${this.deps.issuer.id} and c.expires_at > ${now}::timestamptz - interval '1 day'
        and (c.revoked_at is not null or m.revoked_at is not null)
      order by c.jti limit 50000`;
    return buildStatusList(
      {
        iss: this.deps.issuer.id,
        kid: this.deps.issuer.kid,
        issuedAt: now,
        validUntil: new Date(
          Date.parse(now) + STATUS_VALID_SECONDS * 1000,
        ).toISOString(),
        revoked: rows.map((r) => String(r.jti)),
      },
      this.deps.issuer.privateKey,
    );
  }
}
