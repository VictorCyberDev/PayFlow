/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";

/** B2 — a person can see where they are signed in and end the other sign-ins; they can never touch someone else's. */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";

(url ? describe : describe.skip)(
  "B2 sign-in list and revoke (PostgreSQL + real HTTP host)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts",
    });
    const send = (
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
    const signup = async () => {
      h.advance(61_000);
      const email = `u${Math.random().toString(36).slice(2, 9)}@example.com`;
      const r = await send("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: "Sam",
          organizationName: "Sam Studio",
        },
      });
      expect(r.status).toBe(201);
      return email;
    };
    const login = async (email: string) => {
      h.advance(1_000);
      const r = await send("POST", "/v1/app/login", {
        body: { email, password: PASSWORD },
      });
      expect(r.status).toBe(200);
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(r.headers.get("set-cookie")!)![1]!}`;
      const me = await (await send("GET", "/v1/app/me", { cookie })).json();
      return { cookie, csrf: me.csrfToken as string };
    };

    it("lists own sign-ins, marks the current one, and revokes another without ending this one", async () => {
      const email = await signup();
      const a = await login(email);
      const b = await login(email);
      const listed = await (
        await send("GET", "/v1/app/sessions", { cookie: a.cookie })
      ).json();
      expect(listed.sessions.length).toBeGreaterThanOrEqual(2);
      expect(listed.sessions.filter((s: any) => s.current)).toHaveLength(1);
      const other = listed.sessions.find((s: any) => !s.current);
      expect(JSON.stringify(listed)).not.toContain(a.cookie.split("=")[1]);

      // Ending the session in use through this route is refused: that is sign out.
      const current = listed.sessions.find((s: any) => s.current);
      const self = await send("POST", `/v1/app/sessions/${current.id}/revoke`, {
        cookie: a.cookie,
        csrf: a.csrf,
      });
      expect(self.status).toBe(409);

      const gone = await send("POST", `/v1/app/sessions/${other.id}/revoke`, {
        cookie: a.cookie,
        csrf: a.csrf,
      });
      expect(gone.status).toBe(200);
      expect(
        (await send("GET", "/v1/app/me", { cookie: a.cookie })).status,
      ).toBe(200);
      // One of the two is now dead; the revoked one is whichever id we picked.
      const after = await (
        await send("GET", "/v1/app/sessions", { cookie: a.cookie })
      ).json();
      expect(
        after.sessions.find((s: any) => s.id === other.id),
      ).toBeUndefined();
      void b;
    });

    it("one person cannot see or end another person's sign-ins", async () => {
      const e1 = await signup();
      const e2 = await signup();
      const one = await login(e1);
      const two = await login(e2);
      const theirs = await (
        await send("GET", "/v1/app/sessions", { cookie: two.cookie })
      ).json();
      const mine = await (
        await send("GET", "/v1/app/sessions", { cookie: one.cookie })
      ).json();
      expect(
        mine.sessions.some((s: any) =>
          theirs.sessions.some((t: any) => t.id === s.id),
        ),
      ).toBe(false);
      const r = await send(
        "POST",
        `/v1/app/sessions/${theirs.sessions[0].id}/revoke`,
        { cookie: one.cookie, csrf: one.csrf },
      );
      expect(r.status).toBe(404);
      expect(
        (await send("GET", "/v1/app/me", { cookie: two.cookie })).status,
      ).toBe(200);
    });

    it("revoke-others ends every other sign-in and keeps this one; a missing CSRF token is refused", async () => {
      const email = await signup();
      const a = await login(email);
      const b = await login(email);
      const noCsrf = await send("POST", "/v1/app/sessions/revoke-others", {
        cookie: a.cookie,
      });
      expect(noCsrf.status).toBeGreaterThanOrEqual(400);
      const r = await send("POST", "/v1/app/sessions/revoke-others", {
        cookie: a.cookie,
        csrf: a.csrf,
      });
      expect(r.status).toBe(200);
      expect((await r.json()).revoked).toBeGreaterThanOrEqual(1);
      expect(
        (await send("GET", "/v1/app/me", { cookie: b.cookie })).status,
      ).toBe(401);
      expect(
        (await send("GET", "/v1/app/me", { cookie: a.cookie })).status,
      ).toBe(200);
    });

    it("sign out everywhere ends every session including this one; expired and idle sessions are not listed", async () => {
      const email = await signup();
      const a = await login(email);
      const b = await login(email);
      const r = await send("POST", "/v1/app/sessions/revoke-all", {
        cookie: a.cookie,
        csrf: a.csrf,
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/iu);
      expect(
        (await send("GET", "/v1/app/me", { cookie: a.cookie })).status,
      ).toBe(401);
      expect(
        (await send("GET", "/v1/app/me", { cookie: b.cookie })).status,
      ).toBe(401);
      // a fresh sign-in, then the clock moves past the idle window: it is neither usable nor listed
      const c = await login(email);
      h.advance(40 * 24 * 3600_000);
      expect(
        (await send("GET", "/v1/app/sessions", { cookie: c.cookie })).status,
      ).toBe(401);
      const d = await login(email);
      const listed = await (
        await send("GET", "/v1/app/sessions", { cookie: d.cookie })
      ).json();
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0].current).toBe(true);
    });

    it("concurrent revocation of the same sign-in is safe: one wins, the other sees it already gone", async () => {
      const email = await signup();
      const a = await login(email);
      await login(email);
      const listed = await (
        await send("GET", "/v1/app/sessions", { cookie: a.cookie })
      ).json();
      const other = listed.sessions.find((s: any) => !s.current);
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          send("POST", `/v1/app/sessions/${other.id}/revoke`, {
            cookie: a.cookie,
            csrf: a.csrf,
          }),
        ),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 404)).toHaveLength(3);
      expect(
        (await send("GET", "/v1/app/me", { cookie: a.cookie })).status,
      ).toBe(200);
    });
  },
);
