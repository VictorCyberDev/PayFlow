import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import { z } from "zod";
import type { EmailOutbox, Tx } from "./email-outbox.js";
import type { Member } from "./rbac.js";

/**
 * R1a — customer accounts and browser sessions.
 *
 * A session is not a new kind of authority. It resolves to exactly one existing organization member (organization, environment, role)
 * and every route applies the same server-side role checks it applies to a member bearer token. Passwords are stored only as salted
 * scrypt hashes; the session secret and CSRF token are stored only as SHA-256 digests. Every failure on the credential path returns
 * the same answer, and an unknown email costs the same work as a known one.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 32;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;
export const SESSION_ABSOLUTE_MS = 8 * 3_600_000;
export const SESSION_IDLE_MS = 60 * 60_000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60_000;
const MEMBER_TTL_MS = 90 * 24 * 3_600_000;

/** The CSRF token is derived from the session secret, so a page reload can ask for it again; it is only readable same-origin. */
export const csrfFor = (sessionToken: string) =>
  createHash("sha256")
    .update("pf-csrf\0" + sessionToken)
    .digest("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-work verification. Returns false for any malformed stored hash. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const m =
    /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u.exec(
      stored,
    );
  if (!m) return false;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (n > 1 << 17 || r > 16 || p > 4) return false; // never let stored data choose unbounded work
  const expected = Buffer.from(m[5]!, "base64url");
  const key = await scrypt(
    password,
    Buffer.from(m[4]!, "base64url"),
    expected.length,
    {
      N: n,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    },
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A fixed hash to spend the same work on an unknown email.
const DECOY = `scrypt$${N}$${R}$${P}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/** The principal that sponsors an organization's agents. Derived, so no extra mapping table is needed. */
export const principalIdOf = (organizationId: string) =>
  `pfp_${organizationId.replace(/^org_/u, "")}`;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5)
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u);
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);
export const SignupSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    displayName: z.string().trim().min(1).max(80),
    organizationName: z.string().trim().min(1).max(120),
  })
  .strict();
export const LoginSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    organizationId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type SignupRefusal = "MALFORMED" | "WEAK_PASSWORD" | "EMAIL_UNAVAILABLE";
export type LoginRefusal = "MALFORMED" | "INVALID_CREDENTIALS";

export interface SessionGrant {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly user: {
    userId: string;
    email: string;
    displayName: string;
    emailVerified: boolean;
  };
  readonly member: Member;
}
export interface SessionView {
  readonly user: {
    userId: string;
    email: string;
    displayName: string;
    emailVerified: boolean;
  };
  readonly member: Member;
  readonly csrfHash: string;
  readonly expiresAt: string;
}

/** The password rules beyond length: not the email, not containing its name, not a handful of repeated characters. */
export function isWeakPassword(password: string, email: string): boolean {
  const local = email.split("@")[0]!;
  return (
    password.toLowerCase() === email ||
    (local.length >= 4 && password.toLowerCase().includes(local)) ||
    new Set(password).size < 5
  );
}
export const VERIFY_TTL_MS = 24 * 3_600_000;
export const RESET_TTL_MS = 30 * 60_000;

export class UserAuthService {
  constructor(
    private readonly deps: {
      sql: Sql;
      now: () => string;
      /** When present, verification and reset emails are queued here. Without it no email is ever claimed to be sent. */
      outbox?: EmailOutbox;
      /** Where links in those emails point, for example https://app.example.com */
      appBaseUrl?: string;
      /**
       * Asked before a recovery email is made for an address. Answering false (or throwing) makes the request a silent no-op, so a
       * limiter fault can never become a way to flood someone's inbox.
       */
      allowMailFor?: (email: string) => Promise<boolean>;
    },
  ) {}

  /** Creates the person, their organization (Sandbox) and an OWNER membership in one transaction. */
  async signup(
    raw: unknown,
  ): Promise<
    | { ok: true; userId: string; organizationId: string }
    | { ok: false; refusal: SignupRefusal }
  > {
    const parsed = SignupSchema.safeParse(raw);
    if (!parsed.success) {
      const weak = parsed.error.issues.some((i) => i.path[0] === "password");
      return { ok: false, refusal: weak ? "WEAK_PASSWORD" : "MALFORMED" };
    }
    const b = parsed.data;
    if (isWeakPassword(b.password, b.email))
      return { ok: false, refusal: "WEAK_PASSWORD" };
    const now = this.deps.now();
    const hash = await hashPassword(b.password);
    const userId = `pfu_${randomBytes(12).toString("hex")}`;
    const organizationId = `org_${randomBytes(10).toString("hex")}`;
    const memberId = `pfm_${randomBytes(12).toString("hex")}`;
    try {
      await this.deps.sql.begin(async (tx) => {
        await tx`insert into organizations (id, display_name) values (${organizationId}, ${b.organizationName})`;
        // The organization's principal: the legal owner that agents are sponsored by and Authorities are issued for.
        await tx`insert into principals (id, display_name) values (${principalIdOf(organizationId)}, ${b.organizationName})`;
        await tx`insert into user_accounts (user_id, email, display_name, password_hash, created_at)
          values (${userId}, ${b.email}, ${b.displayName}, ${hash}, ${now})`;
        // The member's bearer secret is random, discarded and never shown: this member is reachable only through a session.
        await tx`insert into organization_members (member_id, secret_hash, organization_id, environment, display_name, role, status, created_by, created_at, expires_at)
          values (${memberId}, ${sha(randomBytes(32).toString("base64url"))}, ${organizationId}, 'SANDBOX', ${b.displayName}, 'OWNER', 'ACTIVE',
            ${"user:" + userId}, ${now}, ${new Date(Date.parse(now) + MEMBER_TTL_MS).toISOString()})`;
        await tx`insert into user_memberships (user_id, member_id, created_at) values (${userId}, ${memberId}, ${now})`;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "EMAIL_UNAVAILABLE" };
      throw e;
    }
    return { ok: true, userId, organizationId };
  }

  async login(
    raw: unknown,
  ): Promise<
    { ok: true; grant: SessionGrant } | { ok: false; refusal: LoginRefusal }
  > {
    const parsed = LoginSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, refusal: "MALFORMED" };
    const b = parsed.data;
    const sql = this.deps.sql;
    const now = this.deps.now();
    const [u] = await sql`select * from user_accounts where email = ${b.email}`;
    // Identical work whether or not the account exists.
    const passwordOk = await verifyPassword(
      b.password,
      u ? String(u.password_hash) : DECOY,
    );
    const locked =
      !!u &&
      u.locked_until !== null &&
      new Date(u.locked_until as string).getTime() > Date.parse(now);
    if (!u || u.status !== "ACTIVE" || locked || !passwordOk) {
      if (u && u.status === "ACTIVE" && !locked)
        await sql`update user_accounts set failed_attempts = failed_attempts + 1,
          locked_until = case when failed_attempts + 1 >= ${LOCKOUT_THRESHOLD} then ${new Date(Date.parse(now) + LOCKOUT_MS).toISOString()}::timestamptz else locked_until end
          where user_id = ${String(u.user_id)}`;
      return { ok: false, refusal: "INVALID_CREDENTIALS" };
    }
    const memberships =
      await sql`select m.* from user_memberships um join organization_members m on m.member_id = um.member_id
      where um.user_id = ${String(u.user_id)} and m.status = 'ACTIVE'
        and (${b.organizationId ?? null}::text is null or m.organization_id = ${b.organizationId ?? null})
      order by um.created_at, m.member_id limit 1`;
    const m = memberships[0];
    if (!m) return { ok: false, refusal: "INVALID_CREDENTIALS" };
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = csrfFor(sessionToken);
    const expires = new Date(
      Date.parse(now) + SESSION_ABSOLUTE_MS,
    ).toISOString();
    await sql.begin(async (tx) => {
      await tx`update user_accounts set failed_attempts = 0, locked_until = null, last_login_at = ${now} where user_id = ${String(u.user_id)}`;
      // The identity member lives as long as the account is used.
      await tx`update organization_members set expires_at = ${new Date(Date.parse(now) + MEMBER_TTL_MS).toISOString()} where member_id = ${String(m.member_id)}`;
      await tx`insert into user_sessions (session_hash, user_id, member_id, csrf_hash, created_at, expires_at, idle_expires_at, last_seen_at)
        values (${sha(sessionToken)}, ${String(u.user_id)}, ${String(m.member_id)}, ${sha(csrfToken)}, ${now}, ${expires},
          ${new Date(Date.parse(now) + SESSION_IDLE_MS).toISOString()}, ${now})`;
    });
    return {
      ok: true,
      grant: {
        sessionToken,
        csrfToken,
        expiresAt: expires,
        user: {
          userId: String(u.user_id),
          email: String(u.email),
          displayName: String(u.display_name),
          emailVerified: u.email_verified_at !== null,
        },
        member: {
          memberId: String(m.member_id),
          organizationId: String(m.organization_id),
          environment: m.environment as Member["environment"],
          displayName: String(m.display_name),
          role: m.role as Member["role"],
        },
      },
    };
  }

  /** Resolves a session secret to its user and member; null for anything unknown, revoked, expired or idle. */
  async authenticate(sessionToken: string): Promise<SessionView | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/u.test(sessionToken)) return null;
    const sql = this.deps.sql;
    const now = this.deps.now();
    const [s] =
      await sql`select s.*, u.email, u.email_verified_at, u.display_name as user_name, u.status as user_status,
        m.organization_id, m.environment, m.display_name as member_name, m.role, m.status as member_status, m.expires_at as member_expires
      from user_sessions s join user_accounts u on u.user_id = s.user_id join organization_members m on m.member_id = s.member_id
      where s.session_hash = ${sha(sessionToken)}`;
    if (
      !s ||
      s.revoked_at !== null ||
      s.user_status !== "ACTIVE" ||
      s.member_status !== "ACTIVE" ||
      Date.parse(now) >= new Date(s.expires_at as string).getTime() ||
      Date.parse(now) >= new Date(s.idle_expires_at as string).getTime() ||
      Date.parse(now) >= new Date(s.member_expires as string).getTime()
    )
      return null;
    // Slide the idle window at most once a minute.
    if (Date.parse(now) - new Date(s.last_seen_at as string).getTime() > 60_000)
      await sql`update user_sessions set last_seen_at = ${now},
        idle_expires_at = least(${new Date(Date.parse(now) + SESSION_IDLE_MS).toISOString()}::timestamptz, expires_at)
        where session_hash = ${sha(sessionToken)}`;
    return {
      user: {
        userId: String(s.user_id),
        email: String(s.email),
        displayName: String(s.user_name),
        emailVerified: s.email_verified_at !== null,
      },
      member: {
        memberId: String(s.member_id),
        organizationId: String(s.organization_id),
        environment: s.environment as Member["environment"],
        displayName: String(s.member_name),
        role: s.role as Member["role"],
      },
      csrfHash: String(s.csrf_hash).trim(),
      expiresAt: new Date(s.expires_at as string).toISOString(),
    };
  }

  csrfMatches(view: SessionView, presented: string | undefined): boolean {
    return !!presented && same(sha(presented), view.csrfHash);
  }

  async logout(sessionToken: string): Promise<void> {
    await this.deps
      .sql`update user_sessions set revoked_at = ${this.deps.now()} where session_hash = ${sha(sessionToken)} and revoked_at is null`;
  }

  // ---------------------------------------------------------------------------------------------- email verification and reset
  /**
   * One transaction: take a lock for this account and purpose, retire the earlier link, store the new link's digest and queue the message that
   * carries it. If any step fails, none of it happened and the earlier link still works. If a message for this purpose is already waiting (or one
   * was made in the last minute) nothing new is made, so asking repeatedly cannot flood an inbox. A message whose delivery is UNKNOWN does not
   * block a new one: the old link is retired and a new one is issued, so one lost message never locks a person out.
   */
  private async issueAndQueue(
    userId: string,
    email: string,
    purpose: "VERIFY_EMAIL" | "RESET_PASSWORD",
    ttlMs: number,
    compose: (link: string) => { subject: string; body: string },
    linkPath: "verify" | "reset",
  ): Promise<"QUEUED" | "ALREADY_QUEUED"> {
    const outbox = this.deps.outbox;
    if (!outbox) throw new Error("NO_OUTBOX");
    const now = this.deps.now();
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const recent = new Date(Date.parse(now) - 60_000).toISOString();
    return this.deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${userId + "|" + purpose}, 0))`;
      const waiting = await tx`select 1 from email_outbox
        where to_email = ${email} and template = ${purpose}
          and ((state in ('QUEUED','SENDING') and (expires_at is null or expires_at > ${now})) or created_at > ${recent}) limit 1`;
      if (waiting.length) return "ALREADY_QUEUED" as const;
      const raw = randomBytes(32).toString("base64url");
      await tx`update user_tokens set used_at = ${now} where user_id = ${userId} and purpose = ${purpose} and used_at is null`;
      await tx`insert into user_tokens (token_hash, user_id, purpose, email, created_at, expires_at)
        values (${sha(raw)}, ${userId}, ${purpose}, ${email}, ${now}, ${expiresAt})`;
      const m = compose(this.link(linkPath, raw));
      await outbox.enqueue(
        {
          to: email,
          template: purpose,
          subject: m.subject,
          body: m.body,
          tokenHash: sha(raw),
          expiresAt,
        },
        tx as unknown as Tx,
      );
      return "QUEUED" as const;
    });
  }
  private link(path: string, token: string): string {
    const base = (this.deps.appBaseUrl ?? "").replace(/\/+$/u, "");
    // The token travels in the URL fragment so it never reaches a server log or a Referer header.
    return `${base}/workspace/#/${path}?token=${token}`;
  }

  /** Queue a verification email for a signed-in person. Returns false when no outbox is configured (nothing is claimed). */
  async requestEmailVerification(userId: string): Promise<boolean> {
    const [u] = await this.deps
      .sql`select email, email_verified_at, status from user_accounts where user_id = ${userId}`;
    if (!u || u.status !== "ACTIVE" || u.email_verified_at || !this.deps.outbox)
      return false;
    if (this.deps.allowMailFor) {
      let ok = false;
      try {
        ok = await this.deps.allowMailFor(String(u.email));
      } catch {
        ok = false;
      }
      if (!ok) return false;
    }
    await this.issueAndQueue(
      userId,
      String(u.email),
      "VERIFY_EMAIL",
      VERIFY_TTL_MS,
      (link) => ({
        subject: "Confirm your PayFlow email",
        body: `Confirm your email to finish setting up PayFlow:\n\n${link}\n\nThis link works once and expires in 24 hours. If you did not create a PayFlow account, ignore this message.`,
      }),
      "verify",
    );
    return true;
  }

  async confirmEmail(token: unknown): Promise<boolean> {
    if (typeof token !== "string" || token.length < 20 || token.length > 100)
      return false;
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      const [t] = await tx`update user_tokens set used_at = ${now}
        where token_hash = ${sha(token)} and purpose = 'VERIFY_EMAIL' and used_at is null and expires_at > ${now} returning user_id, email`;
      if (!t) return false;
      // Only the address the token was sent to counts, and only if the account still has it.
      const r = await tx`update user_accounts set email_verified_at = ${now}
        where user_id = ${String(t.user_id)} and email = ${String(t.email)} and email_verified_at is null returning user_id`;
      return r.length === 1;
    });
  }

  /**
   * Always answers the same way, whether or not the address has an account, so it cannot be used to find accounts. A disabled account gets nothing.
   * The reset link works once, for 30 minutes.
   */
  async requestPasswordReset(rawEmail: unknown): Promise<void> {
    const e = EmailSchema.safeParse(rawEmail);
    if (!e.success || !this.deps.outbox) return;
    const [u] = await this.deps
      .sql`select user_id, email, status from user_accounts where email = ${e.data}`;
    if (!u || u.status !== "ACTIVE") return;
    const address = String(u.email);
    // A limiter that cannot answer means no mail, with the same reply as always: nothing is revealed and nothing is sent.
    if (this.deps.allowMailFor) {
      let ok = false;
      try {
        ok = await this.deps.allowMailFor(address);
      } catch {
        ok = false;
      }
      if (!ok) return;
    }
    await this.issueAndQueue(
      String(u.user_id),
      address,
      "RESET_PASSWORD",
      RESET_TTL_MS,
      (link) => ({
        subject: "Reset your PayFlow password",
        body: `Someone asked to reset the password for this PayFlow account. If it was you, choose a new one here:\n\n${link}\n\nThis link works once and expires in 30 minutes. If it was not you, ignore this message; your password has not changed.`,
      }),
      "reset",
    );
  }

  async resetPassword(
    token: unknown,
    password: unknown,
  ): Promise<
    | { ok: true }
    | { ok: false; refusal: "INVALID_OR_EXPIRED" | "WEAK_PASSWORD" }
  > {
    const p = PasswordSchema.safeParse(password);
    if (typeof token !== "string" || token.length < 20 || token.length > 100)
      return { ok: false, refusal: "INVALID_OR_EXPIRED" };
    if (!p.success) return { ok: false, refusal: "WEAK_PASSWORD" };
    const now = this.deps.now();
    const sql = this.deps.sql;
    const [peek] =
      await sql`select u.email from user_tokens t join user_accounts u on u.user_id = t.user_id
      where t.token_hash = ${sha(token)} and t.purpose = 'RESET_PASSWORD' and t.used_at is null and t.expires_at > ${now} and u.status = 'ACTIVE'`;
    if (!peek) return { ok: false, refusal: "INVALID_OR_EXPIRED" };
    if (isWeakPassword(p.data, String(peek.email)))
      return { ok: false, refusal: "WEAK_PASSWORD" };
    const hash = await hashPassword(p.data);
    const done = await sql.begin(async (tx) => {
      // The token is consumed first, in the same transaction as the change: a replay finds it used.
      const [t] = await tx`update user_tokens set used_at = ${now}
        where token_hash = ${sha(token)} and purpose = 'RESET_PASSWORD' and used_at is null and expires_at > ${now} returning user_id`;
      if (!t) return null;
      await tx`update user_accounts set password_hash = ${hash}, failed_attempts = 0, locked_until = null where user_id = ${String(t.user_id)}`;
      await tx`update user_sessions set revoked_at = ${now} where user_id = ${String(t.user_id)} and revoked_at is null`;
      return String(t.user_id);
    });
    return done ? { ok: true } : { ok: false, refusal: "INVALID_OR_EXPIRED" };
  }

  /** The person's own live sign-ins. The id is a prefix of the stored digest: it names a session but cannot be used to become it. */
  async listSessions(
    userId: string,
    currentToken: string,
  ): Promise<
    {
      id: string;
      current: boolean;
      createdAt: string;
      lastSeenAt: string;
      expiresAt: string;
    }[]
  > {
    const now = this.deps.now();
    const rows = await this.deps
      .sql`select session_hash, created_at, last_seen_at, expires_at from user_sessions
      where user_id = ${userId} and revoked_at is null and expires_at > ${now} and idle_expires_at > ${now}
      order by created_at desc limit 50`;
    const mine = sha(currentToken);
    return rows.map((r) => ({
      id: String(r.session_hash).slice(0, 16),
      current: String(r.session_hash) === mine,
      createdAt: new Date(r.created_at as string | Date).toISOString(),
      lastSeenAt: new Date(r.last_seen_at as string | Date).toISOString(),
      expiresAt: new Date(r.expires_at as string | Date).toISOString(),
    }));
  }

  /** Ends one of the person's other sessions. Scoped to the user, so an id from someone else's list matches nothing. */
  async revokeSession(
    userId: string,
    id: string,
    currentToken: string,
  ): Promise<"REVOKED" | "NOT_FOUND" | "IS_CURRENT"> {
    if (!/^[a-f0-9]{16}$/u.test(id)) return "NOT_FOUND";
    if (sha(currentToken).startsWith(id)) return "IS_CURRENT";
    const done = await this.deps
      .sql`update user_sessions set revoked_at = ${this.deps.now()}
      where user_id = ${userId} and revoked_at is null and starts_with(session_hash, ${id}) returning 1`;
    return done.length ? "REVOKED" : "NOT_FOUND";
  }

  /** Ends every session except the one in use. */
  async revokeOthers(userId: string, currentToken: string): Promise<number> {
    const done = await this.deps
      .sql`update user_sessions set revoked_at = ${this.deps.now()}
      where user_id = ${userId} and revoked_at is null and session_hash <> ${sha(currentToken)} returning 1`;
    return done.length;
  }

  /** Ends every session of a user (password change, account disable). */
  async revokeAll(userId: string): Promise<void> {
    await this.deps
      .sql`update user_sessions set revoked_at = ${this.deps.now()} where user_id = ${userId} and revoked_at is null`;
  }
}

// ------------------------------------------------------------------------------------------------ cookies
export const SESSION_COOKIE = "pf_session";

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{40,64}$/u.test(v) ? v : null;
    }
  }
  return null;
}

/** HttpOnly, SameSite=Strict, host-only (no Domain), path-scoped to the API. `Secure` unless the host is plain-http local. */
export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
export const clearedSessionCookie = (secure: boolean) =>
  sessionCookie("", 0, secure);
