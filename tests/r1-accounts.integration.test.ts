import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import type { DraftModel } from "../src/missions/draft-assistant.js";
import { MISSIONS, contract, idemKey } from "./helpers/mission-fixtures.js";
import {
  LOCKOUT_MS,
  PASSWORD_MIN_LENGTH,
  SESSION_IDLE_MS,
  csrfFor,
  hashPassword,
  readSessionCookie,
  sessionCookie,
  verifyPassword,
} from "../src/network/user-auth.js";

/**
 * R1a — customer accounts and browser sessions, over real HTTP and PostgreSQL. A session resolves to one existing organization member,
 * so these tests check the cookie flags, CSRF and Origin enforcement, lockout, idle/absolute expiry, logout, tenant isolation and
 * role enforcement — not a second authorization model.
 */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";

describe("R1a password hashing and cookies (pure)", () => {
  it("hashes with a per-hash salt, verifies, and refuses malformed or oversized stored hashes", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/u);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "plaintext")).toBe(false);
    // stored data may not choose unbounded work
    expect(
      await verifyPassword(PASSWORD, a.replace("$16384$", "$4294967296$")),
    ).toBe(false);
  });
  it("the session cookie is HttpOnly, SameSite=Strict, host-only and path-scoped; only a well-formed value is read back", () => {
    const token = "A".repeat(43);
    const c = sessionCookie(token, 3600, true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/");
    expect(c).not.toMatch(/Domain=/iu);
    expect(sessionCookie(token, 1, false)).not.toContain("Secure");
    expect(readSessionCookie(`x=1; pf_session=${token}; y=2`)).toBe(token);
    expect(readSessionCookie("pf_session=short")).toBeNull();
    expect(readSessionCookie(`pf_session=${token}%0d%0a`)).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(csrfFor(token)).not.toContain(token);
    expect(csrfFor(token)).toBe(csrfFor(token));
  });
});

