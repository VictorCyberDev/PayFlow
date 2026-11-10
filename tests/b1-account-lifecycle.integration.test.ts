/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  EmailOutbox,
  resendSender,
  type EmailSender,
} from "../src/network/email-outbox.js";

/**
 * B1 — email verification and password reset, over real HTTP and PostgreSQL. What is pinned: a token works once, for its window, for its address;
 * the reset endpoint says the same thing for every address; a reset ends every session; an email whose delivery we cannot confirm is never sent twice.
 */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase 42";

(url ? describe : describe.skip)(
  "B1 account lifecycle (PostgreSQL + real HTTP host)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts",
    });
    const send = (
      method: "GET" | "POST",
      path: string,
      o: {
        body?: unknown;
        cookie?: string;
        origin?: string | null;
        csrf?: string;
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
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const mkOutbox = () =>
      new EmailOutbox({ sql: h.repo.sql, now: () => h.iso() });
    const capture = (): EmailSender & {
      sent: { to: string; body: string }[];
    } => {
      const sent: { to: string; body: string }[] = [];
      return {
        sent,
        send: (m) => {
          sent.push({ to: m.to, body: m.body });
          return Promise.resolve({ outcome: "SENT" });
        },
      };
    };
    const tokenFrom = (text: string) =>
      /token=([A-Za-z0-9_-]+)/u.exec(text)![1]!;
    const queued = async (template: string) =>
      h.repo
        .sql`select outbox_id, to_email, body, state from email_outbox where template = ${template} order by created_at, outbox_id`;
    const newUser = async () => {
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
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      return email;
    };
    const login = async (email: string, password = PASSWORD) => {
      h.advance(1_000);
      const r = await send("POST", "/v1/app/login", {
        body: { email, password },
      });
      return r;
    };

    it("signup queues a verification email; the link verifies once, and only the address it was sent to", async () => {
      const email = await newUser();
      const [m] = await queued("VERIFY_EMAIL");
      expect(m).toMatchObject({ to_email: email, state: "QUEUED" });
      expect(String(m!.body)).toContain("/workspace/#/verify?token="); // fragment: never in a server log
      const l = await login(email);
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      expect(
        ((await (await send("GET", "/v1/app/me", { cookie })).json()) as any)
          .user.emailVerified,
      ).toBe(false);
      const token = tokenFrom(String(m!.body));
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token: "x".repeat(43) },
          })
        ).status,
      ).toBe(410);
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token },
          })
        ).status,
      ).toBe(200);
      expect(
        ((await (await send("GET", "/v1/app/me", { cookie })).json()) as any)
          .user.emailVerified,
      ).toBe(true);
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token },
          })
        ).status,
      ).toBe(410); // replay
    });

    it("a verification link expires after 24 hours; asking again replaces the earlier link", async () => {
      const email = await newUser();
      const first = tokenFrom(String((await queued("VERIFY_EMAIL"))[0]!.body));
      const l = await login(email);
      const raw = /pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!;
      const cookie = `pf_session=${raw}`;
      const me = (await body(
        await send("GET", "/v1/app/me", { cookie }),
      )) as any;
      const csrf = me.csrfToken as string;
      await mkOutbox().drain(capture()); // the first message has gone, so a new request may issue a new link
      h.advance(61_000);
      expect(
        (await send("POST", "/v1/app/email-verification/request", { cookie }))
          .status,
      ).toBe(403); // CSRF
      expect(
        (
          await send("POST", "/v1/app/email-verification/request", {
            cookie,
            csrf,
          })
        ).status,
      ).toBe(202);
      const second = tokenFrom(
        String((await queued("VERIFY_EMAIL")).at(-1)!.body),
      );
      expect(second).not.toBe(first);
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token: first },
          })
        ).status,
      ).toBe(410);
      h.advance(25 * 3_600_000);
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token: second },
          })
        ).status,
      ).toBe(410);
    });

    it("password reset answers the same for every address, queues mail only for a real active account, and the link works once", async () => {
      const email = await newUser();
      const unknown = await send("POST", "/v1/app/password-reset/request", {
        body: { email: "nobody@example.com" },
      });
      const known = await send("POST", "/v1/app/password-reset/request", {
        body: { email },
      });
      expect([unknown.status, known.status]).toEqual([202, 202]);
      expect(await body(unknown)).toEqual(await body(known)); // indistinguishable
      expect((await queued("RESET_PASSWORD")).map((r) => r.to_email)).toEqual([
        email,
      ]);
      // disabled accounts get nothing
      const dead = await newUser();
      await h.repo
        .sql`update user_accounts set status = 'DISABLED' where email = ${dead}`;
      await send("POST", "/v1/app/password-reset/request", {
        body: { email: dead },
      });
      expect((await queued("RESET_PASSWORD")).map((r) => r.to_email)).toEqual([
        email,
      ]);
      const token = tokenFrom(
        String((await queued("RESET_PASSWORD"))[0]!.body),
      );
      // a weak password is refused and does NOT burn the link
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token, password: "short" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token, password: email.split("@")[0] + "xxxxxxxx" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token, password: NEW_PASSWORD },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token, password: "another passphrase 99" },
          })
        ).status,
      ).toBe(410); // replay
      expect((await login(email, PASSWORD)).status).toBe(401);
      expect((await login(email, NEW_PASSWORD)).status).toBe(200);
    });

    it("a reset ends every existing session, clears a lockout, expires after 30 minutes, and a newer link replaces an older one", async () => {
      const email = await newUser();
      const l = await login(email);
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      expect((await send("GET", "/v1/app/me", { cookie })).status).toBe(200);
      for (let i = 0; i < 5; i++) await login(email, "wrong password entirely");
      expect((await login(email, PASSWORD)).status).toBe(401); // locked
      await send("POST", "/v1/app/password-reset/request", { body: { email } });
      const older = tokenFrom(
        String((await queued("RESET_PASSWORD")).at(-1)!.body),
      );
      await mkOutbox().drain(capture());
      h.advance(61_000);
      await send("POST", "/v1/app/password-reset/request", { body: { email } });
      const newer = tokenFrom(
        String((await queued("RESET_PASSWORD")).at(-1)!.body),
      );
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token: older, password: NEW_PASSWORD },
          })
        ).status,
      ).toBe(410);
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token: newer, password: NEW_PASSWORD },
          })
        ).status,
      ).toBe(200);
      expect((await send("GET", "/v1/app/me", { cookie })).status).toBe(401); // the old session is gone
      expect((await login(email, NEW_PASSWORD)).status).toBe(200); // and the lockout is cleared
      await mkOutbox().drain(capture());
      h.advance(61_000);
      await send("POST", "/v1/app/password-reset/request", { body: { email } });
      const late = tokenFrom(
        String((await queued("RESET_PASSWORD")).at(-1)!.body),
      );
      h.advance(31 * 60_000);
      expect(
        (
          await send("POST", "/v1/app/password-reset/confirm", {
            body: { token: late, password: "yet another phrase 7" },
          })
        ).status,
      ).toBe(410);
    });

    it("the public reset and verify routes need an allowed Origin and are rate limited", async () => {
      for (const p of [
        "/v1/app/password-reset/request",
        "/v1/app/password-reset/confirm",
        "/v1/app/email-verification/confirm",
      ]) {
        const r = await send("POST", p, {
          body: {
            email: "a@example.com",
            token: "x".repeat(43),
            password: NEW_PASSWORD,
          },
          origin: "https://evil.example",
        });
        expect([p, r.status]).toEqual([p, 403]);
      }
      h.advance(61_000);
      let limited = 0;
      for (let i = 0; i < 25; i++)
        if (
          (
            await send("POST", "/v1/app/password-reset/request", {
              body: { email: "a@example.com" },
            })
          ).status === 429
        )
          limited++;
      expect(limited).toBeGreaterThan(0);
    });

    it("the outbox sends each message once: SENT erases the body, a refusal is FAILED, an unclear outcome is UNKNOWN and is never sent again", async () => {
      const o = mkOutbox();
      const ids = [
        await o.enqueue({
          to: "a@example.com",
          template: "RESET_PASSWORD",
          subject: "s",
          body: "link-a",
        }),
        await o.enqueue({
          to: "b@example.com",
          template: "RESET_PASSWORD",
          subject: "s",
          body: "link-b",
        }),
        await o.enqueue({
          to: "c@example.com",
          template: "RESET_PASSWORD",
          subject: "s",
          body: "link-c",
        }),
      ];
      const sender: EmailSender = {
        send: (m) =>
          Promise.resolve(
            m.to.startsWith("a")
              ? { outcome: "SENT" }
              : m.to.startsWith("b")
                ? { outcome: "REFUSED", note: "bad address" }
                : { outcome: "UNKNOWN", note: "timeout" },
          ),
      };
      expect(await o.drain(sender)).toEqual({
        sent: 1,
        failed: 1,
        unknown: 1,
        deferred: 0,
      });
      const rows = await h.repo
        .sql`select outbox_id, state, body from email_outbox order by to_email`;
      expect(rows.map((r) => [r.state, r.body])).toEqual([
        ["SENT", null],
        ["FAILED", null],
        ["UNKNOWN", "link-c"],
      ]);
      const again = capture();
      expect(await o.drain(again)).toEqual({
        sent: 0,
        failed: 0,
        unknown: 0,
        deferred: 0,
      });
      expect(again.sent).toEqual([]); // the unclear one is NOT retried
      await expect(
        h.repo
          .sql`update email_outbox set state = 'QUEUED' where outbox_id = ${ids[2]!}`,
      ).rejects.toThrow(/never sent again/);
      await expect(h.repo.sql`delete from email_outbox`).rejects.toThrow(
        /append-only/,
      );
    });

    it("concurrent drains send a message exactly once; a sender that throws leaves it UNKNOWN", async () => {
      const o = mkOutbox();
      for (let i = 0; i < 10; i++)
        await o.enqueue({
          to: `u${i}@example.com`,
          template: "VERIFY_EMAIL",
          subject: "s",
          body: `b${i}`,
        });
      const cap = capture();
      await Promise.all(Array.from({ length: 4 }, () => o.drain(cap, 5)));
      await o.drain(cap, 50);
      expect(cap.sent).toHaveLength(10);
      expect(new Set(cap.sent.map((s) => s.to)).size).toBe(10);
      await o.enqueue({
        to: "t@example.com",
        template: "VERIFY_EMAIL",
        subject: "s",
        body: "x",
      });
      await o.drain({ send: () => Promise.reject(new Error("boom")) });
      expect(
        (
          await h.repo
            .sql`select state from email_outbox where to_email = 't@example.com'`
        )[0]!.state,
      ).toBe("UNKNOWN");
    });

    it("the Resend sender maps outcomes honestly: 2xx sent, 4xx refused, 5xx/429/timeouts unknown, and it sends an idempotency key", async () => {
      const mk = (f: typeof fetch) =>
        resendSender({
          apiKey: "re_testkey_123456",
          from: "PayFlow <no-reply@example.com>",
          fetchImpl: f,
          timeoutMs: 50,
        });
      const m = {
        to: "a@example.com",
        subject: "s",
        body: "b",
        idempotencyKey: "out_1",
      };
      let seen: Record<string, string> = {};
      const reply = (status: number) =>
        ((_u: unknown, init?: RequestInit) => {
          seen = init!.headers as Record<string, string>;
          return Promise.resolve(new Response("{}", { status }));
        }) as unknown as typeof fetch;
      expect(await mk(reply(200)).send(m)).toEqual({ outcome: "SENT" });
      expect(seen["idempotency-key"]).toBe("out_1");
      expect((await mk(reply(422)).send(m)).outcome).toBe("REFUSED");
      expect((await mk(reply(429)).send(m)).outcome).toBe("DEFER"); // certainly not sent; try later
      for (const st of [409, 500, 503, 302])
        expect((await mk(reply(st)).send(m)).outcome, String(st)).toBe(
          "UNKNOWN",
        );
      const hang = ((_u: unknown, init?: RequestInit) =>
        new Promise((_r, rej) =>
          init!.signal!.addEventListener("abort", () =>
            rej(new Error("aborted")),
          ),
        )) as unknown as typeof fetch;
      expect((await mk(hang).send(m)).outcome).toBe("UNKNOWN");
    });
  },
);
