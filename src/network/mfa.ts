import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import {
  newSecret,
  open,
  otpauthUri,
  seal,
  base32,
  verifyTotp,
  stepAt,
} from "./totp.js";

/**
 * B6 — two-step sign-in. Enrolment is two steps (a secret is made, then proven with a code) so a half-finished setup never locks anyone in or out.
 * A code works once. Ten recovery codes are shown once and kept only as digests; each works once. A failed second step counts against the
 * challenge (5 tries), not just the address, so guessing six digits is cut off early. If the stored secret cannot be opened (wrong key, tampering)
 * the factor is UNUSABLE, which refuses the sign-in; it never reads as "no MFA".
 */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RC = "23456789abcdefghjkmnpqrstuvwxyz";
const normalizeRecovery = (c: string) =>
  c.toLowerCase().replace(/[\s-]+/gu, "");
function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += RC[b % RC.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export type SecondFactor = { code?: unknown; recoveryCode?: unknown };
export type FactorResult = "OK" | "WRONG" | "UNUSABLE";

export class MfaService {
  constructor(
    private readonly deps: { sql: Sql; now: () => string; key: Buffer },
  ) {}

  async status(userId: string): Promise<{
    enabled: boolean;
    pending: boolean;
    recoveryCodesLeft: number;
  }> {
    const [m] = await this.deps
      .sql`select enabled_at from user_mfa where user_id = ${userId}`;
    const [c] = await this.deps
      .sql`select count(*)::int n from user_recovery_codes where user_id = ${userId} and used_at is null`;
    return {
      enabled: !!m && m.enabled_at !== null,
      pending: !!m && m.enabled_at === null,
      recoveryCodesLeft: m?.enabled_at ? Number(c!.n) : 0,
    };
  }

  async isEnabled(userId: string): Promise<boolean> {
    const [m] = await this.deps
      .sql`select 1 from user_mfa where user_id = ${userId} and enabled_at is not null`;
    return !!m;
  }

  /** Makes (or replaces) an unconfirmed secret. Refused while MFA is already on: it has to be turned off first. */
  async begin(
    userId: string,
    account: string,
  ): Promise<
    | { ok: true; secret: string; uri: string }
    | { ok: false; refusal: "ALREADY_ENABLED" }
  > {
    const now = this.deps.now();
    const secret = newSecret();
    const sealed = seal(this.deps.key, secret, userId);
    return this.deps.sql.begin(async (tx) => {
      const [cur] =
        await tx`select enabled_at from user_mfa where user_id = ${userId} for update`;
      if (cur?.enabled_at)
        return { ok: false as const, refusal: "ALREADY_ENABLED" as const };
      await tx`insert into user_mfa (user_id, secret_enc, enabled_at, last_step, created_at) values (${userId}, ${sealed}, null, 0, ${now})
        on conflict (user_id) do update set secret_enc = excluded.secret_enc, enabled_at = null, last_step = 0, created_at = excluded.created_at`;
      return {
        ok: true as const,
        secret: base32(secret),
        uri: otpauthUri(secret, account),
      };
    });
  }

  /** Proves the secret with a code, turns MFA on and returns the recovery codes (the only time they are readable). */
  async enable(
    userId: string,
    code: unknown,
  ): Promise<
    | { ok: true; recoveryCodes: string[] }
    | { ok: false; refusal: "NOT_STARTED" | "WRONG_CODE" }
  > {
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      const [m] =
        await tx`select secret_enc, enabled_at from user_mfa where user_id = ${userId} for update`;
      if (!m || m.enabled_at)
        return { ok: false as const, refusal: "NOT_STARTED" as const };
      const secret = open(this.deps.key, String(m.secret_enc), userId);
      const step = secret ? verifyTotp(secret, code, Date.parse(now), 0) : null;
      if (step === null)
        return { ok: false as const, refusal: "WRONG_CODE" as const };
      const codes = Array.from(
        { length: RECOVERY_CODE_COUNT },
        newRecoveryCode,
      );
      await tx`delete from user_recovery_codes where user_id = ${userId}`;
      for (const c of codes)
        await tx`insert into user_recovery_codes (user_id, code_hash, created_at) values (${userId}, ${sha(normalizeRecovery(c))}, ${now})`;
      await tx`update user_mfa set enabled_at = ${now}, last_step = ${step} where user_id = ${userId}`;
      return { ok: true as const, recoveryCodes: codes };
    });
  }

  /** Checks a second factor for a person who has MFA on: an authenticator code (once per step) or a recovery code (once). */
  async checkFactor(userId: string, f: SecondFactor): Promise<FactorResult> {
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      const [m] =
        await tx`select secret_enc, last_step from user_mfa where user_id = ${userId} and enabled_at is not null for update`;
      if (!m) return "UNUSABLE" as const;
      if (typeof f.recoveryCode === "string" && f.recoveryCode.length > 0) {
        const used = await tx`update user_recovery_codes set used_at = ${now}
          where user_id = ${userId} and code_hash = ${sha(normalizeRecovery(f.recoveryCode.slice(0, 40)))} and used_at is null returning 1`;
        return used.length === 1 ? ("OK" as const) : ("WRONG" as const);
      }
      const secret = open(this.deps.key, String(m.secret_enc), userId);
      if (!secret) return "UNUSABLE" as const;
      const step = verifyTotp(
        secret,
        f.code,
        Date.parse(now),
        Number(m.last_step),
      );
      if (step === null) return "WRONG" as const;
      await tx`update user_mfa set last_step = ${step} where user_id = ${userId}`;
      return "OK" as const;
    });
  }

  /** Turns MFA off. The caller has already checked the password and the second factor. */
  async disable(userId: string): Promise<void> {
    await this.deps.sql.begin(async (tx) => {
      await tx`delete from user_recovery_codes where user_id = ${userId}`;
      await tx`delete from user_mfa_challenges where user_id = ${userId}`;
      await tx`delete from user_mfa where user_id = ${userId}`;
    });
  }

  async createChallenge(userId: string, memberId: string): Promise<string> {
    const now = this.deps.now();
    const token = randomBytes(32).toString("base64url");
    await this.deps
      .sql`insert into user_mfa_challenges (challenge_hash, user_id, member_id, created_at, expires_at)
      values (${sha(token)}, ${userId}, ${memberId}, ${now}, ${new Date(Date.parse(now) + CHALLENGE_TTL_MS).toISOString()})`;
    return token;
  }

  /**
   * Spends one try on the challenge and returns who it is for, or null when it is unknown, used, expired or out of tries. The try is counted
   * BEFORE the code is checked, in the same statement that reads it, so concurrent guesses cannot exceed the limit.
   */
  async takeAttempt(
    token: unknown,
  ): Promise<{ userId: string; memberId: string; hash: string } | null> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/u.test(token))
      return null;
    const now = this.deps.now();
    const [c] = await this.deps
      .sql`update user_mfa_challenges set attempts = attempts + 1
      where challenge_hash = ${sha(token)} and used_at is null and expires_at > ${now} and attempts < ${CHALLENGE_MAX_ATTEMPTS}
      returning user_id, member_id`;
    return c
      ? {
          userId: String(c.user_id),
          memberId: String(c.member_id),
          hash: sha(token),
        }
      : null;
  }

  /** Marks the challenge spent; false if it was already spent (two requests racing with the same correct code). */
  async spend(hash: string): Promise<boolean> {
    const done = await this.deps
      .sql`update user_mfa_challenges set used_at = ${this.deps.now()} where challenge_hash = ${hash} and used_at is null returning 1`;
    return done.length === 1;
  }
}

export { stepAt };
