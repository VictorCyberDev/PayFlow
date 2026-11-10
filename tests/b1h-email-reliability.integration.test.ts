/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import {
  EmailOutbox,
  MAX_ATTEMPTS,
  SEND_LEASE_MS,
  type EmailSender,
  type SendResult,
} from "../src/network/email-outbox.js";
import { parseHostedConfig } from "../src/console-hosted.js";

/**
 * B1 hardening over real HTTP and PostgreSQL: the token and its email are one commit; a crash before, during or after the provider call never causes
 * a second send and never locks a person out; expired links are not kept readable; the limiter failing does not unmeter account actions; an
 * unverified account cannot take outward or financial actions; recovery material is not readable by other roles or through any customer endpoint.
 */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase 42";

const counting = (result: SendResult = { outcome: "SENT" }) => {
  const sent: { to: string; body: string; key: string }[] = [];
  const sender: EmailSender = {
    send: (m) => {
      sent.push({ to: m.to, body: m.body, key: m.idempotencyKey });
      return Promise.resolve(result);
    },
  };
  return { sent, sender };
};

(url ? describe : describe.skip)(
  "B1 hardening: atomic tokens, send leases, crash recovery, expiry (PostgreSQL + real HTTP)",
  () => {
    const mail = counting();
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts",
      emailSender: () => mail.sender,
      requireVerifiedEmail: false,
    });
    beforeEach(async () => {
      await h.repo.sql`truncate email_outbox, user_tokens`;
    });
    const call = (
      method: "GET" | "POST",
      path: string,
      o: {
        body?: unknown;
        cookie?: string;
        csrf?: string;
        bearer?: string;
      } = {},
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          ...(o.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
          origin: h.origin,
          ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
    const outbox = () =>
      new EmailOutbox({ sql: h.repo.sql, now: () => h.iso() });
    const rows = (template = "RESET_PASSWORD") =>
      h.repo
        .sql`select outbox_id, to_email, state, body, attempts, note, token_hash, expires_at from email_outbox where template = ${template} order by created_at, outbox_id`;
    const tokenFrom = (text: string) =>
      /token=([A-Za-z0-9_-]+)/u.exec(text)![1]!;
    const newUser = async () => {
      h.advance(61_000);
      const email = `u${Math.random().toString(36).slice(2, 9)}@example.com`;
      const r = await call("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: "Sam",
          organizationName: "Sam Studio",
        },
      });
      expect(r.status).toBe(201);
      await outbox().drain(counting().sender); // the verification mail made at signup is out of the way
      return email;
    };
    const reset = (email: string) =>
      call("POST", "/v1/app/password-reset/request", { body: { email } });
    const confirm = (token: string, password = NEW_PASSWORD) =>
      call("POST", "/v1/app/password-reset/confirm", {
        body: { token, password },
      });
    const run = async () =>
      await (
        await call("POST", "/v1/admin/ops/automation/run", {
          bearer: ADMIN_TOKEN,
        })
      ).json();

    it("write boundaries are all-or-nothing: if queueing the email fails, no new link exists and the earlier link still works", async () => {
      const email = await newUser();
      await reset(email);
      const first = tokenFrom(String((await rows()).at(-1)!.body));
      await outbox().drain(counting().sender);
      h.advance(61_000);
      for (const [table, ev] of [
        ["email_outbox", "insert"],
        ["user_tokens", "insert"],
        ["user_tokens", "update"],
      ] as const) {
        await h.repo.sql.unsafe(
          `create function inject_fail() returns trigger language plpgsql as $$ begin raise exception 'injected write failure'; end $$`,
        );
        await h.repo.sql.unsafe(
          `create trigger inject_fail before ${ev} on ${table} for each row execute function inject_fail()`,
        );
        try {
          await reset(email); // always answers the same, even when it could not queue
        } finally {
          await h.repo.sql.unsafe(`drop trigger inject_fail on ${table}`);
          await h.repo.sql.unsafe(`drop function inject_fail()`);
        }
        const live = await h.repo
          .sql`select count(*)::int n from user_tokens where purpose = 'RESET_PASSWORD' and used_at is null and expires_at > ${h.iso()}`;
        expect(live[0]!.n, `${table} ${ev}`).toBe(1); // only the earlier link, still live
        expect((await rows()).length, `${table} ${ev}`).toBe(1); // no half-made message
      }
      expect((await confirm(first)).status).toBe(200); // the earlier link was never lost
    });

    it("asking many times at once makes one message and one live link", async () => {
      const email = await newUser();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reset(email)),
      );
      expect(new Set(results.map((r) => r.status))).toEqual(new Set([202]));
      expect(await rows()).toHaveLength(1);
      const live = await h.repo
        .sql`select count(*)::int n from user_tokens where purpose = 'RESET_PASSWORD' and used_at is null`;
      expect(live[0]!.n).toBe(1);
      // the stored link digest is the digest of the link in the message
      const r = (await rows())[0]!;
      const { createHash } = await import("node:crypto");
      expect(r.token_hash).toBe(
        createHash("sha256")
          .update(tokenFrom(String(r.body)))
          .digest("hex"),
      );
    });

    it("crash BEFORE the provider call: the lost message becomes UNKNOWN and is never sent; a new request issues a new link", async () => {
      const email = await newUser();
      await reset(email);
      const old = tokenFrom(String((await rows()).at(-1)!.body));
      const claimed = await outbox().claim(); // the worker took it, then died
      expect(claimed).toHaveLength(1);
      expect((await rows())[0]!.state).toBe("SENDING");
      // within its lease it is simply being sent: not stale, not touched
      expect((await outbox().sweep()).lost).toBe(0);
      h.advance(SEND_LEASE_MS + 1000);
      expect((await outbox().sweep()).lost).toBe(1);
      expect((await rows())[0]!.state).toBe("UNKNOWN");
      const c = counting();
      await outbox().drain(c.sender);
      expect(c.sent).toHaveLength(0); // never sent again
      // the person is not locked out: after the cooldown they can ask again; the old link is retired and the new one works
      h.advance(61_000);
      await reset(email);
      const all = await rows();
      expect(all).toHaveLength(2);
      const fresh = tokenFrom(String(all[1]!.body));
      expect(fresh).not.toBe(old);
      expect((await confirm(old)).status).toBe(410);
      expect((await confirm(fresh)).status).toBe(200);
    });

    it("crash DURING and AFTER the provider call: the provider was reached once, the answer was lost, nothing is sent a second time", async () => {
      const email = await newUser();
      await reset(email);
      const c = counting();
      const [m] = await outbox().claim();
      // the provider call happens ...
      await c.sender.send({
        to: m!.to,
        subject: m!.subject,
        body: m!.body,
        idempotencyKey: m!.outboxId,
      });
      // ... and the worker dies before recording anything (the same state whether it died mid-call or just after it)
      h.advance(SEND_LEASE_MS + 1000);
      await run(); // the real automation run: sweep, then drain
      const r = (await rows())[0]!;
      expect(r.state).toBe("UNKNOWN");
      expect(String(r.note)).toContain("worker was lost");
      expect(r.attempts).toBe(1);
      expect(c.sent).toHaveLength(1); // exactly the one call above; the run did not add another
    });

    it("a slow worker whose answer arrives after the sweep settles the message; its body is then erased", async () => {
      const email = await newUser();
      await reset(email);
      const [m] = await outbox().claim();
      h.advance(SEND_LEASE_MS + 1000);
      await outbox().sweep();
      expect((await rows())[0]!.state).toBe("UNKNOWN");
      await outbox().settle(m!.outboxId, { outcome: "SENT" });
      const r = (await rows())[0]!;
      expect(r.state).toBe("SENT");
      expect(r.body).toBeNull();
    });

    it("expired links are not kept: a queued message past its link's life is FAILED and erased; an UNKNOWN one is erased", async () => {
      const a = await newUser();
      const b = await newUser();
      const c = await newUser();
      await reset(a);
      await reset(b);
      const claimed = await outbox().claim(); // two messages taken by workers that then died
      const [one, two] = claimed as [(typeof claimed)[0], (typeof claimed)[0]];
      h.advance(SEND_LEASE_MS + 1000);
      await outbox().sweep(); // both stale -> UNKNOWN
      await reset(c); // queued, never claimed
      h.advance(31 * 60_000);
      const swept = await outbox().sweep();
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      const all = await rows();
      expect(all.every((x) => x.body === null)).toBe(true); // nothing readable is left
      expect(all.find((x) => x.outbox_id === one.outboxId)!.state).toBe(
        "UNKNOWN",
      );
      expect(all.find((x) => x.outbox_id === two.outboxId)!.state).toBe(
        "UNKNOWN",
      );
      expect(
        all.some(
          (x) => x.state === "FAILED" && String(x.note).includes("expired"),
        ),
      ).toBe(true);
      // an erased body can never be written back
      await expect(
        h.repo
          .sql`update email_outbox set body = 'again' where outbox_id = ${one.outboxId}`,
      ).rejects.toThrow(/never restored/iu);
    });

    it("a provider rate limit (429) puts the message back and gives up after a bounded number of tries", async () => {
      const email = await newUser();
      await reset(email);
      const defer: EmailSender = {
        send: () =>
          Promise.resolve({
            outcome: "DEFER",
            note: "the provider asked us to wait",
          }),
      };
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        expect((await outbox().drain(defer)).deferred).toBe(1);
        expect((await rows())[0]!.state).toBe("QUEUED");
      }
      await outbox().drain(defer);
      const r = (await rows())[0]!;
      expect(r.state).toBe("FAILED");
      expect(r.body).toBeNull();
    });

    it("the automation run actually sends through the configured sender, and the operator view has no bodies or tokens", async () => {
      const email = await newUser();
      mail.sent.length = 0;
      await reset(email);
      const link = tokenFrom(String((await rows()).at(-1)!.body));
      const out = await run();
      expect(out.mail.senderConfigured).toBe(true);
      expect(out.mail.sent).toBeGreaterThanOrEqual(1);
      expect(
        mail.sent.some((m) => m.to === email && m.body.includes(link)),
      ).toBe(true);
      const view = await call("GET", "/v1/admin/ops/email-outbox", {
        bearer: ADMIN_TOKEN,
      });
      const text = await view.text();
      expect(view.status).toBe(200);
      expect(text).not.toContain(link);
      expect(text).not.toContain("token=");
      expect(text).not.toContain(email); // recipients are masked
      expect(JSON.parse(text).counts.SENT).toBeGreaterThanOrEqual(1);
    });

    it("no customer endpoint and no other person can read a recovery link", async () => {
      const victim = await newUser();
      const other = await newUser();
      await reset(victim);
      const link = tokenFrom(String((await rows()).at(-1)!.body));
      const l = await call("POST", "/v1/app/login", {
        body: { email: other, password: PASSWORD },
      });
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      const me = await (await call("GET", "/v1/app/me", { cookie })).json();
      for (const p of [
        "/v1/app/me",
        "/v1/app/agents",
        "/v1/admin/org/audit",
        "/v1/admin/ops/email-outbox",
      ]) {
        const r = await call("GET", p, { cookie });
        expect(await r.text(), p).not.toContain(link);
        expect(await r.text().catch(() => ""), p).not.toContain(victim);
      }
      // the operator route refuses a member of any role
      expect([401, 403]).toContain(
        (await call("GET", "/v1/admin/ops/email-outbox", { cookie })).status,
      );
      void me;
    });

    it("the read-only database role cannot read recovery material or sign-in digests; the runtime role can still do its job", async () => {
      await h.repo.sql.unsafe(
        await readFile("db/roles/least-privilege.sql", "utf8"),
      );
      for (const [login, group] of [
        ["b1h_ro", "payflow_readonly"],
        ["b1h_rt", "payflow_runtime"],
      ] as const) {
        await h.repo.sql.unsafe(`drop role if exists ${login}`);
        await h.repo.sql.unsafe(
          `create role ${login} login password 'pw_${login}' in role ${group}`,
        );
      }
      const as = (login: string) => {
        const u = new URL(url!);
        u.username = login;
        u.password = `pw_${login}`;
        return postgres(u.toString(), { max: 1, onnotice: () => undefined });
      };
      const refused = async (p: PromiseLike<unknown>) => {
        try {
          await p;
        } catch (e) {
          return String((e as Error).message);
        }
        return null;
      };
      const ro = as("b1h_ro");
      try {
        for (const q of [
          "select body from email_outbox",
          "select * from email_outbox",
          "select to_email from email_outbox",
          "select token_hash from user_tokens",
          "select * from user_tokens",
          "select session_hash from user_sessions",
          "select password_hash from user_accounts",
          "select * from user_accounts",
        ])
          expect(await refused(ro.unsafe(q)), q).toMatch(/permission denied/iu);
        expect(
          await refused(ro.unsafe("select user_id, email from user_accounts")),
        ).toBeNull(); // non-secret columns remain readable for reporting
      } finally {
        await ro.end();
      }
      const rt = as("b1h_rt");
      try {
        expect(
          await refused(rt.unsafe("select count(*) from email_outbox")),
        ).toBeNull();
        await h.repo
          .sql`insert into email_outbox (outbox_id, to_email, template, subject, body, state, created_at, updated_at)
          values ('out_aaaaaaaaaaaaaaaaaaaaaaaa', 'z@example.com', 'RESET_PASSWORD', 's', 'b', 'QUEUED', ${h.iso()}, ${h.iso()})`;
        expect(await refused(rt.unsafe("delete from email_outbox"))).toMatch(
          /append-only|permission denied/iu,
        );
      } finally {
        await rt.end();
      }
    });
  },
);

