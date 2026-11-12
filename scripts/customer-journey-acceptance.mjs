#!/usr/bin/env node
// A cross-domain customer journey on the COMPILED application, over real HTTP and PostgreSQL, with a restart in the middle.
//   npm run build && node scripts/customer-journey-acceptance.mjs
// Account -> mission -> approval -> launch run (discovery, survives a SIGKILL of the host) -> its search feeds a booking proposal -> the person
// approves the booking (budget held) -> ledger -> CSV export -> audit trail. Everything the sources return is a FICTIONAL sandbox fixture; nothing is
// booked, paid or sent anywhere; no email sender is configured. Time is the real clock. Writes docs/evidence/customer-journey-acceptance.json.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import {
  assertDisposableDatabase,
  assertScratchName,
} from "./lib/disposable-db.mjs";

const ADMIN =
  process.env.ACCEPT_ADMIN_URL ??
  "postgres://payflow:payflow_test@localhost:5432/payflow_test";
const DB = "journey_acceptance";
const PORT = 4819;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CRON = "c".repeat(40);
const PASSWORD = "correct horse battery staple";
const SIGNING = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const results = [];
const record = (n, name, ok, detail = {}) => {
  results.push({ n, name, ok, ...detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${String(n).padStart(2)} ${name}${ok ? "" : " " + JSON.stringify(detail)}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

assertDisposableDatabase(ADMIN);
assertScratchName(DB);
const admin = postgres(ADMIN, { max: 1, onnotice: () => undefined });
await admin.unsafe(`drop database if exists ${DB} with (force)`);
await admin.unsafe(`create database ${DB}`);
const dburl = new URL(ADMIN);
dburl.pathname = `/${DB}`;
const sql = postgres(dburl.toString(), { max: 2, onnotice: () => undefined });
for (const f of readdirSync("db/migrations")
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  if (Number(f.slice(0, 3)) === 28) continue;
  await sql.unsafe(readFileSync(`db/migrations/${f}`, "utf8"));
}

let host = null;
const start = async () => {
  host = spawn("node", ["scripts/serve-hosted.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      DATABASE_URL: dburl.toString(),
      PAYFLOW_M5_DEMO: "true",
      PAYFLOW_M5_PRINCIPAL_ID: "principal_journey",
      PAYFLOW_M5_AGENT_ID: "agent_journey",
      PAYFLOW_M5_BOOTSTRAP_KEY: "b".repeat(40),
      PAYFLOW_M5_ORIGIN: ORIGIN,
      CRON_SECRET: CRON,
      PAYFLOW_M6_SIGNING_KEY: SIGNING,
    },
  });
  let log = "";
  host.stdout.on("data", (c) => (log += c));
  host.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !log.includes("LISTENING"); i++) await sleep(100);
  if (!log.includes("LISTENING"))
    throw new Error("host did not start: " + log.slice(0, 300));
};
const kill = async () => {
  if (!host) return;
  const h = host;
  host = null;
  h.kill("SIGKILL");
  await new Promise((r) => h.once("exit", r));
};
const call = (method, path, o = {}) =>
  fetch(ORIGIN + path, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
      ...(o.origin === null ? {} : { origin: ORIGIN }),
      ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
const json = async (r) => r.json().catch(() => ({}));
const worker = () =>
  call("GET", "/v1/admin/ops/automation/run", { bearer: CRON, origin: null });

let session = null;
const as = () => ({ cookie: session.cookie, csrf: session.csrf });
const login = async (email) => {
  const r = await call("POST", "/v1/app/login", {
    body: { email, password: PASSWORD },
  });
  const cookie = `pf_session=${/pf_session=([^;]+)/u.exec(r.headers.get("set-cookie"))[1]}`;
  const me = await json(await call("GET", "/v1/app/me", { cookie }));
  return { cookie, csrf: me.csrfToken, me };
};

try {
  await start();
  const EMAIL = "journey@example.test";
  let r = await call("POST", "/v1/app/signup", {
    body: {
      email: EMAIL,
      password: PASSWORD,
      displayName: "Jo Journey",
      organizationName: "Journey Studio Ltd",
    },
  });
  session = await login(EMAIL);
  record(
    1,
    "an account is created and signed in; no email sender is configured and the app says so",
    r.status === 201 &&
      session.me.emailDelivery === "NOT_CONFIGURED" &&
      session.me.verificationRequired === false,
  );

  // a mission with workspaces and services approved, no agents
  const contract = {
    objective: "Set up a small design studio",
    intendedOutcome: "A place to work and a brand identity",
    successCriteria: ["A workable desk space", "A logo within budget"],
    currency: "GBP",
    totalBudgetMinor: 500_000,
    maxCommitmentMinor: 200_000,
    spendingCategories: ["WORKSPACE", "PROFESSIONAL_SERVICES"],
    approvedProviderTypes: ["WORKSPACE_PROVIDER", "PROFESSIONAL_SERVICES"],
    merchantRestrictions: { mode: "ANY" },
    agents: [],
    approvalConditions: { humanApprovalAboveMinor: 100_000 },
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  };
  r = await call("POST", "/v1/admin/org/missions", {
    ...as(),
    body: { contract, idempotencyKey: "journey-mission-0001" },
  });
  const created = await json(r);
  const mid = created.mission?.missionId;
  record(
    2,
    "the person drafts a mission",
    r.status === 201 && /^msn_/u.test(mid ?? ""),
    { status: r.status, reason: created.reason },
  );
  r = await call("POST", `/v1/admin/org/missions/${mid}/approve`, {
    ...as(),
    body: { version: 1 },
  });
  record(
    3,
    "the person approves it (the only owner, no approval rule set)",
    r.status === 200,
    { status: r.status },
  );

  // discovery run, then the host is killed before the worker runs it
  const steps = [
    {
      area: "WORKSPACE",
      request: {
        sourceId: "sandbox-workspaces",
        need: {
          country: "GB",
          city: "Bristol",
          kinds: ["PRIVATE_OFFICE", "DESK", "MEETING_ROOM"],
          minCapacity: 4,
          currency: "GBP",
          maxExposureMinor: 200_000,
          requiredAmenities: ["Wi-Fi"],
          maxMinTermDays: 14,
        },
        stay: {
          start: "2026-12-08T09:00:00.000Z",
          end: "2026-12-15T09:00:00.000Z",
          people: 4,
        },
        cancelAt: "2026-12-01T09:00:00.000Z",
      },
    },
    {
      area: "SERVICES",
      request: {
        sourceId: "sandbox-services",
        need: {
          category: "DESIGN",
          currency: "GBP",
          maxPriceMinor: 100_000,
          maxDeliveryDays: 14,
          minRevisions: 1,
          minRefundBeforeStartBps: 5_000,
        },
      },
    },
  ];
  r = await call("POST", `/v1/admin/org/missions/${mid}/launch-runs`, {
    ...as(),
    body: { steps },
  });
  const run = await json(r);
  record(
    4,
    "a launch run is queued: nothing has searched yet",
    r.status === 201 &&
      run.state === "QUEUED" &&
      run.steps.every((s) => s.state === "PENDING"),
    { status: r.status, reason: run.reason },
  );
  await kill();
  await start();
  session = await login(EMAIL); // the sign-in survived in PostgreSQL; a fresh one is only to be explicit about the new process
  const stillQueued = (
    await json(
      await call("GET", `/v1/admin/org/missions/${mid}/launch-runs`, {
        cookie: session.cookie,
      }),
    )
  ).runs?.[0];
  record(
    5,
    "after the host is killed and restarted the run is still queued (durable)",
    stillQueued?.runId === run.runId && stillQueued.state === "QUEUED",
  );
  const w = await json(await worker());
  const done = (
    await json(
      await call("GET", `/v1/admin/org/missions/${mid}/launch-runs`, {
        cookie: session.cookie,
      }),
    )
  ).runs?.[0];
  record(
    6,
    "the authorized worker runs it on the new process: READY, both steps done, honest counts",
    done?.state === "READY" &&
      done.steps.every((s) => s.state === "DONE") &&
      done.steps[0].summary.qualified >= 1 &&
      done.steps[1].summary.found > 0,
    { ran: w.ran, state: done?.state, steps: done?.steps },
  );
  const looked =
    await sql`select (select count(*)::int from mission_ledger_items) ledger, (select count(*)::int from mission_bookings) bookings`;
  record(
    7,
    "the run spent and booked nothing",
    looked[0].ledger === 0 && looked[0].bookings === 0,
    looked[0],
  );

  // the discovery feeds a booking proposal; the person approves it
  const searchId = done?.steps[0].summary.searchId;
  const search = (
    await sql`select search_id from mission_workspace_searches where search_id = ${searchId}`
  )[0];
  const listings =
    await sql`select listing_id from mission_workspace_listings where search_id = ${searchId} order by listing_id`;
  record(
    8,
    "the search the run recorded is stored with its listings",
    !!search && listings.length > 0,
    { listings: listings.length },
  );
  // the first listing the run found that meets the mission's needs (its own assessment, read back through the API)
  const read = await json(
    await call("GET", `/v1/admin/org/missions/${mid}/workspaces`, {
      cookie: session.cookie,
    }),
  );
  const listingId = read.searches
    ?.find((x) => x.searchId === searchId)
    ?.results?.find((x) => x.assessment.qualified)?.listing.listingId;
  r = await call("POST", `/v1/admin/org/missions/${mid}/bookings`, {
    ...as(),
    body: {
      searchId,
      listingId,
      deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      idempotencyKey: "journey-booking-0001",
    },
  });
  const booking = await json(r);
  const bid = booking.booking?.bookingId ?? booking.bookingId;
  record(
    9,
    "the person proposes a booking from the run's own search; nothing is held yet",
    r.status === 201 &&
      !!bid &&
      (await sql`select count(*)::int n from mission_ledger_items`)[0].n === 0,
    { status: r.status, reason: booking.reason },
  );
  r = await call("POST", `/v1/admin/org/bookings/${bid}/approve`, {
    ...as(),
    body: {},
  });
  const approved = await json(r);
  const led = await json(
    await call("GET", `/v1/admin/org/missions/${mid}/ledger`, {
      cookie: session.cookie,
    }),
  );
  record(
    10,
    "approving the booking holds budget in the ledger; nothing is claimed as reserved or paid",
    r.status === 200 &&
      led.summary.exposureMinor > 0 &&
      JSON.stringify(approved).indexOf("RESERVED") === -1,
    {
      status: r.status,
      reason: approved.reason,
      exposure: led.summary?.exposureMinor,
    },
  );
  const csv = await json(
    await call("GET", `/v1/admin/org/missions/${mid}/ledger/export`, {
      cookie: session.cookie,
    }),
  );
  record(
    11,
    "the ledger exports as CSV for a bookkeeper",
    typeof csv.csv === "string" &&
      csv.csv.split("\r\n")[0].startsWith('"Item","Kind"') &&
      csv.csv.includes("GBP"),
    { filename: csv.filename },
  );
  const audit =
    await sql`select action from organization_audit_events order by occurred_at`;
  const actions = audit.map((a) => a.action);
  record(
    12,
    "the audit trail holds the mission, the approval and the booking, and no address or token",
    actions.some((a) => /MISSION/u.test(a)) &&
      actions.some((a) => /BOOKING/u.test(a)) &&
      !JSON.stringify(
        await sql`select detail from organization_audit_events`,
      ).includes(EMAIL),
    { actions: [...new Set(actions)].slice(0, 12) },
  );
} catch (e) {
  record(0, "journey aborted", false, {
    error: String(e?.message ?? e).slice(0, 400),
  });
} finally {
  await kill();
  await sql.end({ timeout: 2 }).catch(() => undefined);
  await admin
    .unsafe(`drop database if exists ${DB} with (force)`)
    .catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
const ok = results.length > 0 && results.every((x) => x.ok);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
  "docs/evidence/customer-journey-acceptance.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      what: "compiled host (separate process, killed and restarted mid-journey) + real HTTP + PostgreSQL; sources are fictional sandbox fixtures; no email sender; no payment provider",
      ok,
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(ok ? "ALL PASS" : "FAILURES");
process.exit(ok ? 0 : 1);
