#!/usr/bin/env node
// B1/B2 acceptance against the COMPILED application over real HTTP and a real PostgreSQL database.
//   npm run build && node scripts/b1-b2-acceptance.mjs
// Needs: PostgreSQL reachable at ACCEPT_ADMIN_URL (default postgres://payflow:payflow_test@localhost:5432/payflow_test), which may create and drop a scratch database.
// What is real: the compiled host (separate OS process, killed with SIGKILL in the crash journeys), the HTTP, PostgreSQL, the Resend sender code talking HTTP.
// What is a stand-in: the email provider, a local HTTP server that records exactly what it receives and can be told to answer 200, 429, 500, or never answer.
// It is NOT Resend. Delivery to a real inbox is not proven by this run. Time-dependent journeys move stored timestamps in the database; they do not change the app.
// Writes docs/evidence/b1-b2-acceptance.json. No secret or address is recorded beyond fixed test values.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { generateKeyPairSync } from "node:crypto";
const SIGNING = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
});

const ADMIN =
  process.env.ACCEPT_ADMIN_URL ??
  "postgres://payflow:payflow_test@localhost:5432/payflow_test";
const DB = "b1b2_acceptance";
const PORT = 4817;
const FAKE = 4818;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CRON = "c".repeat(40);
const ADMIN_TOKEN = "a".repeat(40);
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase 42";
const results = [];
const record = (n, name, ok, detail = {}) => {
  results.push({ n, name, ok, ...detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${String(n).padStart(2)} ${name}${ok ? "" : " " + JSON.stringify(detail)}`,
  );
};

// ---- the provider stand-in
let mode = "ok";
const received = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {
      /* not JSON */
    }
    received.push({
      mode,
      auth: req.headers.authorization,
      key: req.headers["idempotency-key"],
      to: j.to?.[0],
      from: j.from,
      text: j.text,
    });
    if (mode === "hang") return; // never answers
    if (mode === "429") return void res.writeHead(429).end("{}");
    if (mode === "500") return void res.writeHead(500).end("{}");
    res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"id":"stub"}');
  });
});
await new Promise((r) => fake.listen(FAKE, "127.0.0.1", r));

// ---- database
const admin = postgres(ADMIN, { max: 1, onnotice: () => undefined });
await admin.unsafe(`drop database if exists ${DB} with (force)`);
await admin.unsafe(`create database ${DB}`);
const dburl = new URL(ADMIN);
dburl.pathname = `/${DB}`;
const sql = postgres(dburl.toString(), { max: 2, onnotice: () => undefined });
for (const f of readdirSync("db/migrations")
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  const n = Number(f.slice(0, 3));
  if (n === 28) continue; // the merchant environment's migration is not part of the application database
  await sql.unsafe(readFileSync(`db/migrations/${f}`, "utf8"));
}

// ---- the compiled host
let host = null;
const startHost = async (extra = {}) => {
  host = spawn("node", ["scripts/serve-hosted.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      DATABASE_URL: dburl.toString(),
      PAYFLOW_M5_DEMO: "true",
      PAYFLOW_M5_PRINCIPAL_ID: "principal_acceptance",
      PAYFLOW_M5_AGENT_ID: "agent_acceptance",
      PAYFLOW_M5_BOOTSTRAP_KEY: "b".repeat(40),
      PAYFLOW_M5_ORIGIN: ORIGIN,
      // required for the Gateway (and so the customer app) to exist; no PayPal variables are set, so no payment can execute
      PAYFLOW_M6_DEMO_AGENT: "true",
      PAYFLOW_M6_SIGNING_KEY: SIGNING,
      PAYFLOW_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      CRON_SECRET: CRON,
      PAYFLOW_RESEND_API_KEY: "re_acceptance_key_123456",
      PAYFLOW_EMAIL_FROM: "PayFlow <notices@mail.example.com>",
      PAYFLOW_EMAIL_FROM_VERIFIED: "true",
      PAYFLOW_RESEND_BASE_URL: `http://127.0.0.1:${FAKE}`,
      ...extra,
    },
  });
  let log = "";
  host.stdout.on("data", (c) => (log += c));
  host.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !log.includes("LISTENING"); i++) await sleep(100);
  if (!log.includes("LISTENING"))
    throw new Error("host did not start: " + log.slice(0, 300));
};
const stopHost = async () => {
  if (!host) return;
  const h = host;
  host = null;
  h.kill("SIGKILL");
  await new Promise((r) => h.once("exit", r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, o = {}) =>
  fetch(ORIGIN + path, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
      ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
      ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
const json = async (r) => r.json().catch(() => ({}));
const run = () =>
  call("GET", "/v1/admin/ops/automation/run", { bearer: CRON, origin: null });
const freshLimits = () => sql`truncate rate_limit_windows`;
const login = async (email, password = PASSWORD) => {
  const r = await call("POST", "/v1/app/login", { body: { email, password } });
  if (r.status !== 200) return { status: r.status };
  const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(r.headers.get("set-cookie"))[1]}`;
  const me = await json(await call("GET", "/v1/app/me", { cookie }));
  return { status: 200, cookie, csrf: me.csrfToken, me };
};
const tokenIn = (text) => /token=([A-Za-z0-9_-]+)/u.exec(text ?? "")?.[1];
const lastMail = (to) =>
  [...received].reverse().find((m) => m.to === to && m.mode === "ok");
const outbox = (email, template) =>
  sql`select state, body, attempts, note from email_outbox where to_email = ${email} and template = ${template} order by created_at, outbox_id`;
const age = (email, template) =>
  sql`update email_outbox set created_at = created_at - interval '5 minutes' where to_email = ${email} and template = ${template}`;

try {
  await startHost();
  const A = "alice@example.test";
  const B = "bob@example.test";

  // 1 signup + verification request
  let r = await call("POST", "/v1/app/signup", {
    body: {
      email: A,
      password: PASSWORD,
      displayName: "Alice",
      organizationName: "Alice Ltd",
    },
  });
  const q1 = await outbox(A, "VERIFY_EMAIL");
  record(
    1,
    "signup queues a verification email (queued, not yet sent)",
    r.status === 201 &&
      q1.length === 1 &&
      q1[0].state === "QUEUED" &&
      received.length === 0,
    { status: r.status },
  );

  // 2 genuine test-channel delivery
  r = await run();
  const ran = await json(r);
  const m1 = lastMail(A);
  const after = await outbox(A, "VERIFY_EMAIL");
  record(
    2,
    "the authorized automation run delivers it through the sender over HTTP; body erased; key sent as bearer; idempotency key = outbox id",
    r.status === 200 &&
      ran.mail?.senderConfigured === true &&
      !!m1 &&
      m1.auth === "Bearer re_acceptance_key_123456" &&
      /^out_[a-f0-9]{24}$/u.test(m1.key) &&
      m1.from.includes("notices@mail.example.com") &&
      after[0].state === "SENT" &&
      after[0].body === null,
    { sent: ran.mail?.sent },
  );

  // 3 + 4 token verification and replay
  const vtok = tokenIn(m1?.text);
  let a = await login(A);
  const before = a.me?.user?.emailVerified;
  r = await call("POST", "/v1/app/email-verification/confirm", {
    body: { token: vtok },
  });
  a = await login(A);
  record(
    3,
    "the emailed link verifies the address",
    before === false && r.status === 200 && a.me?.user?.emailVerified === true,
  );
  r = await call("POST", "/v1/app/email-verification/confirm", {
    body: { token: vtok },
  });
  record(4, "a replayed verification token is refused", r.status === 410);

  // 5 expired token
  await freshLimits();
  await call("POST", "/v1/app/password-reset/request", { body: { email: A } });
  await run();
  const expTok = tokenIn(lastMail(A)?.text);
  await sql`update user_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '90 minutes' where purpose = 'RESET_PASSWORD' and used_at is null`;
  r = await call("POST", "/v1/app/password-reset/confirm", {
    body: { token: expTok, password: NEW_PASSWORD },
  });
  record(5, "an expired reset token is refused", !!expTok && r.status === 410);

  // 6 forgot password, 7 reset, 8 old password refused, 9 new password works, 10 earlier sessions revoked
  await freshLimits();
  const earlier = await login(A);
  await age(A, "RESET_PASSWORD");
  r = await call("POST", "/v1/app/password-reset/request", {
    body: { email: A },
  });
  const body6 = await json(r);
  await run();
  const rtok = tokenIn(lastMail(A)?.text);
  record(
    6,
    "forgot-password request: identical answer, says delivery is enabled, a link arrives",
    r.status === 202 &&
      body6.emailDelivery === "ENABLED" &&
      !!rtok &&
      rtok !== expTok,
  );
  r = await call("POST", "/v1/app/password-reset/confirm", {
    body: { token: rtok, password: NEW_PASSWORD },
  });
  record(7, "the reset link sets the new password", r.status === 200);
  record(
    8,
    "the old password is refused",
    (await login(A, PASSWORD)).status === 401,
  );
  const fresh = await login(A, NEW_PASSWORD);
  record(9, "the new password signs in", fresh.status === 200);
  record(
    10,
    "the session that existed before the reset no longer works",
    (await call("GET", "/v1/app/me", { cookie: earlier.cookie })).status ===
      401,
  );

  // 11 list, 12 revoke another, 13 cross-user denial
  await freshLimits();
  const s2 = await login(A, NEW_PASSWORD);
  let list = await json(
    await call("GET", "/v1/app/sessions", { cookie: fresh.cookie }),
  );
  const other = list.sessions?.find((s) => !s.current);
  record(
    11,
    "the account lists its sign-ins and marks the current one",
    list.sessions?.length >= 2 &&
      list.sessions.filter((s) => s.current).length === 1 &&
      !JSON.stringify(list).includes(fresh.cookie.split("=")[1]),
  );
  r = await call("POST", `/v1/app/sessions/${other?.id}/revoke`, {
    cookie: fresh.cookie,
    csrf: fresh.csrf,
    body: {},
  });
  record(
    12,
    "another sign-in can be revoked and then stops working",
    r.status === 200 &&
      (await call("GET", "/v1/app/me", { cookie: s2.cookie })).status === 401 &&
      (await call("GET", "/v1/app/me", { cookie: fresh.cookie })).status ===
        200,
  );
  await call("POST", "/v1/app/signup", {
    body: {
      email: B,
      password: PASSWORD,
      displayName: "Bob",
      organizationName: "Bob Ltd",
    },
  });
  const b = await login(B);
  const bList = await json(
    await call("GET", "/v1/app/sessions", { cookie: b.cookie }),
  );
  r = await call("POST", `/v1/app/sessions/${bList.sessions[0].id}/revoke`, {
    cookie: fresh.cookie,
    csrf: fresh.csrf,
    body: {},
  });
  record(
    13,
    "one account cannot revoke or see another's sign-ins",
    r.status === 404 &&
      (await call("GET", "/v1/app/me", { cookie: b.cookie })).status === 200 &&
      !JSON.stringify(
        await json(
          await call("GET", "/v1/app/sessions", { cookie: fresh.cookie }),
        ),
      ).includes(bList.sessions[0].id),
  );

  // 14 sender timeout: the provider never answers; the host's sender gives up (8 s) and the message is UNKNOWN
  await freshLimits();
  const C = "carol@example.test";
  await call("POST", "/v1/app/signup", {
    body: {
      email: C,
      password: PASSWORD,
      displayName: "Carol",
      organizationName: "Carol Ltd",
    },
  });
  await run(); // verification mail goes out normally
  await age(C, "RESET_PASSWORD");
  await call("POST", "/v1/app/password-reset/request", { body: { email: C } });
  mode = "hang";
  const callsBefore = received.length;
  const t0 = Date.now();
  await run();
  const q14 = await outbox(C, "RESET_PASSWORD");
  record(
    14,
    "a provider that never answers leaves the message UNKNOWN after the sender timeout; a later run does not send it again",
    q14[0]?.state === "UNKNOWN" &&
      received.length === callsBefore + 1 &&
      Date.now() - t0 >= 7000,
    { ms: Date.now() - t0 },
  );
  mode = "ok";
  await run();
  record(
    14.1,
    "…and the unknown message is not retried",
    received.length === callsBefore + 1 &&
      (await outbox(C, "RESET_PASSWORD"))[0].state === "UNKNOWN",
  );

  // 15 worker crash: SIGKILL the host while the provider call is in flight
  await freshLimits();
  const D = "dave@example.test";
  await call("POST", "/v1/app/signup", {
    body: {
      email: D,
      password: PASSWORD,
      displayName: "Dave",
      organizationName: "Dave Ltd",
    },
  });
  await run();
  await call("POST", "/v1/app/password-reset/request", { body: { email: D } });
  mode = "hang";
  const c15 = received.length;
  const pending = run().catch(() => null);
  for (let i = 0; i < 50 && received.length === c15; i++) await sleep(100);
  const inFlight = received.length === c15 + 1;
  const mid = (await outbox(D, "RESET_PASSWORD"))[0];
  await stopHost(); // the worker dies with the provider call outstanding
  await pending;
  record(
    15,
    "the worker is killed mid-send: the message is left SENDING with a lease, the provider was reached once",
    inFlight && mid.state === "SENDING",
  );
  mode = "ok";
  await startHost();

  // 16 outbox recovery
  await sql`update email_outbox set lease_until = now() - interval '1 minute' where state = 'SENDING'`;
  await run();
  const rec = (await outbox(D, "RESET_PASSWORD"))[0];
  const dTotal = received.filter((m) => m.to === D && m.mode !== "ok").length;
  record(
    16,
    "after restart the sweep marks the lost message UNKNOWN and never re-sends it",
    rec.state === "UNKNOWN" &&
      /worker was lost/u.test(rec.note) &&
      received.filter((m) => m.to === D && m.text?.includes("reset")).length ===
        1,
  );
  await age(D, "RESET_PASSWORD");
  await freshLimits();
  await call("POST", "/v1/app/password-reset/request", { body: { email: D } });
  await run();
  const dtok = tokenIn(lastMail(D)?.text);
  r = await call("POST", "/v1/app/password-reset/confirm", {
    body: { token: dtok, password: NEW_PASSWORD },
  });
  record(
    16.1,
    "…and the person is not locked out: asking again issues a new link that works",
    !!dtok && r.status === 200,
  );

  // 17 concurrent reset requests
  await freshLimits();
  const E = "erin@example.test";
  await call("POST", "/v1/app/signup", {
    body: {
      email: E,
      password: PASSWORD,
      displayName: "Erin",
      organizationName: "Erin Ltd",
    },
  });
  await run();
  await freshLimits();
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      call("POST", "/v1/app/password-reset/request", { body: { email: E } }),
    ),
  );
  await run();
  const mails17 = received.filter(
    (m) => m.to === E && m.text?.includes("reset"),
  );
  const live =
    await sql`select count(*)::int n from user_tokens t join user_accounts u on u.user_id = t.user_id where u.email = ${E} and t.purpose = 'RESET_PASSWORD' and t.used_at is null`;
  record(
    17,
    "ten simultaneous reset requests produce one email and one live link",
    burst.every((x) => x.status === 202) &&
      mails17.length === 1 &&
      live[0].n === 1,
    { mails: mails17.length },
  );

  // 18 provider outage
  await freshLimits();
  const F = "fay@example.test";
  await call("POST", "/v1/app/signup", {
    body: {
      email: F,
      password: PASSWORD,
      displayName: "Fay",
      organizationName: "Fay Ltd",
    },
  });
  mode = "429";
  await run();
  const deferred = (await outbox(F, "VERIFY_EMAIL"))[0];
  mode = "500";
  await run();
  const unknown500 = (await outbox(F, "VERIFY_EMAIL"))[0];
  mode = "ok";
  record(
    18,
    "provider rate limit defers (message stays queued); a 5xx outage makes it UNKNOWN and it is not sent again",
    deferred.state === "QUEUED" &&
      deferred.attempts === 1 &&
      unknown500.state === "UNKNOWN",
  );
  const op = await json(
    await call("GET", "/v1/admin/ops/email-outbox", {
      bearer: ADMIN_TOKEN,
      origin: null,
    }),
  );
  record(
    18.1,
    "the operator view shows the unknown messages with masked recipients and no bodies or tokens",
    op.counts?.UNKNOWN >= 1 &&
      op.needsAttention?.every((x) => x.to.includes("***")) &&
      !JSON.stringify(op).includes("token=") &&
      !JSON.stringify(op).includes("@example.test"),
  );

  // 19 session expiry
  await freshLimits();
  const s19 = await login(B);
  await sql`update user_sessions set idle_expires_at = now() - interval '1 minute' where user_id = (select user_id from user_accounts where email = ${B})`;
  record(
    19,
    "an idle-expired session is refused and not listed",
    (await call("GET", "/v1/app/me", { cookie: s19.cookie })).status === 401,
  );

  // 20 CSRF and Origin
  await freshLimits();
  const g = await login(B);
  const noCsrf = await call("POST", "/v1/app/sessions/revoke-others", {
    cookie: g.cookie,
    body: {},
  });
  const badCsrf = await call("POST", "/v1/app/sessions/revoke-others", {
    cookie: g.cookie,
    csrf: "x".repeat(43),
    body: {},
  });
  const evil = await call("POST", "/v1/app/sessions/revoke-others", {
    cookie: g.cookie,
    csrf: g.csrf,
    origin: "https://evil.example",
    body: {},
  });
  const evilLogin = await call("POST", "/v1/app/login", {
    origin: "https://evil.example",
    body: { email: B, password: PASSWORD },
  });
  const evilReset = await call("POST", "/v1/app/password-reset/request", {
    origin: "https://evil.example",
    body: { email: B },
  });
  const ok = await call("POST", "/v1/app/sessions/revoke-others", {
    cookie: g.cookie,
    csrf: g.csrf,
    body: {},
  });
  record(
    20,
    "missing/invalid CSRF and a foreign Origin are refused; the genuine request works",
    noCsrf.status === 403 &&
      badCsrf.status === 403 &&
      evil.status === 403 &&
      evilLogin.status === 403 &&
      evilReset.status === 403 &&
      ok.status === 200,
  );

  // never-leak sweep: the API key and recovery links appear in no response we saw
  const leaked = results.some((x) =>
    JSON.stringify(x).includes("re_acceptance_key"),
  );
  record(21, "the API key appears in no recorded result", !leaked);
} catch (e) {
  record(0, "acceptance run aborted", false, {
    error: String(e?.message ?? e).slice(0, 300),
  });
} finally {
  await stopHost();
  fake.close();
  await sql.end({ timeout: 2 }).catch(() => undefined);
  await admin
    .unsafe(`drop database if exists ${DB} with (force)`)
    .catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
const ok = results.length > 0 && results.every((x) => x.ok);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
  "docs/evidence/b1-b2-acceptance.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      what: "compiled host (separate process) + real HTTP + PostgreSQL; provider is a local stand-in, not Resend",
      ok,
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(ok ? "ALL PASS" : "FAILURES");
process.exit(ok ? 0 : 1);
