/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { MemberStore } from "../src/network/rbac.js";

/** B4 — member management over real HTTP and PostgreSQL: roles, removal, leaving, and never losing the last owner. */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";

(url ? describe : describe.skip)(
  "B4 members (PostgreSQL + real HTTP host)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts,organization_invitations",
      emailSender: () => ({ send: () => Promise.resolve({ outcome: "SENT" }) }),
    });
    beforeEach(async () => {
      await h.repo
        .sql`truncate email_outbox, user_tokens, organization_invitations`;
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
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      const me = await (await call("GET", "/v1/app/me", { cookie })).json();
      return { email, cookie, csrf: me.csrfToken };
    };
    const person = async (): Promise<Who> => {
      h.advance(61_000);
      const email = `m${++n}${Math.random().toString(36).slice(2, 6)}@example.com`;
      const r = await call("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: `Person ${n}`,
          organizationName: `Org ${n}`,
        },
      });
      expect(r.status).toBe(201);
      await h.repo
        .sql`update user_accounts set email_verified_at = ${h.iso()} where email = ${email}`;
      return signIn(email);
    };
    const as = (w: Who) => ({ cookie: w.cookie, csrf: w.csrf });
    const me = async (w: Who) =>
      (await (await call("GET", "/v1/app/me", { cookie: w.cookie })).json())
        .member;
    /** Owner invites `guest` with `role`; guest accepts and is switched into the owner's organization. */
    const join = async (owner: Who, guest: Who, role: string): Promise<Who> => {
      h.advance(1_000);
      expect(
        (
          await call("POST", "/v1/app/invitations", {
            ...as(owner),
            body: { email: guest.email, role },
          })
        ).status,
      ).toBe(202);
      const [m] = await h.repo
        .sql`select body from email_outbox where to_email = ${guest.email} and template = 'INVITE' order by created_at desc, outbox_id desc limit 1`;
      const token = /token=([A-Za-z0-9_-]+)/u.exec(String(m!.body))![1]!;
      const a = await call("POST", "/v1/app/invitations/accept", {
        ...as(guest),
        body: { token },
      });
      expect(a.status).toBe(200);
      const orgId = (await a.json()).organizationId;
      expect(
        (
          await call("POST", "/v1/app/organizations/switch", {
            ...as(guest),
            body: { organizationId: orgId },
          })
        ).status,
      ).toBe(200);
      return guest;
    };
    const listOf = async (w: Who) =>
      await (await call("GET", "/v1/app/members", { cookie: w.cookie })).json();
    /** A member's id, found in a manager's list by address. */
    const idOf = async (manager: Who, w: Who) =>
      (await listOf(manager)).members.find((x: any) => x.email === w.email)
        .memberId as string;

    it("lists the organization's people; only a manager sees addresses; a role change applies to the person's live session at once and is audited", async () => {
      const owner = await person();
      const guest = await join(owner, await person(), "APPROVER");
      const ownerList = await listOf(owner);
      expect(ownerList.canManage).toBe(true);
      expect(ownerList.members.map((x: any) => x.email).sort()).toEqual(
        [owner.email, guest.email].sort(),
      );
      const guestView = await call("GET", "/v1/app/members", {
        cookie: guest.cookie,
      });
      const text = await guestView.text();
      expect(text).not.toContain(owner.email);
      expect(text).not.toContain(guest.email);
      const gid = await idOf(owner, guest);
      expect((await me(guest)).role).toBe("APPROVER");
      const r = await call("POST", `/v1/app/members/${gid}/role`, {
        ...as(owner),
        body: { role: "FINANCE_ADMIN" },
      });
      expect([r.status, (await r.json()).changed]).toEqual([200, true]);
      expect((await me(guest)).role).toBe("FINANCE_ADMIN"); // same session, no sign-in needed
      const again = await call("POST", `/v1/app/members/${gid}/role`, {
        ...as(owner),
        body: { role: "FINANCE_ADMIN" },
      });
      expect((await again.json()).changed).toBe(false);
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/role`, {
            ...as(owner),
            body: { role: "ROOT" },
          })
        ).status,
      ).toBe(400);
      const audit = JSON.stringify(
        await h.repo
          .sql`select action, detail from organization_audit_events where action = 'MEMBER_ROLE_CHANGED'`,
      );
      expect(audit).toContain('"from":"APPROVER"');
      expect(audit).toContain('"to":"FINANCE_ADMIN"');
      expect(audit).not.toContain(guest.email);
    });

    it("a non-manager cannot change roles or remove anyone, including themselves up to owner", async () => {
      const owner = await person();
      const guest = await join(owner, await person(), "FINANCE_ADMIN");
      const gid = await idOf(owner, guest);
      const oid = (await listOf(owner)).you as string;
      for (const [p, b] of [
        [`/v1/app/members/${gid}/role`, { role: "OWNER" }],
        [`/v1/app/members/${oid}/role`, { role: "VIEWER" }],
        [`/v1/app/members/${oid}/remove`, {}],
      ] as const) {
        const r = await call("POST", p, { ...as(guest), body: b });
        expect([p, r.status]).toEqual([p, 403]);
      }
      expect((await me(guest)).role).toBe("FINANCE_ADMIN");
    });

    it("the last owner can be neither demoted, removed nor allowed to leave; with a second owner they can", async () => {
      const owner = await person();
      const oid = (await listOf(owner)).you as string;
      const sole = await call("POST", `/v1/app/members/${oid}/role`, {
        ...as(owner),
        body: { role: "VIEWER" },
      });
      expect([sole.status, (await sole.json()).reason]).toEqual([
        409,
        "LAST_OWNER",
      ]);
      expect(
        (
          await call("POST", `/v1/app/members/${oid}/remove`, {
            ...as(owner),
            body: {},
          })
        ).status,
      ).toBe(409); // use leave
      const leave = await call("POST", "/v1/app/leave", {
        ...as(owner),
        body: {},
      });
      expect([leave.status, (await leave.json()).reason]).toEqual([
        409,
        "LAST_OWNER",
      ]);
      expect((await me(owner)).role).toBe("OWNER");
      const guest = await join(owner, await person(), "VIEWER");
      const gid = await idOf(owner, guest);
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/role`, {
            ...as(owner),
            body: { role: "OWNER" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call("POST", `/v1/app/members/${oid}/role`, {
            ...as(owner),
            body: { role: "VIEWER" },
          })
        ).status,
      ).toBe(200);
      expect((await me(owner)).role).toBe("VIEWER");
      expect((await me(guest)).role).toBe("OWNER");
    });

    it("two owners demoting each other at the same moment cannot leave the organization without an owner", async () => {
      const a = await person();
      const b = await join(a, await person(), "VIEWER");
      const aid = (await listOf(a)).you as string;
      const bid = await idOf(a, b);
      await call("POST", `/v1/app/members/${bid}/role`, {
        ...as(a),
        body: { role: "OWNER" },
      });
      const rs = await Promise.all([
        call("POST", `/v1/app/members/${bid}/role`, {
          ...as(a),
          body: { role: "VIEWER" },
        }),
        call("POST", `/v1/app/members/${aid}/role`, {
          ...as(b),
          body: { role: "VIEWER" },
        }),
      ]);
      const codes = rs.map((r) => r.status).sort();
      // either one of them wins and the other is refused or finds itself no longer an owner
      expect(codes.filter((c) => c === 200).length).toBe(1);
      const owners = await h.repo
        .sql`select count(*)::int n from organization_members where organization_id = ${(await me(a)).organizationId} and role = 'OWNER' and status = 'ACTIVE'`;
      expect(owners[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it("removing someone ends their sessions in this organization and takes it off their list; leaving signs out of it; other organizations are untouched", async () => {
      const owner = await person();
      const guest = await join(owner, await person(), "AUDITOR");
      const gid = await idOf(owner, guest);
      const outsider = await person();
      // an owner of another organization cannot touch this one's members
      const oidOther = (await listOf(outsider)).you as string;
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/remove`, {
            ...as(outsider),
            body: {},
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/role`, {
            ...as(outsider),
            body: { role: "VIEWER" },
          })
        ).status,
      ).toBe(404);
      void oidOther;
      const r = await call("POST", `/v1/app/members/${gid}/remove`, {
        ...as(owner),
        body: {},
      });
      expect([r.status, (await r.json()).removed]).toEqual([200, true]);
      expect(
        (await call("GET", "/v1/app/me", { cookie: guest.cookie })).status,
      ).toBe(401); // that session is gone
      const back = await signIn(guest.email); // their own organization still works
      const orgs = (
        await (
          await call("GET", "/v1/app/organizations", { cookie: back.cookie })
        ).json()
      ).organizations;
      expect(orgs).toHaveLength(1);
      expect(
        (
          await call("POST", `/v1/app/members/${gid}/remove`, {
            ...as(owner),
            body: {},
          })
        ).status,
      ).toBe(404); // already gone
      expect((await listOf(owner)).members).toHaveLength(1);
      // leaving
      const other = await join(owner, back, "VIEWER");
      const leave = await call("POST", "/v1/app/leave", {
        ...as(other),
        body: {},
      });
      expect([leave.status, (await leave.json()).left]).toEqual([200, true]);
      expect(leave.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/iu);
      expect(
        (await call("GET", "/v1/app/me", { cookie: other.cookie })).status,
      ).toBe(401);
      expect((await listOf(owner)).members).toHaveLength(1);
    });

    it("the owner-count lock holds under repeated head-on races: two owners demoting each other 40 times never leaves zero owners", async () => {
      const a = await person();
      const b = await join(a, await person(), "VIEWER");
      const aid = (await listOf(a)).you as string;
      const bid = await idOf(a, b);
      const org = (await me(a)).organizationId as string;
      const store = new MemberStore(h.repo.sql);
      let both = 0;
      for (let i = 0; i < 40; i++) {
        await h.repo
          .sql`update organization_members set role = 'OWNER' where member_id in (${aid}, ${bid})`;
        const rs = await Promise.all([
          store.changeRole(org, "SANDBOX", aid, "VIEWER", h.iso()),
          store.changeRole(org, "SANDBOX", bid, "VIEWER", h.iso()),
        ]);
        const owners = await h.repo
          .sql`select count(*)::int n from organization_members where organization_id = ${org} and role = 'OWNER' and status = 'ACTIVE'`;
        expect(owners[0]!.n, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
        if (rs.every((r) => r === "CHANGED")) both++;
      }
      expect(both).toBe(0);
    });

    it("CSRF is required for every change", async () => {
      const owner = await person();
      const oid = (await listOf(owner)).you as string;
      for (const p of [
        `/v1/app/members/${oid}/role`,
        `/v1/app/members/${oid}/remove`,
        "/v1/app/leave",
      ]) {
        const r = await call("POST", p, {
          cookie: owner.cookie,
          body: { role: "VIEWER" },
        });
        expect([p, r.status]).toEqual([p, 403]);
      }
    });
  },
);
