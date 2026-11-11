import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { EmailOutbox, Tx } from "./email-outbox.js";
import { maskEmail } from "./email-outbox.js";
import { EmailSchema } from "./user-auth.js";

/**
 * B3 — organization invitations. Inviting is a member-management act; accepting is done by the invited person, signed in, with the invited address
 * verified. The link token is random and stored only as a digest. An invitation never grants OWNER, never changes once finished, and a person who
 * is not the invited address learns nothing about it (every refusal on accept is the same).
 */
export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const INVITE_ROLES = [
  "FINANCE_ADMIN",
  "SECURITY_ADMIN",
  "DEVELOPER",
  "APPROVER",
  "AUDITOR",
  "VIEWER",
] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MEMBER_TTL_MS = 90 * 24 * 3_600_000;

export const InviteSchema = z
  .object({ email: EmailSchema, role: z.enum(INVITE_ROLES) })
  .strict();

export interface InviteActor {
  readonly memberId: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
}
export interface InviteeView {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
}
export type InviteRefusal =
  "MALFORMED" | "ALREADY_MEMBER" | "NO_OUTBOX" | "NOT_FOUND";
export type AcceptRefusal = "INVALID_OR_EXPIRED" | "EMAIL_NOT_VERIFIED";

export class InvitationService {
  constructor(
    private readonly deps: {
      sql: Sql;
      now: () => string;
      outbox?: EmailOutbox;
      appBaseUrl?: string;
    },
  ) {}

  private link(token: string): string {
    const base = (this.deps.appBaseUrl ?? "").replace(/\/+$/u, "");
    return `${base}/workspace/#/invite?token=${token}`;
  }

