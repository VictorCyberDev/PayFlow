/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { hotp } from "../src/network/totp.js";

/** B6 — two-step sign-in with an authenticator app, over real HTTP and PostgreSQL. */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase 42";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const unb32 = (s: string) => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

(url ? describe : describe.skip)(
  "B6 two-step sign-in (PostgreSQL + real HTTP host)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts,organization_invitations,user_mfa,user_recovery_codes,user_mfa_challenges",
      emailSender: () => ({ send: () => Promise.resolve({ outcome: "SENT" }) }),
    });
    beforeEach(async () => {
      await h.repo
        .sql`truncate rate_limit_windows, email_outbox, user_tokens, user_mfa_challenges`;
    });
    const call = (
      method: "GET" | "POST",
      path: string,
      o: { body?: unknown; cookie?: string; csrf?: string } = {},
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          ...(o.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          origin: h.origin,
          ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
    type Who = { email: string; cookie: string; csrf: string };
    let n = 0;
    const cookieOf = (r: Response) =>
      `pf_session=${/pf_session=([^;]+)/u.exec(r.headers.get("set-cookie")!)![1]!}`;
    const signIn = async (email: string, password = PASSWORD): Promise<Who> => {
      h.advance(1_000);
      const l = await call("POST", "/v1/app/login", {
        body: { email, password },
      });
      expect(l.status).toBe(200);
      const cookie = cookieOf(l);
      const me = await (await call("GET", "/v1/app/me", { cookie })).json();
      return { email, cookie, csrf: me.csrfToken };
    };
    const person = async (): Promise<Who> => {
      h.advance(61_000);
      const email = `t${++n}${Math.random().toString(36).slice(2, 6)}@example.com`;
      const r = await call("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: `Tess ${n}`,
          organizationName: `Otp Org ${n}`,
        },
      });
      expect(r.status).toBe(201);
      await h.repo
        .sql`update user_accounts set email_verified_at = ${h.iso()} where email = ${email}`;
      return signIn(email);
    };
    const as = (w: Who) => ({ cookie: w.cookie, csrf: w.csrf });
    const codeNow = (secret: Buffer, stepOffset = 0) =>
      hotp(secret, Math.floor(h.now() / 30000) + stepOffset);
    /** Sets MFA up and turns it on; returns the secret and the recovery codes. */
    const enroll = async (w: Who) => {
      const b = await (
        await call("POST", "/v1/app/mfa/begin", {
          ...as(w),
          body: { password: PASSWORD },
        })
      ).json();
      const secret = unb32(b.secret);
      const e = await call("POST", "/v1/app/mfa/enable", {
        ...as(w),
        body: { code: codeNow(secret) },
      });
      expect(e.status).toBe(200);
      return {
        secret,
        recoveryCodes: (await e.json()).recoveryCodes as string[],
      };
    };
    const passwordStep = async (email: string) => {
      h.advance(1_000);
      const r = await call("POST", "/v1/app/login", {
        body: { email, password: PASSWORD },
      });
      return {
        status: r.status,
        body: await r.json(),
        setCookie: r.headers.get("set-cookie"),
      };
    };
    const secondStep = (challenge: string, f: Record<string, unknown>) =>
      call("POST", "/v1/app/login/mfa", { body: { challenge, ...f } });

    it("setting up asks for the password, shows the secret once, and an unconfirmed secret changes nothing; confirming returns recovery codes and ends other sign-ins", async () => {
      const w = await person();
      const other = await signIn(w.email);
      const wrong = await call("POST", "/v1/app/mfa/begin", {
        ...as(w),
        body: { password: "not the password at all" },
      });
      expect([wrong.status, (await wrong.json()).reason]).toEqual([
        403,
        "WRONG_PASSWORD",
      ]);
      const begin = await (
        await call("POST", "/v1/app/mfa/begin", {
          ...as(w),
          body: { password: PASSWORD },
        })
      ).json();
      expect(begin.secret).toMatch(/^[A-Z2-7]{32}$/u);
      expect(begin.otpauthUri).toContain(`secret=${begin.secret}`);
      expect(
        await (await call("GET", "/v1/app/mfa", { cookie: w.cookie })).json(),
      ).toMatchObject({ enabled: false, pending: true });
      // pending: sign-in is unchanged
      expect((await passwordStep(w.email)).body.mfaRequired).toBeUndefined();
      const secret = unb32(begin.secret);
      const bad = await call("POST", "/v1/app/mfa/enable", {
        ...as(w),
        body: { code: "000000" },
      });
      expect(bad.status).toBe(400);
      const ok = await call("POST", "/v1/app/mfa/enable", {
        ...as(w),
        body: { code: codeNow(secret) },
      });
      const out = await ok.json();
      expect(ok.status).toBe(200);
      expect(out.recoveryCodes).toHaveLength(10);
      expect(new Set(out.recoveryCodes).size).toBe(10);
      expect(
        await (await call("GET", "/v1/app/mfa", { cookie: w.cookie })).json(),
      ).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
      expect(
        (await call("GET", "/v1/app/me", { cookie: other.cookie })).status,
      ).toBe(401); // other sign-ins ended
      expect(
        (await call("GET", "/v1/app/me", { cookie: w.cookie })).status,
      ).toBe(200); // this one stays
      // already on: cannot be started again
      expect(
        (
          await call("POST", "/v1/app/mfa/begin", {
            ...as(w),
            body: { password: PASSWORD },
          })
        ).status,
      ).toBe(409);
    });

    it("with it on, the password alone gives no session; the second step does, and a code works only once", async () => {
      const w = await person();
      const { secret } = await enroll(w);
      h.advance(31_000);
      const p = await passwordStep(w.email);
      expect(p.status).toBe(200);
      expect(p.body.mfaRequired).toBe(true);
      expect(p.setCookie).toBeNull(); // no cookie yet
      expect(JSON.stringify(p.body)).not.toContain("csrfToken");
      const wrong = await secondStep(p.body.challenge, { code: "123456" });
      expect(wrong.status).toBe(401);
      const code = codeNow(secret);
      const ok = await secondStep(p.body.challenge, { code });
      expect(ok.status).toBe(200);
      const cookie = cookieOf(ok);
      expect((await call("GET", "/v1/app/me", { cookie })).status).toBe(200);
      // the spent challenge is dead, and so is the same code on a fresh challenge
      expect((await secondStep(p.body.challenge, { code })).status).toBe(401);
      const p2 = await passwordStep(w.email);
      expect((await secondStep(p2.body.challenge, { code })).status).toBe(401); // same 30-second step: replay
      h.advance(30_000);
      expect(
        (await secondStep(p2.body.challenge, { code: codeNow(secret) })).status,
      ).toBe(200); // the next step works
    });

    it("a challenge allows five tries and five minutes; a challenge belongs to one person", async () => {
      const a = await person();
      const b = await person();
      const sa = (await enroll(a)).secret;
      const sb = (await enroll(b)).secret;
      h.advance(31_000);
      const pa = await passwordStep(a.email);
      for (let i = 0; i < 5; i++)
        expect(
          (await secondStep(pa.body.challenge, { code: "000000" })).status,
        ).toBe(401);
      expect(
        (await secondStep(pa.body.challenge, { code: codeNow(sa) })).status,
      ).toBe(401); // burned, even with the right code
      // someone else's correct code does not complete my challenge
      const pa2 = await passwordStep(a.email);
      expect(
        (await secondStep(pa2.body.challenge, { code: codeNow(sb) })).status,
      ).toBe(401);
      const pa3 = await passwordStep(a.email);
      h.advance(6 * 60_000);
      expect(
        (await secondStep(pa3.body.challenge, { code: codeNow(sa) })).status,
      ).toBe(401); // expired
      const pa4 = await passwordStep(a.email);
      expect(
        (await secondStep(pa4.body.challenge, { code: codeNow(sa) })).status,
      ).toBe(200);
      expect(
        (await secondStep("x".repeat(43), { code: codeNow(sa) })).status,
      ).toBe(401);
    });

    it("recovery codes work once each, in any case or spacing, and are counted", async () => {
      const w = await person();
      const { recoveryCodes } = await enroll(w);
      const use = async (c: string) =>
        secondStep((await passwordStep(w.email)).body.challenge, {
          recoveryCode: c,
        });
      const first = recoveryCodes[0]!;
      expect((await use(first.toUpperCase().replace("-", " "))).status).toBe(
        200,
      );
      expect((await use(first)).status).toBe(401); // spent
      expect((await use("zzzzz-zzzzz")).status).toBe(401);
      const ok = await use(recoveryCodes[1]!);
      expect(ok.status).toBe(200);
      expect(
        (
          await (
            await call("GET", "/v1/app/mfa", { cookie: cookieOf(ok) })
          ).json()
        ).recoveryCodesLeft,
      ).toBe(8);
      const rows = JSON.stringify(
        await h.repo.sql`select code_hash from user_recovery_codes`,
      );
      expect(rows).not.toContain(first.replace("-", ""));
    });

    it("turning it off needs the password and a current factor, and ends other sign-ins", async () => {
      const w = await person();
      const { secret, recoveryCodes } = await enroll(w);
      h.advance(31_000);
      const second = await secondStep(
        (await passwordStep(w.email)).body.challenge,
        { code: codeNow(secret) },
      );
      const other: Who = { email: w.email, cookie: cookieOf(second), csrf: "" };
      other.csrf = (
        await (await call("GET", "/v1/app/me", { cookie: other.cookie })).json()
      ).csrfToken;
      const noCode = await call("POST", "/v1/app/mfa/disable", {
        ...as(w),
        body: { password: PASSWORD },
      });
      expect(noCode.status).toBe(403);
      const badPw = await call("POST", "/v1/app/mfa/disable", {
        ...as(w),
        body: { password: "wrong password!!", code: codeNow(secret, 1) },
      });
      expect(badPw.status).toBe(403);
      h.advance(30_000);
      const off = await call("POST", "/v1/app/mfa/disable", {
        ...as(w),
        body: { password: PASSWORD, recoveryCode: recoveryCodes[3] },
      });
      expect([off.status, (await off.json()).enabled]).toEqual([200, false]);
      expect(
        (await call("GET", "/v1/app/me", { cookie: other.cookie })).status,
      ).toBe(401);
      expect((await passwordStep(w.email)).body.mfaRequired).toBeUndefined(); // plain sign-in again
      const left = await h.repo
        .sql`select (select count(*)::int from user_mfa) a, (select count(*)::int from user_recovery_codes) b`;
      expect(left[0]).toMatchObject({ a: 0, b: 0 });
    });

    it("the secret is sealed at rest; if it cannot be opened the sign-in is refused, never reduced to the password", async () => {
      const w = await person();
      const { secret } = await enroll(w);
      const [row] = await h.repo.sql`select secret_enc from user_mfa`;
      const sealed = String(row!.secret_enc);
      expect(sealed).toMatch(/^v1\./u);
      expect(sealed).not.toContain(secret.toString("base64url"));
      expect(sealed).not.toContain(secret.toString("hex"));
      await h.repo
        .sql`update user_mfa set secret_enc = ${sealed.split(".").slice(0, 2).join(".") + "." + Buffer.from("tampered").toString("base64url") + "." + sealed.split(".")[3]}`;
      h.advance(31_000);
      const p = await passwordStep(w.email);
      expect(p.body.mfaRequired).toBe(true);
      const r = await secondStep(p.body.challenge, { code: codeNow(secret) });
      expect([r.status, (await r.json()).reason]).toEqual([
        503,
        "MFA_UNAVAILABLE",
      ]);
      expect(r.headers.get("set-cookie")).toBeNull();
    });

    it("a password reset does not bypass it, and closing the account removes it", async () => {
      const w = await person();
      const { secret } = await enroll(w);
      h.advance(61_000);
      await call("POST", "/v1/app/password-reset/request", {
        body: { email: w.email },
      });
      const [m] = await h.repo
        .sql`select body from email_outbox where to_email = ${w.email} and template = 'RESET_PASSWORD' order by created_at desc limit 1`;
      const token = /token=([A-Za-z0-9_-]+)/u.exec(String(m!.body))![1]!;
      expect(
        (
          await call("POST", "/v1/app/password-reset/confirm", {
            body: { token, password: NEW_PASSWORD },
          })
        ).status,
      ).toBe(200);
      h.advance(31_000);
      const p = await passwordStep2(w.email, NEW_PASSWORD);
      expect(p.body.mfaRequired).toBe(true); // email access alone does not get in
      expect(
        (await secondStep(p.body.challenge, { code: codeNow(secret) })).status,
      ).toBe(200);
      // closing: the factor goes with the account
      h.advance(31_000);
      const p2 = await passwordStep2(w.email, NEW_PASSWORD);
      const s = await secondStep(p2.body.challenge, { code: codeNow(secret) });
      const sess: Who = { email: w.email, cookie: cookieOf(s), csrf: "" };
      sess.csrf = (
        await (await call("GET", "/v1/app/me", { cookie: sess.cookie })).json()
      ).csrfToken;
      const closed = await call("POST", "/v1/app/account/close", {
        ...as(sess),
        body: { password: NEW_PASSWORD, confirm: "CLOSE MY ACCOUNT" },
      });
      expect(closed.status).toBe(200);
      const left = await h.repo
        .sql`select (select count(*)::int from user_mfa) a, (select count(*)::int from user_recovery_codes) b, (select count(*)::int from user_mfa_challenges) c`;
      expect(left[0]).toMatchObject({ a: 0, b: 0, c: 0 });
    });

    const passwordStep2 = async (email: string, password: string) => {
      h.advance(1_000);
      const r = await call("POST", "/v1/app/login", {
        body: { email, password },
      });
      return { status: r.status, body: await r.json() };
    };

    it("management needs a signed-in person and the session's CSRF token; the public second step needs an allowed Origin", async () => {
      const w = await person();
      for (const p of [
        "/v1/app/mfa/begin",
        "/v1/app/mfa/enable",
        "/v1/app/mfa/disable",
      ]) {
        expect([
          p,
          (
            await call("POST", p, {
              body: { password: PASSWORD, code: "123456" },
            })
          ).status,
        ]).toEqual([p, 401]);
        expect([
          p,
          (
            await call("POST", p, {
              cookie: w.cookie,
              body: { password: PASSWORD, code: "123456" },
            })
          ).status,
        ]).toEqual([p, 403]);
      }
      expect((await call("GET", "/v1/app/mfa")).status).toBe(401);
      const evil = await fetch(h.origin + "/v1/app/login/mfa", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ challenge: "x".repeat(43), code: "123456" }),
      });
      expect(evil.status).toBe(403);
    });
  },
);