(url ? describe : describe.skip)(
  "B1 hardening: the limiter failing does not unmeter account actions (PostgreSQL + real HTTP)",
  () => {
    let broken = false;
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts",
      emailSender: () => counting().sender,
      requireVerifiedEmail: false,
      rateLimitStore: () => ({
        consume: (...a: unknown[]) => {
          if (broken) return Promise.reject(new Error("limiter storage down"));
          // delegate to a permissive in-memory answer while healthy
          void a;
          return Promise.resolve({
            allowed: true,
            remaining: 99,
            resetAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      }),
    });
    const post = (path: string, body: unknown) =>
      fetch(h.origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify(body),
      });

    it("with the limiter down, password guessing and reset requests are bounded per address (5 a minute), not unlimited", async () => {
      broken = true;
      try {
        const codes: number[] = [];
        for (let i = 0; i < 12; i++)
          codes.push(
            (
              await post("/v1/app/login", {
                email: "nobody@example.com",
                password: "a wrong password here",
              })
            ).status,
          );
        expect(codes.filter((c) => c === 401)).toHaveLength(5); // five guesses were allowed through to the account check ...
        expect(codes.filter((c) => c === 429)).toHaveLength(7); // ... the rest refused, not waved through
        // each action has its own small bound, and reset requests queue no mail while the limiter cannot count
        const resets: number[] = [];
        for (let i = 0; i < 8; i++)
          resets.push(
            (
              await post("/v1/app/password-reset/request", {
                email: "x@example.com",
              })
            ).status,
          );
        expect(resets.filter((c) => c === 429).length).toBeGreaterThanOrEqual(
          3,
        );
        expect(
          (await h.repo.sql`select count(*)::int n from email_outbox`)[0]!.n,
        ).toBe(0);
        // the bound recovers when the minute passes
        h.advance(61_000);
        expect(
          (
            await post("/v1/app/login", {
              email: "nobody@example.com",
              password: "a wrong password here",
            })
          ).status,
        ).toBe(401);
      } finally {
        broken = false;
      }
    });

    it("a healthy limiter still lets a real account through and queues its mail; a limiter fault creates no mail for a real account", async () => {
      h.advance(61_000);
      const email = "real@example.com";
      expect(
        (
          await post("/v1/app/signup", {
            email,
            password: PASSWORD,
            displayName: "R",
            organizationName: "R Ltd",
          })
        ).status,
      ).toBe(201);
      const before = (
        await h.repo.sql`select count(*)::int n from email_outbox`
      )[0]!.n;
      broken = true;
      try {
        h.advance(61_000);
        expect(
          (await post("/v1/app/password-reset/request", { email })).status,
        ).toBe(202); // same answer
        expect(
          (await h.repo.sql`select count(*)::int n from email_outbox`)[0]!.n,
        ).toBe(before); // but no mail
      } finally {
        broken = false;
      }
    });
  },
);

