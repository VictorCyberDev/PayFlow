/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";

/** B3 — invitations and organization switching over real HTTP and PostgreSQL. */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";

(url ? describe : describe.skip)(
  "B3 invitations (PostgreSQL + real HTTP host)",
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
      o: {
        body?: unknown;
        cookie?: string;
        csrf?: string;
        origin?: string | null;
      } = {},
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          ...(o.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...(o.origin === null ? {} : { origin: o.origin ?? h.origin }),
          ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
    type Who = { email: string; cookie: string; csrf: string };
    let n = 0;
    const person = async (verified = true): Promise<Who> => {
      h.advance(61_000);
      const email = `p${++n}${Math.random().toString(36).slice(2, 6)}@example.com`;
      const r = await call("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: `Person ${n}`,
          organizationName: `Org ${n}`,
        },
      });
      expect(r.status).toBe(201);
      if (verified)
        await h.repo
          .sql`update user_accounts set email_verified_at = ${h.iso()} where email = ${email}`;
      return signIn(email);
    };
    const signIn = async (
      email: string,
      organizationId?: string,
    ): Promise<Who> => {
      h.advance(1_000);
      const l = await call("POST", "/v1/app/login", {
        body: {
          email,
          password: PASSWORD,
          ...(organizationId ? { organizationId } : {}),
        },
      });
      expect(l.status).toBe(200);
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      const me = await (await call("GET", "/v1/app/me", { cookie })).json();
      return { email, cookie, csrf: me.csrfToken };
    };
    const as = (w: Who) => ({ cookie: w.cookie, csrf: w.csrf });
    const invite = (w: Who, email: string, role = "APPROVER") =>
      call("POST", "/v1/app/invitations", { ...as(w), body: { email, role } });
    const tokenFor = async (email: string) => {
      const [m] = await h.repo
        .sql`select body from email_outbox where to_email = ${email} and template = 'INVITE' order by created_at desc, outbox_id desc limit 1`;
      return /token=([A-Za-z0-9_-]+)/u.exec(String(m!.body))![1]!;
    };
    const accept = (w: Who, token: string) =>
      call("POST", "/v1/app/invitations/accept", { ...as(w), body: { token } });
    const orgOf = async (w: Who) =>
      (await (await call("GET", "/v1/app/me", { cookie: w.cookie })).json())
        .member;

    it("an owner invites; the link is queued; the list shows the state without any token; the audit trail has no address or token", async () => {
      const owner = await person();
      const guest = await person();
      const r = await invite(owner, guest.email);
      const b = await r.json();
      expect(r.status).toBe(202);
      expect(b.queued).toBe(true);
      expect(b.emailDelivery).toBe("ENABLED");
      const token = await tokenFor(guest.email);
      expect(JSON.stringify(b)).not.toContain(token);
      const list = await call("GET", "/v1/app/invitations", {
        cookie: owner.cookie,
      });
      const text = await list.text();
      expect(JSON.parse(text).invitations[0]).toMatchObject({
        email: guest.email,
        role: "APPROVER",
        state: "OPEN",
      });
      expect(text).not.toContain(token);
      const audit = JSON.stringify(
        await h.repo
          .sql`select action, detail from organization_audit_events where action like 'INVITATION_%'`,
      );
      expect(audit).toContain("INVITATION_CREATED");
      expect(audit).not.toContain(guest.email);
      expect(audit).not.toContain(token);
    });

    it("only the invited, verified address can accept; anyone else is told nothing; a replay is refused; the new role applies after switching", async () => {
      const owner = await person();
      const guest = await person(false); // address not yet verified
      const stranger = await person();
      await invite(owner, guest.email, "VIEWER");
      const token = await tokenFor(guest.email);
      // someone else holding the link
      const wrong = await accept(stranger, token);
      expect([wrong.status, (await wrong.json()).reason]).toEqual([
        410,
        "INVALID_OR_EXPIRED",
      ]);
      // the right address, not yet verified
      const early = await accept(guest, token);
      expect([early.status, (await early.json()).reason]).toEqual([
        403,
        "EMAIL_NOT_VERIFIED",
      ]);
      await h.repo
        .sql`update user_accounts set email_verified_at = ${h.iso()} where email = ${guest.email}`;
      const ok = await accept(guest, token);
      expect(ok.status).toBe(200);
      expect((await ok.json()).role).toBe("VIEWER");
      expect((await accept(guest, token)).status).toBe(410); // replay
      // the guest now belongs to two organizations and can switch
      const orgs = await (
        await call("GET", "/v1/app/organizations", { cookie: guest.cookie })
      ).json();
      expect(orgs.organizations).toHaveLength(2);
      const ownerOrg = (await orgOf(owner)).organizationId;
      expect((await orgOf(guest)).organizationId).not.toBe(ownerOrg);
      const sw = await call("POST", "/v1/app/organizations/switch", {
        ...as(guest),
        body: { organizationId: ownerOrg },
      });
      expect(sw.status).toBe(200);
      expect(await orgOf(guest)).toMatchObject({
        organizationId: ownerOrg,
        role: "VIEWER",
      });
      // a viewer cannot manage members
      for (const [m, p] of [
        ["GET", "/v1/app/invitations"],
        ["POST", "/v1/app/invitations"],
      ] as const) {
        const r = await call(m, p, {
          ...as(guest),
          body:
            m === "POST"
              ? { email: "x@example.com", role: "VIEWER" }
              : undefined,
        });
        expect([p, r.status]).toEqual([p, 403]);
      }
      // switching into an organization the person does not belong to reaches nothing
      const other = (await orgOf(stranger)).organizationId;
      expect(
        (
          await call("POST", "/v1/app/organizations/switch", {
            ...as(guest),
            body: { organizationId: other },
          })
        ).status,
      ).toBe(404);
      expect((await orgOf(guest)).organizationId).toBe(ownerOrg);
    });

    it("revoking kills the link; inviting again replaces the older link; an expired link is refused and listed as expired", async () => {
      const owner = await person();
      const guest = await person();
      await invite(owner, guest.email);
      const first = await tokenFor(guest.email);
      const inv = (
        await (
          await call("GET", "/v1/app/invitations", { cookie: owner.cookie })
        ).json()
      ).invitations[0];
      expect(
        (
          await call("POST", `/v1/app/invitations/${inv.invitationId}/revoke`, {
            ...as(owner),
            body: {},
          })
        ).status,
      ).toBe(200);
      expect((await accept(guest, first)).status).toBe(410);
      h.advance(1_000);
      await invite(owner, guest.email, "AUDITOR");
      const second = await tokenFor(guest.email);
      h.advance(1_000);
      await invite(owner, guest.email, "DEVELOPER"); // replaces the AUDITOR one
      const third = await tokenFor(guest.email);
      expect(new Set([first, second, third]).size).toBe(3);
      expect((await accept(guest, second)).status).toBe(410);
      h.advance(8 * 86_400_000);
      const fresh = await signIn(guest.email);
      expect((await accept(fresh, third)).status).toBe(410);
      const owner2 = await signIn(owner.email);
      const states = (
        await (
          await call("GET", "/v1/app/invitations", { cookie: owner2.cookie })
        ).json()
      ).invitations.map((i: any) => i.state);
      expect(states).toContain("EXPIRED");
    });

    it("OWNER cannot be invited; an existing member cannot be invited again; the preview shows only a masked address and needs an allowed Origin", async () => {
      const owner = await person();
      const guest = await person();
      expect((await invite(owner, guest.email, "OWNER")).status).toBe(400);
      expect((await invite(owner, "not an address")).status).toBe(400);
      expect((await invite(owner, owner.email)).status).toBe(409);
      await invite(owner, guest.email, "FINANCE_ADMIN");
      const token = await tokenFor(guest.email);
      const p = await call("POST", "/v1/app/invitations/preview", {
        body: { token },
      });
      const view = await p.json();
      expect(p.status).toBe(200);
      expect(view.role).toBe("FINANCE_ADMIN");
      expect(view.organizationName).toMatch(/^Org /u);
      expect(view.emailHint).toContain("***");
      expect(JSON.stringify(view)).not.toContain(guest.email);
      expect(
        (
          await call("POST", "/v1/app/invitations/preview", {
            body: { token: "x".repeat(43) },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call("POST", "/v1/app/invitations/preview", {
            body: { token },
            origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
      // joining as the member who becomes a member again is a no-op acceptance
      expect((await accept(guest, token)).status).toBe(200);
      await invite(owner, "someone.else@example.com");
      expect((await invite(owner, guest.email)).status).toBe(409);
    });

    it("two simultaneous accepts of one link: exactly one member row is made", async () => {
      const owner = await person();
      const guest = await person();
      await invite(owner, guest.email);
      const token = await tokenFor(guest.email);
      const rs = await Promise.all(
        [1, 2, 3, 4].map(() => accept(guest, token)),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([200, 410, 410, 410]);
      const count = await h.repo
        .sql`select count(*)::int n from organization_members where organization_id = ${(await orgOf(owner)).organizationId} and created_by like 'invitation:%'`;
      expect(count[0]!.n).toBe(1);
    });

    it("the database refuses to change a finished invitation, to widen a role, to grant OWNER, or to delete one", async () => {
      const owner = await person();
      const guest = await person();
      await invite(owner, guest.email);
      const token = await tokenFor(guest.email);
      await accept(guest, token);
      const [row] = await h.repo
        .sql`select invitation_id from organization_invitations limit 1`;
      const id = String(row!.invitation_id);
      await expect(
        h.repo
          .sql`update organization_invitations set revoked_at = now() where invitation_id = ${id}`,
      ).rejects.toThrow(/finished/iu);
      await expect(
        h.repo
          .sql`delete from organization_invitations where invitation_id = ${id}`,
      ).rejects.toThrow(/never deleted|finished/iu);
      await invite(owner, "third@example.com", "VIEWER");
      const [open] = await h.repo
        .sql`select invitation_id from organization_invitations where email = 'third@example.com'`;
      await expect(
        h.repo
          .sql`update organization_invitations set role = 'FINANCE_ADMIN' where invitation_id = ${String(open!.invitation_id)}`,
      ).rejects.toThrow(/never change/iu);
      await expect(
        h.repo
          .sql`update organization_invitations set role = 'OWNER' where invitation_id = ${String(open!.invitation_id)}`,
      ).rejects.toThrow();
    });
  },
);
