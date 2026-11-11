/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { beforeEach, describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";

/** B5 — export and closing an account, over real HTTP and PostgreSQL. */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";
const CONFIRM = "CLOSE MY ACCOUNT";

(url ? describe : describe.skip)(
  "B5 account data (PostgreSQL + real HTTP host)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts,organization_invitations",
      emailSender: () => ({ send: () => Promise.resolve({ outcome: "SENT" }) }),
    });
    beforeEach(async () => {
      await h.repo
        .sql`truncate rate_limit_windows, email_outbox, user_tokens, organization_invitations`;
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
    const signIn = async (email: string): Promise<Who> => {
      h.advance(1_000);
      const l = await call("POST", "/v1/app/login", {
        body: { email, password: PASSWORD },
      });
      expect(l.status).toBe(200);
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      const me = await (await call("GET", "/v1/app/me", { cookie })).json();
      return { email, cookie, csrf: me.csrfToken };
    };
    const person = async (): Promise<Who> => {
      h.advance(61_000);
      const email = `d${++n}${Math.random().toString(36).slice(2, 6)}@example.com`;
      const r = await call("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: `Dana ${n}`,
          organizationName: `Data Org ${n}`,
        },
      });
      expect(r.status).toBe(201);
      await h.repo
        .sql`update user_accounts set email_verified_at = ${h.iso()} where email = ${email}`;
      return signIn(email);
    };
    const as = (w: Who) => ({ cookie: w.cookie, csrf: w.csrf });
    const exportOf = (w: Who, password: unknown = PASSWORD) =>
      call("POST", "/v1/app/account/export", { ...as(w), body: { password } });
    const close = (
      w: Who,
      password: unknown = PASSWORD,
      confirm: unknown = CONFIRM,
    ) =>
      call("POST", "/v1/app/account/close", {
        ...as(w),
        body: { password, confirm },
      });
    const join = async (owner: Who, guest: Who, role = "VIEWER") => {
      h.advance(1_000);
      await call("POST", "/v1/app/invitations", {
        ...as(owner),
        body: { email: guest.email, role },
      });
      const [m] = await h.repo
        .sql`select body from email_outbox where to_email = ${guest.email} and template = 'INVITE' order by created_at desc, outbox_id desc limit 1`;
      const token = /token=([A-Za-z0-9_-]+)/u.exec(String(m!.body))![1]!;
      const a = await (
        await call("POST", "/v1/app/invitations/accept", {
          ...as(guest),
          body: { token },
        })
      ).json();
      return a.organizationId as string;
    };

    it("export needs the password, contains the person's own data and no secret or other person's data, and is limited like password guessing", async () => {
      const a = await person();
      const b = await person();
      await join(a, b);
      const wrong = await exportOf(a, "not the password at all");
      expect([wrong.status, (await wrong.json()).reason]).toEqual([
        403,
        "WRONG_PASSWORD",
      ]);
      expect(
        (await call("POST", "/v1/app/account/export", { ...as(a), body: {} }))
          .status,
      ).toBe(403);
      const ok = await exportOf(a);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-disposition")).toContain("attachment");
      const text = await ok.text();
      const data = JSON.parse(text);
      expect(data.account.email).toBe(a.email);
      expect(data.memberships).toHaveLength(1);
      expect(data.memberships[0]).toMatchObject({
        role: "OWNER",
        status: "ACTIVE",
      });
      expect(text).not.toContain(b.email); // another person
      expect(text).not.toMatch(
        /scrypt\$|session_hash|csrf|password_hash|token_hash|secret/iu,
      );
      const exportB = JSON.parse(await (await exportOf(b)).text());
      expect(exportB.memberships).toHaveLength(2);
      expect(exportB.invitationsAccepted).toHaveLength(1);
      // five wrong guesses use up the allowance; even the right password is then refused for a while
      const c = await person();
      for (let i = 0; i < 5; i++)
        await exportOf(c, "wrong password number " + i);
      expect((await exportOf(c)).status).toBe(429);
    });

    it("closing needs the password and the typed confirmation, and is refused while others depend on you as the only owner", async () => {
      const owner = await person();
      const guest = await person();
      await join(owner, guest);
      expect((await close(owner, "wrong password here")).status).toBe(403);
      const noConfirm = await close(owner, PASSWORD, "yes");
      expect([noConfirm.status, (await noConfirm.json()).reason]).toEqual([
        400,
        "CONFIRMATION_REQUIRED",
      ]);
      const blocked = await close(owner);
      const body = await blocked.json();
      expect([blocked.status, body.reason]).toEqual([
        409,
        "OWNS_ORGANIZATION_WITH_OTHER_MEMBERS",
      ]);
      expect(body.organizations[0]).toMatch(/^Data Org /u);
      // nothing happened
      expect(
        (await call("GET", "/v1/app/me", { cookie: owner.cookie })).status,
      ).toBe(200);
      const [still] = await h.repo
        .sql`select status, email from user_accounts where email = ${owner.email}`;
      expect(still).toMatchObject({ status: "ACTIVE" });
      // hand the organization over, then it can close
      const list = await (
        await call("GET", "/v1/app/members", { cookie: owner.cookie })
      ).json();
      const gid = list.members.find(
        (m: any) => m.email === guest.email,
      ).memberId;
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/role`, {
            ...as(owner),
            body: { role: "OWNER" },
          })
        ).status,
      ).toBe(200);
      const done = await close(owner);
      const out = await done.json();
      expect([
        done.status,
        out.closed,
        out.organizationsLeft,
        out.organizationsOrphaned,
      ]).toEqual([200, true, 1, 0]);
      expect(done.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/iu);
    });

    it("a closed account is gone: no sessions, no sign-in, nothing identifying left, queued mail erased, invitations withdrawn, the address free again", async () => {
      const owner = await person();
      const leaver = await person();
      const orgId = await join(owner, leaver, "APPROVER");
      // something addressed to the leaver is waiting, and they have an open invitation from a third organization
      const third = await person();
      await call("POST", "/v1/app/invitations", {
        ...as(third),
        body: { email: leaver.email, role: "VIEWER" },
      });
      const pending = await h.repo
        .sql`select count(*)::int n from email_outbox where to_email = ${leaver.email} and body is not null`;
      expect(pending[0]!.n).toBeGreaterThan(0);
      const second = await signIn(leaver.email);
      const r = await close(leaver);
      const out = await r.json();
      expect([r.status, out.closed, out.organizationsLeft]).toEqual([
        200,
        true,
        2,
      ]);
      for (const w of [leaver, second])
        expect(
          (await call("GET", "/v1/app/me", { cookie: w.cookie })).status,
        ).toBe(401);
      h.advance(61_000);
      const login = await call("POST", "/v1/app/login", {
        body: { email: leaver.email, password: PASSWORD },
      });
      expect(login.status).toBe(401);
      const [acct] = await h.repo
        .sql`select email, display_name, status, password_hash from user_accounts where display_name = 'Deleted account'`;
      expect(acct!.email).toMatch(/^deleted-[a-f0-9]+@deleted\.invalid$/u);
      expect(acct!.status).toBe("DISABLED");
      const people = await h.repo
        .sql`select display_name, status from organization_members where organization_id = ${orgId} and display_name = 'Former member'`;
      expect(people).toHaveLength(1);
      expect(people[0]!.status).toBe("REVOKED");
      const left = await h.repo
        .sql`select count(*)::int n from email_outbox where to_email = ${leaver.email} and body is not null`;
      expect(left[0]!.n).toBe(0);
      const inv = await h.repo
        .sql`select count(*)::int n from organization_invitations where email = ${leaver.email} and accepted_at is null and revoked_at is null`;
      expect(inv[0]!.n).toBe(0);
      // the audit trail keeps the fact, not the address
      const audit = JSON.stringify(
        await h.repo
          .sql`select action, detail, actor_id, subject_id from organization_audit_events where action = 'ACCOUNT_CLOSED'`,
      );
      expect(audit).toContain("ACCOUNT_CLOSED");
      expect(audit).not.toContain(leaver.email);
      // the organization's own records stay, and the owner still works
      expect(
        (await call("GET", "/v1/app/me", { cookie: owner.cookie })).status,
      ).toBe(200);
      // the address can be used again for a new account
      const again = await call("POST", "/v1/app/signup", {
        body: {
          email: leaver.email,
          password: PASSWORD,
          displayName: "New Dana",
          organizationName: "Fresh Org",
        },
      });
      expect(again.status).toBe(201);
    });

    it("an owner who is the only active member can close; the empty organization is reported as left without anyone", async () => {
      const solo = await person();
      const r = await close(solo);
      const out = await r.json();
      expect([
        r.status,
        out.organizationsLeft,
        out.organizationsOrphaned,
      ]).toEqual([200, 1, 1]);
      expect(
        (await call("GET", "/v1/app/me", { cookie: solo.cookie })).status,
      ).toBe(401);
    });

    it("every change needs the session's CSRF token and a signed-in person", async () => {
      const a = await person();
      for (const p of ["/v1/app/account/export", "/v1/app/account/close"]) {
        expect([
          p,
          (
            await call("POST", p, {
              cookie: a.cookie,
              body: { password: PASSWORD, confirm: CONFIRM },
            })
          ).status,
        ]).toEqual([p, 403]);
        expect([
          p,
          (
            await call("POST", p, {
              body: { password: PASSWORD, confirm: CONFIRM },
            })
          ).status,
        ]).toEqual([p, 401]);
      }
      expect(
        (await call("GET", "/v1/app/me", { cookie: a.cookie })).status,
      ).toBe(200);
    });
  },
);
