import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { handleAccountRead, handleAccountWrite } from "../api/account.js";
import {
  readSessionCookie,
  UserAuthService,
} from "../src/network/user-auth.js";

/**
 * D3 — the public application's account door, over real PostgreSQL.
 *
 * The security itself is already covered by tests/r1-accounts.integration.test.ts against the gateway. What is new here is
 * the adapter: cookie flags, CSRF on a state change, same-origin, the refusals a founder reads, and what happens on a
 * deployment that has no database at all.
 */
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://payflow.example";
const PASSWORD = "correct horse battery staple";

let sql: ReturnType<typeof postgres>;
let service: UserAuthService;

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, prepare: false, onnotice: () => undefined });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  for (const f of (await readdir("db/migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await sql.unsafe(await readFile("db/migrations/" + f, "utf8"));
  service = new UserAuthService({ sql, now: () => new Date().toISOString() });
});
afterAll(async () => {
  if (url) await sql?.end({ timeout: 5 });
});

let caller = 0;
function post(
  body: unknown,
  init: {
    origin?: string;
    cookie?: string;
    csrf?: string;
    proto?: string;
  } = {},
) {
  caller += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: init.origin ?? ORIGIN,
    "x-forwarded-for": `198.51.100.${caller % 250}`,
    "x-forwarded-proto": init.proto ?? "https",
  };
  if (init.cookie) headers["cookie"] = init.cookie;
  if (init.csrf) headers["x-payflow-csrf"] = init.csrf;
  return new Request(`${ORIGIN}/api/account`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function get(init: { cookie?: string; origin?: string } = {}) {
  caller += 1;
  const headers: Record<string, string> = {
    origin: init.origin ?? ORIGIN,
    "x-forwarded-for": `198.51.100.${caller % 250}`,
    "x-forwarded-proto": "https",
  };
  if (init.cookie) headers["cookie"] = init.cookie;
  return new Request(`${ORIGIN}/api/account`, { method: "GET", headers });
}
const signup = (email: string, extra: Record<string, unknown> = {}) => ({
  action: "signup",
  email,
  password: PASSWORD,
  displayName: "Ada Founder",
  organizationName: "Ada Studio",
  ...extra,
});
let n = 0;
const freshEmail = () => `founder${(n += 1)}.${Date.now()}@example.com`;

describe.skipIf(!url)("the public account door", () => {
  it("creates an account, signs the founder straight in, and sets a cookie a script cannot read", async () => {
    const res = await handleAccountWrite(post(signup(freshEmail())), service);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
    const body = (await res.json()) as Record<string, string>;
    expect(body.status).toBe("SIGNED_IN");
    // The body carries an identity and a CSRF token — never the session secret or anything derived from the password.
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain(readSessionCookie(cookie) ?? "<none>");
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("recognises that session on a later request, and forgets it after sign-out", async () => {
    const created = await handleAccountWrite(
      post(signup(freshEmail())),
      service,
    );
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = ((await created.json()) as { csrfToken: string }).csrfToken;

    const read = await handleAccountRead(get({ cookie }), service);
    const who = (await read.json()) as Record<string, unknown>;
    expect(who.status).toBe("SIGNED_IN");
    expect((who.workspace as { role: string }).role).toBe("OWNER");
    // The CSRF token survives a reload, because it is derived from the session secret rather than stored in the page.
    expect(who.csrfToken).toBe(csrf);

    const out = await handleAccountWrite(
      post({ action: "logout" }, { cookie, csrf }),
      service,
    );
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await handleAccountRead(get({ cookie }), service);
    expect(((await after.json()) as { status: string }).status).toBe(
      "SIGNED_OUT",
    );
  });

  it("will not sign a founder out on someone else's say-so, but still clears the cookie here", async () => {
    const created = await handleAccountWrite(
      post(signup(freshEmail())),
      service,
    );
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const forged = await handleAccountWrite(
      post({ action: "logout" }, { cookie, csrf: "not-the-token" }),
      service,
    );
    expect(forged.status).toBe(403);
    expect(forged.headers.get("set-cookie")).toContain("Max-Age=0");
    // The real session is untouched: a forged sign-out must not be a way to end someone's session.
    const still = await handleAccountRead(get({ cookie }), service);
    expect(((await still.json()) as { status: string }).status).toBe(
      "SIGNED_IN",
    );
  });

  it("answers every credential failure the same way", async () => {
    const email = freshEmail();
    await handleAccountWrite(post(signup(email)), service);
    const wrongPassword = await handleAccountWrite(
      post({ action: "login", email, password: "wrong password entirely" }),
      service,
    );
    const unknownEmail = await handleAccountWrite(
      post({
        action: "login",
        email: freshEmail(),
        password: "wrong password entirely",
      }),
      service,
    );
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await unknownEmail.text());
  });

  it("refuses a weak password and a second account on the same email", async () => {
    const weak = await handleAccountWrite(
      post(signup(freshEmail(), { password: "aaaaaaaaaaaaaaaa" })),
      service,
    );
    expect(weak.status).toBe(400);
    expect(await weak.text()).toMatch(/longer password/i);

    const email = freshEmail();
    expect(
      (await handleAccountWrite(post(signup(email)), service)).status,
    ).toBe(200);
    const again = await handleAccountWrite(post(signup(email)), service);
    expect(again.status).toBe(409);
    expect(await again.text()).toMatch(/sign in instead/i);
  });

  it("signs in over plain http without marking the cookie Secure, and marks it over https", async () => {
    const email = freshEmail();
    await handleAccountWrite(post(signup(email)), service);
    const plain = await handleAccountWrite(
      post({ action: "login", email, password: PASSWORD }, { proto: "http" }),
      service,
    );
    expect(plain.headers.get("set-cookie")).not.toContain("Secure");
    const tls = await handleAccountWrite(
      post({ action: "login", email, password: PASSWORD }),
      service,
    );
    expect(tls.headers.get("set-cookie")).toContain("Secure");
  });

  it("only answers its own application", async () => {
    for (const r of [
      await handleAccountWrite(
        post(signup(freshEmail()), { origin: "https://evil.example" }),
        service,
      ),
      await handleAccountRead(get({ origin: "https://evil.example" }), service),
    ])
      expect(r.status).toBe(403);
  });

  it("never reports an infrastructure fault to a founder", async () => {
    const broken = new UserAuthService({
      sql: postgres("postgres://nobody@127.0.0.1:1/none", {
        max: 1,
        connect_timeout: 1,
        prepare: false,
      }),
      now: () => new Date().toISOString(),
    });
    const res = await handleAccountWrite(
      post({ action: "login", email: freshEmail(), password: PASSWORD }),
      broken,
    );
    expect(res.ok).toBe(false);
    const text = await res.text();
    expect(text).not.toMatch(/postgres|ECONNREFUSED|stack|at Object|password/i);
    expect(text).toMatch(/Nothing was changed/);
  });
});

describe("a deployment with no database", () => {
  it("says accounts are not switched on instead of pretending they exist", async () => {
    const read = await handleAccountRead(get(), undefined);
    const body = (await read.json()) as Record<string, string>;
    expect(read.status).toBe(200);
    expect(body.status).toBe("UNCONFIGURED");
    expect(body.message).toMatch(/not switched on/i);
    // And it still tells the founder what they CAN do, rather than presenting a dead end.
    expect(body.message).toMatch(/guided demo/i);

    const write = await handleAccountWrite(
      post(signup("a@example.com")),
      undefined,
    );
    expect(write.status).toBe(503);
    expect(await write.text()).toMatch(/not switched on/i);
  });
});

describe.skipIf(!url)("the account door's own rate ceiling", () => {
  it("leaves room for signing in, out and back in without telling an honest founder to wait", async () => {
    const email = freshEmail();
    const fixed = (body: unknown, extra: Record<string, string> = {}) =>
      new Request(`${ORIGIN}/api/account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          // One founder, one address: the whole point is that normal use does not exhaust it.
          "x-forwarded-for": "203.0.113.77",
          "x-forwarded-proto": "https",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    const created = await handleAccountWrite(fixed(signup(email)), service);
    expect(created.status).toBe(200);
    let cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    let csrf = ((await created.json()) as { csrfToken: string }).csrfToken;
    // Three more round trips from the same address, which is ordinary behaviour, not an attack.
    for (let i = 0; i < 3; i += 1) {
      const out = await handleAccountWrite(
        fixed({ action: "logout" }, { cookie, "x-payflow-csrf": csrf }),
        service,
      );
      expect(out.status).toBe(200);
      const back = await handleAccountWrite(
        fixed({ action: "login", email, password: PASSWORD }),
        service,
      );
      expect(back.status).toBe(200);
      cookie = back.headers.get("set-cookie")!.split(";")[0]!;
      csrf = ((await back.json()) as { csrfToken: string }).csrfToken;
    }
  });
});