  /**
   * One transaction: lock the (organization, address), retire any open invitation for it, store the new one and queue the email. Inviting again
   * replaces the earlier link. An address that already belongs to the organization is refused.
   */
  async create(
    actor: InviteActor,
    raw: unknown,
    organizationName: string,
  ): Promise<
    | { ok: true; invitationId: string; expiresAt: string }
    | { ok: false; refusal: InviteRefusal }
  > {
    const parsed = InviteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, refusal: "MALFORMED" };
    const outbox = this.deps.outbox;
    if (!outbox) return { ok: false, refusal: "NO_OUTBOX" };
    const { email, role } = parsed.data;
    const now = this.deps.now();
    const expiresAt = new Date(Date.parse(now) + INVITE_TTL_MS).toISOString();
    const token = randomBytes(32).toString("base64url");
    const invitationId = `inv_${randomBytes(12).toString("hex")}`;
    return this.deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"invite|" + actor.organizationId + "|" + email}, 0))`;
      const [member] = await tx`select 1 from user_accounts u
        join user_memberships um on um.user_id = u.user_id
        join organization_members m on m.member_id = um.member_id
        where u.email = ${email} and m.organization_id = ${actor.organizationId} and m.environment = ${actor.environment} and m.status = 'ACTIVE'`;
      if (member)
        return { ok: false as const, refusal: "ALREADY_MEMBER" as const };
      await tx`update organization_invitations set revoked_at = ${now}
        where organization_id = ${actor.organizationId} and environment = ${actor.environment} and email = ${email}
          and accepted_at is null and revoked_at is null`;
      await tx`insert into organization_invitations (invitation_id, token_hash, organization_id, environment, email, role, invited_by_member_id, created_at, expires_at)
        values (${invitationId}, ${sha(token)}, ${actor.organizationId}, ${actor.environment}, ${email}, ${role}, ${actor.memberId}, ${now}, ${expiresAt})`;
      await outbox.enqueue(
        {
          to: email,
          template: "INVITE",
          subject: `You are invited to ${organizationName.slice(0, 80)} on PayFlow`,
          body: `You have been invited to join ${organizationName.slice(0, 80)} on PayFlow as ${role.toLowerCase().replace(/_/gu, " ")}.\n\nTo accept, sign in (or create an account) with this email address, confirm the address if asked, then open:\n\n${this.link(token)}\n\nThis invitation expires in 7 days. If you were not expecting it, ignore this message; nothing happens unless you accept.`,
          tokenHash: sha(token),
          expiresAt,
        },
        tx as unknown as Tx,
      );
      return { ok: true as const, invitationId, expiresAt };
    });
  }

  /** The organization's invitations, newest first. No token and no digest is ever returned. */
  async list(actor: InviteActor): Promise<
    {
      invitationId: string;
      email: string;
      role: string;
      state: "OPEN" | "ACCEPTED" | "REVOKED" | "EXPIRED";
      createdAt: string;
      expiresAt: string;
    }[]
  > {
    const now = this.deps.now();
    const rows = await this.deps
      .sql`select invitation_id, email, role, created_at, expires_at, accepted_at, revoked_at
      from organization_invitations where organization_id = ${actor.organizationId} and environment = ${actor.environment}
      order by created_at desc, invitation_id limit 100`;
    return rows.map((r) => ({
      invitationId: String(r.invitation_id),
      email: String(r.email),
      role: String(r.role),
      state: r.accepted_at
        ? "ACCEPTED"
        : r.revoked_at
          ? "REVOKED"
          : Date.parse(new Date(r.expires_at as string | Date).toISOString()) <=
              Date.parse(now)
            ? "EXPIRED"
            : "OPEN",
      createdAt: new Date(r.created_at as string | Date).toISOString(),
      expiresAt: new Date(r.expires_at as string | Date).toISOString(),
    }));
  }

  async revoke(actor: InviteActor, invitationId: string): Promise<boolean> {
    if (!/^inv_[a-f0-9]{24}$/u.test(invitationId)) return false;
    const done = await this.deps
      .sql`update organization_invitations set revoked_at = ${this.deps.now()}
      where invitation_id = ${invitationId} and organization_id = ${actor.organizationId} and environment = ${actor.environment}
        and accepted_at is null and revoked_at is null returning 1`;
    return done.length === 1;
  }

  /** What the link is for, shown before sign-in. Holding the token is the credential; the address is masked. */
  async preview(token: unknown): Promise<{
    organizationName: string;
    role: string;
    emailHint: string;
  } | null> {
    if (typeof token !== "string" || token.length < 20 || token.length > 100)
      return null;
    const now = this.deps.now();
    const [r] = await this.deps
      .sql`select i.email, i.role, o.display_name from organization_invitations i
      join organizations o on o.id = i.organization_id
      where i.token_hash = ${sha(token)} and i.accepted_at is null and i.revoked_at is null and i.expires_at > ${now}`;
    return r
      ? {
          organizationName: String(r.display_name),
          role: String(r.role),
          emailHint: maskEmail(String(r.email)),
        }
      : null;
  }

  /**
   * Joins the signed-in person to the organization. The signed-in address must be the invited address and must be verified; every other failure
   * (unknown, used, revoked, expired, someone else's invitation) reads the same, so a token held by the wrong person reveals nothing.
   */
  async accept(
    user: InviteeView,
    token: unknown,
  ): Promise<
    | { ok: true; organizationId: string; role: string; alreadyMember: boolean }
    | { ok: false; refusal: AcceptRefusal }
  > {
    if (typeof token !== "string" || token.length < 20 || token.length > 100)
      return { ok: false, refusal: "INVALID_OR_EXPIRED" };
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      const [inv] = await tx`select * from organization_invitations
        where token_hash = ${sha(token)} and accepted_at is null and revoked_at is null and expires_at > ${now} for update`;
      if (!inv || String(inv.email) !== user.email)
        return { ok: false as const, refusal: "INVALID_OR_EXPIRED" as const };
      if (!user.emailVerified)
        return { ok: false as const, refusal: "EMAIL_NOT_VERIFIED" as const };
      const org = String(inv.organization_id);
      const env = String(inv.environment);
      const [existing] =
        await tx`select m.member_id from user_memberships um join organization_members m on m.member_id = um.member_id
        where um.user_id = ${user.userId} and m.organization_id = ${org} and m.environment = ${env} and m.status = 'ACTIVE'`;
      await tx`update organization_invitations set accepted_at = ${now}, accepted_by_user_id = ${user.userId} where invitation_id = ${String(inv.invitation_id)}`;
      if (existing)
        return {
          ok: true as const,
          organizationId: org,
          role: String(inv.role),
          alreadyMember: true,
        };
      const memberId = `pfm_${randomBytes(12).toString("hex")}`;
      await tx`insert into organization_members (member_id, secret_hash, organization_id, environment, display_name, role, status, created_by, created_at, expires_at)
        values (${memberId}, ${sha(randomBytes(32).toString("base64url"))}, ${org}, ${env}, ${user.displayName.slice(0, 80)}, ${String(inv.role)}, 'ACTIVE',
          ${"invitation:" + String(inv.invitation_id)}, ${now}, ${new Date(Date.parse(now) + MEMBER_TTL_MS).toISOString()})`;
      await tx`insert into user_memberships (user_id, member_id, created_at) values (${user.userId}, ${memberId}, ${now})`;
      return {
        ok: true as const,
        organizationId: org,
        role: String(inv.role),
        alreadyMember: false,
      };
    });
  }

  /** The organizations this person belongs to (for the switcher). */
  async organizationsOf(userId: string): Promise<
    {
      organizationId: string;
      name: string;
      role: string;
      environment: string;
    }[]
  > {
    const rows = await this.deps
      .sql`select m.organization_id, o.display_name, m.role, m.environment
      from user_memberships um join organization_members m on m.member_id = um.member_id
      join organizations o on o.id = m.organization_id
      where um.user_id = ${userId} and m.status = 'ACTIVE' order by um.created_at, m.member_id`;
    return rows.map((r) => ({
      organizationId: String(r.organization_id),
      name: String(r.display_name),
      role: String(r.role),
      environment: String(r.environment),
    }));
  }

  /** Re-binds a live session to another of the same person's memberships. Scoped to the session's own user, so it can reach no one else's. */
  async switchOrganization(
    sessionToken: string,
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const now = this.deps.now();
    const done = await this.deps
      .sql`update user_sessions s set member_id = m.member_id
      from user_memberships um join organization_members m on m.member_id = um.member_id
      where s.session_hash = ${sha(sessionToken)} and s.user_id = ${userId} and s.revoked_at is null
        and um.user_id = ${userId} and m.organization_id = ${organizationId} and m.status = 'ACTIVE' and m.expires_at > ${now}
      returning 1`;
    return done.length === 1;
  }
}