(url ? describe : describe.skip)(
  "R1a accounts and sessions (PostgreSQL + real HTTP host)",
  () => {
    let modelCalls = 0;
    const h = hostHarness({
      draftModel: (): DraftModel => ({
        complete: () => {
          modelCalls++;
          return Promise.resolve({
            status: "OK" as const,
            text: JSON.stringify({
              objective: "Buy two quiet keyboards",
              intendedOutcome: "Two keyboards ordered",
              successCriteria: ["Under budget"],
              suggestedBudgetMinor: 100_000,
              suggestedMaxPurchaseMinor: 30_000,
              suggestedCategory: "KEYBOARDS",
              questions: [],
            }),
          });
        },
      }),
      extraTruncate:
        "rate_limit_windows,user_sessions,user_memberships,user_accounts,missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates",
    });
    const send = (
      method: "GET" | "POST",
      path: string,
      opts: {
        body?: unknown;
        cookie?: string;
        origin?: string | null;
        csrf?: string;
        authorization?: string;
      } = {},
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          ...(opts.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.origin === null ? {} : { origin: opts.origin ?? h.origin }),
          ...(opts.csrf ? { "x-pf-csrf": opts.csrf } : {}),
          ...(opts.authorization ? { authorization: opts.authorization } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    const signup = (over: Record<string, unknown> = {}, origin?: string) =>
      send("POST", "/v1/app/signup", {
        body: {
          email: `Sam${Math.random().toString(36).slice(2, 8)}@Example.com`,
          password: PASSWORD,
          displayName: "Sam",
          organizationName: "Sam Studio",
          ...over,
        },
        ...(origin ? { origin } : {}),
      });
    const login = (
      email: string,
      password = PASSWORD,
      organizationId?: string,
    ) =>
      send("POST", "/v1/app/login", {
        body: {
          email,
          password,
          ...(organizationId ? { organizationId } : {}),
        },
      });
    type Signed = {
      email: string;
      organizationId: string;
      cookie: string;
      csrf: string;
      raw: string;
    };
    const signedIn = async (
      over: Record<string, unknown> = {},
    ): Promise<Signed> => {
      h.advance(61_000); // past the auth rate-limit window
      const email = `u${Math.random().toString(36).slice(2, 10)}@example.com`;
      const s = await signup({ email, ...over });
      expect(s.status, await s.clone().text()).toBe(201);
      const organizationId = ((await s.json()) as { organizationId: string })
        .organizationId;
      const l = await login(email);
      expect(l.status, await l.clone().text()).toBe(200);
      const setCookie = l.headers.get("set-cookie")!;
      const raw = /pf_session=([^;]+)/u.exec(setCookie)![1]!;
      const body = (await l.json()) as { csrfToken: string };
      return {
        email,
        organizationId,
        cookie: `pf_session=${raw}`,
        csrf: body.csrfToken,
        raw,
      };
    };

    it("signup validates, never stores the password, and a duplicate email is a conflict", async () => {
      expect((await signup({ password: "short" })).status).toBe(400);
      expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
      expect((await signup({ password: "aaaaaaaaaaaaaaaa" })).status).toBe(400);
      expect((await signup({ email: "not-an-email" })).status).toBe(400);
      expect((await signup({ extra: 1 })).status).toBe(400);
      const email = "dup@example.com";
      expect((await signup({ email })).status).toBe(201);
      const again = await signup({ email: "DUP@example.com" });
      expect([
        again.status,
        ((await again.json()) as { reason: string }).reason,
      ]).toEqual([409, "EMAIL_UNAVAILABLE"]);
      const [row] = await h.repo.sql<
        { password_hash: string }[]
      >`select password_hash from user_accounts where email = ${email}`;
      expect(row!.password_hash).toMatch(/^scrypt\$/u);
      expect(row!.password_hash).not.toContain(PASSWORD);
      // a signup from a foreign origin is refused (login/signup CSRF)
      expect((await signup({}, "https://evil.example")).status).toBe(403);
    });

    it("login: the cookie is HttpOnly/SameSite=Strict, the secret is not in the body or stored in clear, and every failure looks the same", async () => {
      const s = await signedIn();
      const l = await login(s.email);
      const cookie = l.headers.get("set-cookie")!;
      expect(cookie).toMatch(/HttpOnly/u);
      expect(cookie).toMatch(/SameSite=Strict/u);
      expect(cookie).not.toMatch(/Domain=/iu);
      const text = await l.text();
      const raw = /pf_session=([^;]+)/u.exec(cookie)![1]!;
      expect(text).not.toContain(raw);
      expect(text).not.toContain(PASSWORD);
      const rows = await h.repo.sql`select session_hash from user_sessions`;
      expect(JSON.stringify(rows)).not.toContain(raw);
      // wrong password and unknown account are indistinguishable
      const wrong = await login(s.email, "definitely not the password");
      const unknown = await login("nobody@example.com");
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(await wrong.json()).toEqual(await unknown.json());
      // login from a foreign origin is refused
      const evil = await send("POST", "/v1/app/login", {
        body: { email: s.email, password: PASSWORD },
        origin: "https://evil.example",
      });
      expect(evil.status).toBe(403);
      expect(evil.headers.get("set-cookie")).toBeNull();
      const noOrigin = await send("POST", "/v1/app/login", {
        body: { email: s.email, password: PASSWORD },
        origin: null,
      });
      expect(noOrigin.status).toBe(403);
    });

    it("five wrong passwords lock the account for a window, even for the right password; it unlocks afterwards", async () => {
      const s = await signedIn();
      h.advance(120_000);
      for (let i = 0; i < 5; i++)
        expect(
          (await login(s.email, "wrong password number " + i)).status,
        ).toBe(401);
      expect((await login(s.email)).status).toBe(401);
      h.advance(LOCKOUT_MS + 1_000);
      expect((await login(s.email)).status).toBe(200);
    });

    it("a session cookie reads with GET; a state change needs an allowed Origin AND the CSRF token", async () => {
      const s = await signedIn();
      const me = await send("GET", "/v1/app/me", { cookie: s.cookie });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as {
        csrfToken: string;
        member: { role: string; organizationId: string };
      };
      expect(meBody.member).toMatchObject({
        role: "OWNER",
        organizationId: s.organizationId,
      });
      expect(meBody.csrfToken).toBe(s.csrf);
      expect((await send("GET", MISSIONS, { cookie: s.cookie })).status).toBe(
        200,
      );
      const create = (o: { origin?: string | null; csrf?: string }) =>
        send("POST", MISSIONS, {
          cookie: s.cookie,
          body: { contract: contract(), idempotencyKey: idemKey("m") },
          ...o,
        });
      for (const o of [
        {},
        { csrf: "wrong" },
        { origin: "https://evil.example", csrf: s.csrf },
        { origin: null, csrf: s.csrf },
      ]) {
        const r = await create(o);
        expect(r.status, JSON.stringify(o)).toBe(403);
        expect(((await r.json()) as { reason: string }).reason).toBe(
          "CSRF_CHECK_FAILED",
        );
      }
      // with both, the request reaches the application (any answer except an authentication/CSRF refusal)
      const ok = await create({ csrf: s.csrf });
      expect([401, 403]).not.toContain(ok.status);
    });

    it("two people signed in from the same address have their own request budgets: one busy session cannot lock the other out", async () => {
      const a = await signedIn();
      const b = await signedIn();
      let limited = 0;
      for (let i = 0; i < 70; i++)
        if ((await send("GET", MISSIONS, { cookie: a.cookie })).status === 429)
          limited++;
      expect(limited).toBeGreaterThan(0); // the busy session is capped
      expect((await send("GET", MISSIONS, { cookie: b.cookie })).status).toBe(
        200,
      ); // the other person, same address, is not
    });

    it("safety packs: need a session and the CSRF token to apply, refuse malformed input, and never raise a limit", async () => {
      expect((await send("GET", "/v1/app/policy-packs")).status).toBe(401);
      const s = await signedIn();
      const list = await send("GET", "/v1/app/policy-packs", {
        cookie: s.cookie,
      });
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as { packs: { id: string }[] }).packs.map(
          (p) => p.id,
        ),
      ).toEqual(["CAUTIOUS", "STANDARD", "EXPLORATORY_ONLY"]);
      const limits = {
        totalBudgetMinor: 100_000,
        maxPurchaseMinor: 90_000,
        approveAboveMinor: 500,
        durationDays: 3,
      };
      const apply = (body: unknown, csrf: string | undefined = s.csrf) =>
        send("POST", "/v1/app/policy-packs/apply", {
          cookie: s.cookie,
          body,
          ...(csrf ? { csrf } : {}),
        });
      expect((await apply({ pack: "CAUTIOUS", limits }, "")).status).toBe(403);
      expect((await apply({ pack: "NOPE", limits })).status).toBe(400);
      expect(
        (await apply({ pack: "CAUTIOUS", limits: { ...limits, extra: 1 } }))
          .status,
      ).toBe(400);
      expect(
        (
          await apply({
            pack: "CAUTIOUS",
            limits: { ...limits, maxPurchaseMinor: 1.5 },
          })
        ).status,
      ).toBe(400);
      const ok = await apply({ pack: "CAUTIOUS", limits });
      expect(ok.status).toBe(200);
      const v = (await ok.json()) as {
        limits: typeof limits;
        changes: { field: string }[];
        lookOnly: boolean;
      };
      expect(v.limits).toEqual({ ...limits, maxPurchaseMinor: 20_000 });
      expect(v.changes.map((c) => c.field)).toEqual(["maxPurchaseMinor"]);
      expect(v.lookOnly).toBe(false);
    });

    it("the agents list carries each agent's readiness, derived from lifecycle and passport expiry", async () => {
      const s = await signedIn();
      const add = await send("POST", "/v1/app/agents", {
        cookie: s.cookie,
        csrf: s.csrf,
        body: { displayName: "Scout" },
      });
      expect(add.status).toBe(201);
      const agentId = ((await add.json()) as { agentId: string }).agentId;
      const get = async () =>
        (
          (await (
            await send("GET", "/v1/app/agents", { cookie: s.cookie })
          ).json()) as {
            agents: {
              agentId: string;
              lifecycle: string;
              readiness: { canAct: boolean; why?: string; rotation?: string };
            }[];
          }
        ).agents.find((a) => a.agentId === agentId)!;
      expect((await get()).readiness).toEqual({ canAct: true, rotation: "OK" });
      await h.repo
        .sql`update organization_agents set lifecycle = 'SUSPENDED' where agent_id = ${agentId}`;
      expect((await get()).readiness).toEqual({
        canAct: false,
        why: "SUSPENDED",
      });
      await h.repo
        .sql`update organization_agents set lifecycle = 'ACTIVE' where agent_id = ${agentId}`;
      const day = 86_400_000;
      const at = (ms: number) => new Date(h.now() + ms).toISOString();
      // inside the last week: still works, but says renew
      await h.repo
        .sql`update agent_passports set expires_at = ${at(3 * day)} where id = ${agentId}`;
      expect((await get()).readiness).toEqual({
        canAct: true,
        rotation: "ROTATE_SOON",
      });
      // past its end: it can no longer act
      await h.repo
        .sql`update agent_passports set issued_at = ${at(-10 * day)}, expires_at = ${at(-day)} where id = ${agentId}`;
      expect((await get()).readiness).toEqual({
        canAct: false,
        why: "CREDENTIAL_EXPIRED",
      });
    });

    it("tenant and role isolation: another account sees nothing of this organization; a VIEWER session cannot create", async () => {
      const a = await signedIn();
      const b = await signedIn();
      expect(a.organizationId).not.toBe(b.organizationId);
      // b cannot address a's organization: routes derive the organization from the session, never from the request
      const cross = await send("GET", `${MISSIONS}/msn_${"0".repeat(24)}`, {
        cookie: b.cookie,
      });
      expect(cross.status).toBe(404);
      // a second person given a VIEWER membership in a's organization
      const person = await signedIn();
      const viewerMember = "pfm_" + "a1".repeat(12);
      await h.repo
        .sql`insert into organization_members (member_id, secret_hash, organization_id, environment, display_name, role, status, created_by, created_at, expires_at)
        values (${viewerMember}, ${"f".repeat(64)}, ${a.organizationId}, 'SANDBOX', 'viewer', 'VIEWER', 'ACTIVE', 'test', ${h.iso()}, ${new Date(h.now() + 86_400_000).toISOString()})`;
      await h.repo
        .sql`insert into user_memberships (user_id, member_id, created_at)
        select user_id, ${viewerMember}, ${h.iso()} from user_accounts where email = ${person.email}`;
      const l = await login(person.email, PASSWORD, a.organizationId);
      expect(l.status).toBe(200);
      const raw = /pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!;
      const body = (await l.json()) as {
        csrfToken: string;
        member: { role: string; organizationId: string };
      };
      expect(body.member).toMatchObject({
        role: "VIEWER",
        organizationId: a.organizationId,
      });
      const create = await send("POST", MISSIONS, {
        cookie: `pf_session=${raw}`,
        csrf: body.csrfToken,
        body: { contract: contract(), idempotencyKey: idemKey("m") },
      });
      expect(create.status).toBe(403);
      expect(((await create.json()) as { reason: string }).reason).toBe(
        "PERMISSION_DENIED",
      );
      // the denial is audited under the member
      const denied = await h.repo
        .sql`select count(*)::int n from organization_audit_events where action = 'PERMISSION_DENIED' and actor_id = ${viewerMember}`;
      expect(denied[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it("agents: enrolled only by a role that may, listed only within the organization, and a credential is never issued across tenants", async () => {
      const a = await signedIn();
      const b = await signedIn();
      const post = (who: Signed, path: string, body: unknown = {}) =>
        send("POST", path, { cookie: who.cookie, csrf: who.csrf, body });
      const made = await post(a, "/v1/app/agents", { displayName: "Buyer" });
      expect(made.status).toBe(201);
      const { agentId } = (await made.json()) as { agentId: string };
      expect(
        (await post(a, "/v1/app/agents", { displayName: "" })).status,
      ).toBe(400);
      expect(
        (await post(a, "/v1/app/agents", { displayName: "x", extra: 1 }))
          .status,
      ).toBe(400);
      const mine = (await (
        await send("GET", "/v1/app/agents", { cookie: a.cookie })
      ).json()) as { agents: { agentId: string }[] };
      const theirs = (await (
        await send("GET", "/v1/app/agents", { cookie: b.cookie })
      ).json()) as { agents: unknown[] };
      expect(mine.agents.map((x) => x.agentId)).toEqual([agentId]);
      expect(theirs.agents).toEqual([]);
      // b cannot obtain a credential for a's agent
      const cross = await post(b, `/v1/app/agents/${agentId}/credentials`);
      expect(cross.status).toBe(404);
      const none = await h.repo
        .sql`select count(*)::int n from agent_credentials where agent_id = ${agentId}`;
      expect(none[0]!.n).toBe(0);
      // a can, and the token is shown once and stored only as a digest
      const ok = await post(a, `/v1/app/agents/${agentId}/credentials`);
      expect(ok.status).toBe(201);
      const tok = ((await ok.json()) as { token: string }).token;
      const stored = await h.repo
        .sql`select secret_hash from agent_credentials where agent_id = ${agentId}`;
      expect(JSON.stringify(stored)).not.toContain(tok.split(".")[1]!);
      // without the CSRF token nothing is enrolled
      const noCsrf = await send("POST", "/v1/app/agents", {
        cookie: a.cookie,
        body: { displayName: "Sneaky" },
      });
      expect(noCsrf.status).toBe(403);
      expect(
        (
          await h.repo
            .sql`select count(*)::int n from agent_passports where display_name = 'Sneaky'`
        )[0]!.n,
      ).toBe(0);
    });

    it("AI suggestion route: needs a session, the CSRF token and a role that may create missions; is capped; stores no text in the audit trail", async () => {
      const a = await signedIn();
      const draft = (
        who: { cookie: string; csrf: string } | null,
        text: unknown = "I need two quiet keyboards for the studio",
      ) =>
        send("POST", "/v1/app/missions/draft", {
          ...(who ? { cookie: who.cookie, csrf: who.csrf } : {}),
          body: { text },
        });
      expect((await draft(null)).status).toBe(401);
      const before = modelCalls;
      expect(
        (
          await send("POST", "/v1/app/missions/draft", {
            cookie: a.cookie,
            body: { text: "I need two quiet keyboards" },
          })
        ).status,
      ).toBe(403); // no CSRF
      expect(modelCalls).toBe(before);
      expect((await draft(a, 5)).status).toBe(400);
      const ok = await draft(a, "SECRET-GOAL-TEXT I need two quiet keyboards");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        source: string;
        notice: string;
        draft: { objective: string };
      };
      expect(body.source).toBe("MODEL");
      expect(body.notice).toContain("Review every field");
      expect(body.draft.objective).toBe("Buy two quiet keyboards");
      const audit = await h.repo
        .sql`select detail from organization_audit_events where action = 'MISSION_DRAFT_SUGGESTED' and organization_id = ${a.organizationId}`;
      expect(JSON.stringify(audit)).not.toContain("SECRET-GOAL-TEXT");
      expect(audit.length).toBeGreaterThanOrEqual(1);
      // a per-minute cap protects cost: the 7th request inside a minute never reaches the model
      // (the malformed request above also counted: 1 + 1 + 4 = 6 allowed per minute)
      for (let i = 0; i < 4; i++) expect((await draft(a)).status).toBe(200);
      const calls = modelCalls;
      expect((await draft(a)).status).toBe(429);
      expect(modelCalls).toBe(calls);
    });

    it("logout revokes the session; an idle session expires; a disabled account's sessions stop working", async () => {
      const s = await signedIn();
      expect(
        (
          await send("POST", "/v1/app/logout", {
            cookie: s.cookie,
            csrf: s.csrf,
            body: {},
          })
        ).status,
      ).toBe(200);
      expect(
        (await send("GET", "/v1/app/me", { cookie: s.cookie })).status,
      ).toBe(401);
      expect((await send("GET", MISSIONS, { cookie: s.cookie })).status).toBe(
        401,
      );
      // logout without the CSRF token is refused and the session survives
      const t = await signedIn();
      const noCsrf = await send("POST", "/v1/app/logout", {
        cookie: t.cookie,
        body: {},
      });
      expect(noCsrf.status).toBe(403);
      expect(
        (await send("GET", "/v1/app/me", { cookie: t.cookie })).status,
      ).toBe(200);
      // idle expiry
      h.advance(SESSION_IDLE_MS + 60_000);
      expect(
        (await send("GET", "/v1/app/me", { cookie: t.cookie })).status,
      ).toBe(401);
      // disabled account
      const u = await signedIn();
      await h.repo
        .sql`update user_accounts set status = 'DISABLED' where email = ${u.email}`;
      expect(
        (await send("GET", "/v1/app/me", { cookie: u.cookie })).status,
      ).toBe(401);
      expect((await login(u.email)).status).toBe(401);
    });

    it("a forged, malformed or header-injected session never authenticates", async () => {
      expect(
        (
          await send("GET", "/v1/app/me", {
            cookie: "pf_session=" + "A".repeat(43),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await send("GET", MISSIONS, {
            authorization: "Session " + "A".repeat(43),
          })
        ).status,
      ).toBe(401);
      expect(
        (await send("GET", MISSIONS, { cookie: "pf_session=short" })).status,
      ).toBe(401);
      expect((await send("GET", MISSIONS)).status).toBe(401);
    });
  },
);
