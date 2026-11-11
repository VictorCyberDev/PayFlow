import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { hashPassword, verifyPassword } from "./user-auth.js";

/**
 * B5 — a person's own data: export it, or close the account. Both need the password again, so a stolen session cookie alone cannot take the
 * data or destroy the account. Closing keeps the pseudonymous user id (the audit trail refers to it) but removes everything that identifies the
 * person: the address, the name, the password. Organization records belong to the organization and stay.
 */
export type ExportResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: "WRONG_PASSWORD" };
export type CloseResult =
  | { ok: true; organizationsLeft: number; organizationsOrphaned: number }
  | {
      ok: false;
      refusal: "WRONG_PASSWORD" | "OWNS_ORGANIZATION_WITH_OTHER_MEMBERS";
      organizations?: string[];
    };

export class AccountDataService {
  constructor(private readonly deps: { sql: Sql; now: () => string }) {}

  private async passwordOk(
    userId: string,
    password: unknown,
  ): Promise<boolean> {
    if (
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > 200
    )
      return false;
    const [u] = await this.deps
      .sql`select password_hash, status from user_accounts where user_id = ${userId}`;
    // Same work whether or not the password is right; a closed account has no usable password.
    return (
      !!u &&
      u.status === "ACTIVE" &&
      (await verifyPassword(password, String(u.password_hash)))
    );
  }

  /** For routes that ask for the password again before a sensitive change. */
  verifyOwnPassword(userId: string, password: unknown): Promise<boolean> {
    return this.passwordOk(userId, password);
  }

  /** Everything PayFlow holds about the person themselves. No secret, no digest, no other person's data. */
  async exportData(userId: string, password: unknown): Promise<ExportResult> {
    if (!(await this.passwordOk(userId, password)))
      return { ok: false, refusal: "WRONG_PASSWORD" };
    const sql = this.deps.sql;
    const iso = (v: unknown) =>
      v ? new Date(v as string | Date).toISOString() : null;
    const [u] =
      await sql`select user_id, email, display_name, created_at, last_login_at, email_verified_at from user_accounts where user_id = ${userId}`;
    const memberships =
      await sql`select m.organization_id, o.display_name org, m.environment, m.role, m.status, um.created_at
      from user_memberships um join organization_members m on m.member_id = um.member_id
      join organizations o on o.id = m.organization_id where um.user_id = ${userId} order by um.created_at`;
    const sessions =
      await sql`select created_at, last_seen_at, expires_at, revoked_at from user_sessions where user_id = ${userId} order by created_at desc limit 100`;
    const invitations =
      await sql`select i.role, i.accepted_at, o.display_name org from organization_invitations i
      join organizations o on o.id = i.organization_id where i.accepted_by_user_id = ${userId} order by i.accepted_at`;
    return {
      ok: true,
      data: {
        exportedAt: this.deps.now(),
        about:
          "What PayFlow holds about you personally. Records that belong to an organization you were part of stay with that organization.",
        account: {
          userId: String(u!.user_id),
          email: String(u!.email),
          displayName: String(u!.display_name),
          emailConfirmed: u!.email_verified_at !== null,
          createdAt: iso(u!.created_at),
          lastSignInAt: iso(u!.last_login_at),
        },
        memberships: memberships.map((m) => ({
          organizationId: String(m.organization_id),
          organization: String(m.org),
          environment: String(m.environment),
          role: String(m.role),
          status: String(m.status),
          since: iso(m.created_at),
        })),
        signIns: sessions.map((s) => ({
          startedAt: iso(s.created_at),
          lastUsedAt: iso(s.last_seen_at),
          expiresAt: iso(s.expires_at),
          endedAt: iso(s.revoked_at),
        })),
        invitationsAccepted: invitations.map((i) => ({
          organization: String(i.org),
          role: String(i.role),
          acceptedAt: iso(i.accepted_at),
        })),
      },
    };
  }

  /**
   * Closes the account. Refused while the person is the only owner of an organization that still has other active members (hand it over first).
   * An organization where they are the only active member is left without anyone able to act on it. Everything else, one transaction.
   */
  async closeAccount(userId: string, password: unknown): Promise<CloseResult> {
    if (!(await this.passwordOk(userId, password)))
      return { ok: false, refusal: "WRONG_PASSWORD" };
    const now = this.deps.now();
    const replacement = await hashPassword(
      randomBytes(32).toString("base64url"),
    );
    const anon = `deleted-${randomBytes(9).toString("hex")}@deleted.invalid`;
    return this.deps.sql.begin(async (tx) => {
      const mine =
        await tx`select m.member_id, m.organization_id, m.environment, m.role, o.display_name org
        from user_memberships um join organization_members m on m.member_id = um.member_id
        join organizations o on o.id = m.organization_id
        where um.user_id = ${userId} and m.status = 'ACTIVE' order by m.organization_id, m.member_id`;
      let left = 0;
      let orphaned = 0;
      const blocking: string[] = [];
      for (const m of mine) {
        // the same lock the member operations take, so closing cannot race a promotion or demotion
        await tx`select pg_advisory_xact_lock(hashtextextended(${"owners:" + String(m.organization_id) + String(m.environment)}, 3))`;
        if (m.role === "OWNER") {
          const [others] = await tx`select
              count(*) filter (where role = 'OWNER' and member_id <> ${String(m.member_id)})::int owners,
              count(*) filter (where member_id <> ${String(m.member_id)})::int people
            from organization_members
            where organization_id = ${String(m.organization_id)} and environment = ${String(m.environment)} and status = 'ACTIVE' and expires_at > ${now}`;
          if (Number(others!.owners) === 0) {
            if (Number(others!.people) > 0) {
              blocking.push(String(m.org));
              continue;
            }
            orphaned++;
          }
        }
        left++;
      }
      if (blocking.length) {
        // rolled back by returning before any write
        return {
          ok: false as const,
          refusal: "OWNS_ORGANIZATION_WITH_OTHER_MEMBERS" as const,
          organizations: blocking,
        };
      }
      for (const m of mine) {
        await tx`update organization_members set status = 'REVOKED', revoked_at = ${now}, display_name = 'Former member' where member_id = ${String(m.member_id)}`;
      }
      const [old] =
        await tx`select email from user_accounts where user_id = ${userId}`;
      await tx`update user_sessions set revoked_at = ${now} where user_id = ${userId} and revoked_at is null`;
      await tx`update user_tokens set used_at = ${now} where user_id = ${userId} and used_at is null`;
      // the second factor goes with the account
      await tx`delete from user_recovery_codes where user_id = ${userId}`;
      await tx`delete from user_mfa_challenges where user_id = ${userId}`;
      await tx`delete from user_mfa where user_id = ${userId}`;
      // Nothing addressed to the old address stays readable or usable.
      await tx`update email_outbox set state = 'FAILED', body = null, note = 'account closed', updated_at = ${now}
        where to_email = ${String(old!.email)} and state = 'QUEUED'`;
      await tx`update email_outbox set body = null, updated_at = ${now} where to_email = ${String(old!.email)} and body is not null and state = 'UNKNOWN'`;
      await tx`update organization_invitations set revoked_at = ${now}
        where email = ${String(old!.email)} and accepted_at is null and revoked_at is null`;
      await tx`update user_accounts set email = ${anon}, display_name = 'Deleted account', password_hash = ${replacement},
        status = 'DISABLED', failed_attempts = 0, locked_until = null, email_verified_at = null where user_id = ${userId}`;
      return {
        ok: true as const,
        organizationsLeft: left,
        organizationsOrphaned: orphaned,
      };
    });
  }
}
