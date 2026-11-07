import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";

/**
 * M13 organization roles. Authorization is decided on the SERVER from the authenticated member's
 * stored role. A label shown in a UI, a header or a request body is never an authorization input.
 * The platform operator token is NOT a member and holds no organization role: it can only bootstrap
 * a first OWNER and run platform operations.
 */
export const ROLES = [
  "OWNER",
  "FINANCE_ADMIN",
  "SECURITY_ADMIN",
  "DEVELOPER",
  "APPROVER",
  "AUDITOR",
  "VIEWER",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "view:agents",
  "view:finance",
  "view:security",
  "view:authorities",
  "view:decisions",
  "view:unknown",
  "view:funnel",
  "view:audit",
  "view:credentials",
  "view:members",
  "credential:issue",
  "credential:revoke",
  "authority:provision",
  "authority:attest",
  "authority:attest_revoke",
  "decision:approve",
  "decision:reject",
  "org:pause",
  "org:resume",
  "member:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: readonly Permission[] = [
  "view:agents",
  "view:finance",
  "view:security",
  "view:authorities",
  "view:decisions",
  "view:unknown",
  "view:funnel",
  "view:audit",
  "view:credentials",
  "view:members",
];

/** Least privilege per role. Anything not listed is denied. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: PERMISSIONS,
  // Controls economic Authority and approves/rejects escalations. Cannot mint credentials,
  // pause the organization or manage members.
  FINANCE_ADMIN: [
    "view:agents",
    "view:finance",
    "view:authorities",
    "view:decisions",
    "view:unknown",
    "view:audit",
    "authority:provision",
    "authority:attest",
    "authority:attest_revoke",
    "decision:approve",
    "decision:reject",
  ],
  // Contains blast radius: revoke credentials, pause/resume, see agents and exposure.
  // Cannot widen Authority or approve spend.
  SECURITY_ADMIN: [
    "view:agents",
    "view:security",
    "view:authorities",
    "view:unknown",
    "view:audit",
    "view:credentials",
    "credential:revoke",
    // May withdraw a portable credential to contain a problem, but can never issue one.
    "authority:attest_revoke",
    "org:pause",
    "org:resume",
  ],
  // Builds integrations. May issue and revoke agent credentials. CANNOT provision or widen
  // Authority, approve a decision, or read the finance/audit views.
  DEVELOPER: [
    "view:agents",
    "view:funnel",
    "view:unknown",
    "view:credentials",
    "credential:issue",
    "credential:revoke",
  ],
  APPROVER: [
    "view:authorities",
    "view:decisions",
    "decision:approve",
    "decision:reject",
  ],
  // Reads everything, changes nothing.
  AUDITOR: READ_ALL,
  VIEWER: ["view:agents", "view:finance", "view:authorities"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface Member {
  readonly memberId: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly displayName: string;
  readonly role: Role;
}

export interface MemberRecord extends Member {
  readonly status: "ACTIVE" | "REVOKED";
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

export const MemberInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    role: z.enum(ROLES),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(90 * 24 * 3600)
      .default(30 * 24 * 3600),
  })
  .strict();

const TOKEN = /^pf_act_(pfm_[a-f0-9]{24})\.([A-Za-z0-9_-]{32,})$/u;
const digest = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

export class MemberAuthError extends Error {
  constructor() {
    super("MEMBER_AUTH_REQUIRED");
  }
}

const toRecord = (r: Record<string, unknown>): MemberRecord => ({
  memberId: String(r.member_id),
  organizationId: String(r.organization_id),
  environment: r.environment as Member["environment"],
  displayName: String(r.display_name),
  role: r.role as Role,
  status: r.status as MemberRecord["status"],
  createdBy: String(r.created_by),
  createdAt: new Date(r.created_at as string).toISOString(),
  expiresAt: new Date(r.expires_at as string).toISOString(),
  revokedAt: r.revoked_at
    ? new Date(r.revoked_at as string).toISOString()
    : null,
  lastUsedAt: r.last_used_at
    ? new Date(r.last_used_at as string).toISOString()
    : null,
});

export class MemberStore {
  constructor(private readonly sql: Sql) {}

  /** The bearer secret is returned exactly once. Only its digest is stored. */
  async issue(
    organizationId: string,
    environment: Member["environment"],
    createdBy: string,
    rawInput: unknown,
    now: string,
  ): Promise<{ token: string; member: MemberRecord }> {
    const input = MemberInputSchema.parse(rawInput);
    const memberId = `pfm_${randomBytes(12).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const rows = await this.sql`
      insert into organization_members
        (member_id, secret_hash, organization_id, environment, display_name, role, status,
         created_by, created_at, expires_at)
      values (${memberId}, ${digest(secret)}, ${organizationId}, ${environment}, ${input.displayName},
        ${input.role}, 'ACTIVE', ${createdBy}, ${now},
        ${new Date(Date.parse(now) + input.ttlSeconds * 1000).toISOString()})
      returning *`;
    return {
      token: `pf_act_${memberId}.${secret}`,
      member: toRecord(rows[0]!),
    };
  }

  /**
   * Resolves a bearer token to a member. Wrong secret, unknown id, revoked or expired all throw the
   * same error so a caller cannot probe which member ids exist.
   */
  async authenticate(
    authorization: string | undefined,
    now: string,
  ): Promise<Member> {
    const presented = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const m = TOKEN.exec(presented);
    if (!m) throw new MemberAuthError();
    const rows = await this
      .sql`select * from organization_members where member_id = ${m[1]!}`;
    const rec = rows[0];
    // Always compare a digest, even for an unknown id, so timing does not separate the cases.
    const expected = rec ? String(rec.secret_hash).trim() : "0".repeat(64);
    const actual = digest(m[2]!);
    let diff = 0;
    for (let i = 0; i < 64; i++)
      diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    if (
      !rec ||
      diff !== 0 ||
      rec.status !== "ACTIVE" ||
      Date.parse(now) >= new Date(rec.expires_at as string).getTime()
    )
      throw new MemberAuthError();
    await this
      .sql`update organization_members set last_used_at = ${now} where member_id = ${m[1]!}`;
    const r = toRecord(rec);
    return {
      memberId: r.memberId,
      organizationId: r.organizationId,
      environment: r.environment,
      displayName: r.displayName,
      role: r.role,
    };
  }

  async list(
    organizationId: string,
    environment: Member["environment"],
  ): Promise<readonly MemberRecord[]> {
    const rows = await this.sql`
      select * from organization_members
      where organization_id = ${organizationId} and environment = ${environment}
      order by created_at, member_id`;
    return rows.map(toRecord);
  }

  /** Refuses to revoke the last active OWNER so an organization cannot lock itself out. */
  async revoke(
    organizationId: string,
    environment: Member["environment"],
    memberId: string,
    now: string,
  ): Promise<"REVOKED" | "NOT_FOUND" | "LAST_OWNER"> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"owners:" + organizationId + environment}, 3))`;
      const rows = await tx`
        select role, status from organization_members
        where member_id = ${memberId} and organization_id = ${organizationId} and environment = ${environment}
        for update`;
      if (!rows[0] || rows[0].status !== "ACTIVE") return "NOT_FOUND";
      if (rows[0].role === "OWNER") {
        const owners = await tx`
          select count(*)::int n from organization_members
          where organization_id = ${organizationId} and environment = ${environment}
            and role = 'OWNER' and status = 'ACTIVE' and expires_at > ${now}`;
        if (Number(owners[0]!.n) <= 1) return "LAST_OWNER";
      }
      await tx`update organization_members set status = 'REVOKED', revoked_at = ${now}
        where member_id = ${memberId}`;
      return "REVOKED";
    });
  }
}