(url ? describe : describe.skip)(
  "B1 hardening: an unverified account cannot take outward or financial actions (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts",
      emailSender: () => counting().sender,
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

    it("is refused server-side for approvals, supplier contact, bookings, orders, credentials and agents; allowed for looking, drafting and comparing; lifted after verification", async () => {
      h.advance(61_000);
      const email = "unverified@example.com";
      await send("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: "U",
          organizationName: "U Ltd",
        },
      });
      h.advance(1000);
      const l = await send("POST", "/v1/app/login", {
        body: { email, password: PASSWORD },
      });
      const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(l.headers.get("set-cookie")!)![1]!}`;
      const me = await (await send("GET", "/v1/app/me", { cookie })).json();
      expect(me.verificationRequired).toBe(true);
      expect(me.user.emailVerified).toBe(false);
      const csrf = me.csrfToken as string;
      const blocked = [
        ["/v1/admin/org/missions/mis_00000000000000000000000a/approve", {}],
        ["/v1/admin/org/missions/mis_00000000000000000000000a/messages", {}],
        ["/v1/admin/org/missions/mis_00000000000000000000000a/bookings", {}],
        ["/v1/admin/org/missions/mis_00000000000000000000000a/orders", {}],
        ["/v1/admin/org/missions/mis_00000000000000000000000a/quotes", {}],
        ["/v1/admin/org/missions/mis_00000000000000000000000a/contacts", {}],
        ["/v1/admin/org/credentials", {}],
        ["/v1/admin/members", {}],
        ["/v1/app/agents", { displayName: "Bot" }],
      ] as const;
      for (const [p, b] of blocked) {
        const r = await send("POST", p, { cookie, csrf, body: b });
        expect([p, r.status, (await r.json()).reason]).toEqual([
          p,
          403,
          "EMAIL_NOT_VERIFIED",
        ]);
      }
      // reading, and the side-effect-free steps, are not blocked by this rule
      for (const p of ["/v1/app/me", "/v1/app/agents"])
        expect((await send("GET", p, { cookie })).status, p).toBe(200);
      const draft = await send("POST", "/v1/admin/org/missions", {
        cookie,
        csrf,
        body: {},
      });
      expect((await draft.json()).reason).not.toBe("EMAIL_NOT_VERIFIED");
      // verify through the real link, then the same call is no longer refused for this reason
      const [msg] = await h.repo
        .sql`select body from email_outbox where template = 'VERIFY_EMAIL' order by created_at desc limit 1`;
      const token = /token=([A-Za-z0-9_-]+)/u.exec(String(msg!.body))![1]!;
      expect(
        (
          await send("POST", "/v1/app/email-verification/confirm", {
            body: { token },
          })
        ).status,
      ).toBe(200);
      const after = await send("POST", "/v1/app/agents", {
        cookie,
        csrf,
        body: { displayName: "Bot" },
      });
      expect([200, 201]).toContain(after.status);
      const approve = await send(
        "POST",
        "/v1/admin/org/missions/mis_00000000000000000000000a/approve",
        { cookie, csrf, body: {} },
      );
      expect((await approve.json()).reason).not.toBe("EMAIL_NOT_VERIFIED");
    });
  },
);

describe("B1 hardening: sender configuration from the protected environment", () => {
  const base = {
    PAYFLOW_M5_DEMO: "true",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    PAYFLOW_M5_PRINCIPAL_ID: "p",
    PAYFLOW_M5_AGENT_ID: "a",
    PAYFLOW_M5_BOOTSTRAP_KEY: "k".repeat(40),
    PAYFLOW_M5_ORIGIN: "https://app.example.com",
  };
  const KEY = "re_abcdefgh12345678";
  it("builds a sender only from a valid key AND a sender the owner attests is verified; refuses everything else", () => {
    expect(parseHostedConfig(base).email).toBeUndefined();
    const ok = parseHostedConfig({
      ...base,
      PAYFLOW_RESEND_API_KEY: KEY,
      PAYFLOW_EMAIL_FROM: "PayFlow <notices@mail.example.com>",
      PAYFLOW_EMAIL_FROM_VERIFIED: "true",
    });
    expect(ok.email).toEqual({
      resendApiKey: KEY,
      from: "PayFlow <notices@mail.example.com>",
    });
    const bad: [Record<string, string>, RegExp][] = [
      [{ PAYFLOW_RESEND_API_KEY: KEY }, /GO_TOGETHER/u],
      [{ PAYFLOW_EMAIL_FROM: "a@b.co" }, /GO_TOGETHER/u],
      [
        {
          PAYFLOW_RESEND_API_KEY: "nope",
          PAYFLOW_EMAIL_FROM: "a@mail.example.com",
          PAYFLOW_EMAIL_FROM_VERIFIED: "true",
        },
        /KEY_INVALID/u,
      ],
      [
        {
          PAYFLOW_RESEND_API_KEY: KEY,
          PAYFLOW_EMAIL_FROM: "a@mail.example.com",
        },
        /ATTESTED_VERIFIED/u,
      ],
      [
        {
          PAYFLOW_RESEND_API_KEY: KEY,
          PAYFLOW_EMAIL_FROM: "PayFlow <onboarding@resend.dev>",
          PAYFLOW_EMAIL_FROM_VERIFIED: "true",
        },
        /FROM_INVALID/u,
      ],
      [
        {
          PAYFLOW_RESEND_API_KEY: KEY,
          PAYFLOW_EMAIL_FROM: "bad\r\nbcc: x@y.z",
          PAYFLOW_EMAIL_FROM_VERIFIED: "true",
        },
        /FROM_INVALID/u,
      ],
    ];
    for (const [env, re] of bad)
      expect(
        () => parseHostedConfig({ ...base, ...env }),
        JSON.stringify(env),
      ).toThrow(re);
    expect(() =>
      parseHostedConfig({
        ...base,
        PAYFLOW_M5_ORIGIN: "http://app.example.com",
        PAYFLOW_RESEND_API_KEY: KEY,
        PAYFLOW_EMAIL_FROM: "a@mail.example.com",
        PAYFLOW_EMAIL_FROM_VERIFIED: "true",
      }),
    ).toThrow(/HTTPS_ORIGIN/u);
  });
  it("the key never appears in an error message", () => {
    try {
      parseHostedConfig({
        ...base,
        PAYFLOW_RESEND_API_KEY: KEY,
        PAYFLOW_EMAIL_FROM: "a@mail.example.com",
      });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });
});
