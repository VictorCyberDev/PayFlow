import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { handleCalendarRead, handleCalendarWrite } from "../api/calendar.js";
import { UserAuthService } from "../src/network/user-auth.js";
import { eventFromFlight, WorkspaceCalendar } from "../src/partner/calendar.js";

/** D-calendar — PayFlow's own calendar, over real PostgreSQL. */
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://payflow.example";
const PASSWORD = "correct horse battery staple";

let sql: ReturnType<typeof postgres>;
let auth: UserAuthService;
let calendar: WorkspaceCalendar;
let deps: { auth: UserAuthService; calendar: WorkspaceCalendar };

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 4, prepare: false, onnotice: () => undefined });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  for (const f of (await readdir("db/migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await sql.unsafe(await readFile("db/migrations/" + f, "utf8"));
  const now = () => new Date().toISOString();
  auth = new UserAuthService({ sql, now });
  calendar = new WorkspaceCalendar(sql, now);
  deps = { auth, calendar };
});
afterAll(async () => {
  if (url) await sql?.end({ timeout: 5 });
});

let n = 0;
const email = () => `cal${(n += 1)}.${Date.now()}@example.com`;
let caller = 0;
function headers(extra: Record<string, string> = {}) {
  caller += 1;
  return {
    "content-type": "application/json",
    origin: ORIGIN,
    "x-forwarded-for": `198.51.100.${caller % 250}`,
    "x-forwarded-proto": "https",
    ...extra,
  };
}
/** Signs a fresh workspace in and returns what a browser would hold. */
async function workspace() {
  const address = email();
  const made = await auth.signup({
    email: address,
    password: PASSWORD,
    displayName: "Ada",
    organizationName: "Ada Studio",
  });
  if (!made.ok) throw new Error(made.refusal);
  const entered = await auth.login({ email: address, password: PASSWORD });
  if (!entered.ok || !("grant" in entered)) throw new Error("login failed");
  return {
    cookie: `pf_session=${entered.grant.sessionToken}`,
    csrf: entered.grant.csrfToken,
    organizationId: entered.grant.member.organizationId,
  };
}
const write = (body: unknown, w: { cookie: string; csrf: string }) =>
  new Request(`${ORIGIN}/api/calendar`, {
    method: "POST",
    headers: headers({ cookie: w.cookie, "x-payflow-csrf": w.csrf }),
    body: JSON.stringify(body),
  });
const read = (w: { cookie: string }, from: string, to: string) =>
  new Request(
    `${ORIGIN}/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { method: "GET", headers: headers({ cookie: w.cookie }) },
  );
const EVENT = {
  title: "Investor call",
  startsAt: "2026-12-01T10:00:00.000Z",
  endsAt: "2026-12-01T11:00:00.000Z",
  location: "Zoom",
};
const WINDOW = [
  "2026-11-01T00:00:00.000Z",
  "2027-01-01T00:00:00.000Z",
] as const;

describe.skipIf(!url)("a calendar belongs to a workspace", () => {
  it("keeps what a founder puts in it, and gives it back in order", async () => {
    const w = await workspace();
    expect(
      (await handleCalendarWrite(write({ event: EVENT }, w), deps)).status,
    ).toBe(200);
    expect(
      (
        await handleCalendarWrite(
          write(
            {
              event: {
                ...EVENT,
                title: "Earlier thing",
                startsAt: "2026-11-20T09:00:00.000Z",
              },
            },
            w,
          ),
          deps,
        )
      ).status,
    ).toBe(200);
    const res = await handleCalendarRead(read(w, ...WINDOW), deps);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual([
      "Earlier thing",
      "Investor call",
    ]);
  });

  it("NEVER shows one workspace another's week", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    await handleCalendarWrite(
      write({ event: { ...EVENT, title: "My private board meeting" } }, mine),
      deps,
    );
    const res = await handleCalendarRead(read(theirs, ...WINDOW), deps);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(0);
    // And the raw text carries no trace of it either.
    expect(JSON.stringify(body)).not.toContain("private board meeting");
  });

  it("will not let one workspace delete another's event", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const made = await handleCalendarWrite(write({ event: EVENT }, mine), deps);
    const { event } = (await made.json()) as { event: { eventId: string } };
    const attempt = await handleCalendarWrite(
      write({ action: "remove", eventId: event.eventId }, theirs),
      deps,
    );
    expect(attempt.status).toBe(200);
    expect(((await attempt.json()) as { removed: boolean }).removed).toBe(
      false,
    );
    // Mine is untouched.
    const res = await handleCalendarRead(read(mine, ...WINDOW), deps);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
    // And its owner can remove it.
    const removed = await handleCalendarWrite(
      write({ action: "remove", eventId: event.eventId }, mine),
      deps,
    );
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
  });
});

describe.skipIf(!url)("what the calendar refuses", () => {
  it("refuses to show anything to someone who is not signed in", async () => {
    const anonymous = new Request(
      `${ORIGIN}/api/calendar?from=${WINDOW[0]}&to=${WINDOW[1]}`,
      { method: "GET", headers: headers() },
    );
    const res = await handleCalendarRead(anonymous, deps);
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Sign in/);
  });

  it("refuses a change without the token only this origin's page could read", async () => {
    const w = await workspace();
    const forged = new Request(`${ORIGIN}/api/calendar`, {
      method: "POST",
      headers: headers({ cookie: w.cookie, "x-payflow-csrf": "wrong" }),
      body: JSON.stringify({ event: EVENT }),
    });
    expect((await handleCalendarWrite(forged, deps)).status).toBe(403);
    // Nothing was written.
    const res = await handleCalendarRead(read(w, ...WINDOW), deps);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(
      0,
    );
  });

  it("refuses a cross-origin request, a decade-wide window, and an unreadable event", async () => {
    const w = await workspace();
    const foreign = new Request(`${ORIGIN}/api/calendar`, {
      method: "POST",
      headers: headers({
        cookie: w.cookie,
        "x-payflow-csrf": w.csrf,
        origin: "https://evil.example",
      }),
      body: JSON.stringify({ event: EVENT }),
    });
    expect((await handleCalendarWrite(foreign, deps)).status).toBe(403);
    expect(
      (
        await handleCalendarRead(
          read(w, "2000-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
          deps,
        )
      ).status,
    ).toBe(400);
    for (const bad of [
      { title: "", startsAt: EVENT.startsAt },
      { title: "x", startsAt: "not a time" },
      { title: "x", startsAt: EVENT.startsAt, endsAt: "2020-01-01T00:00:00Z" },
      { title: "x", startsAt: EVENT.startsAt, unexpected: true },
    ])
      expect(
        (await handleCalendarWrite(write({ event: bad }, w), deps)).status,
      ).toBe(400);
  });

  it("says accounts are not on rather than pretending, when there is no store", async () => {
    const res = await handleCalendarRead(
      new Request(`${ORIGIN}/api/calendar?from=${WINDOW[0]}&to=${WINDOW[1]}`, {
        method: "GET",
        headers: headers(),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe(
      "UNCONFIGURED",
    );
  });
});

describe.skipIf(!url)("a flight that was actually booked", () => {
  it("goes into the diary once, however many times it is added", async () => {
    const w = await workspace();
    const event = eventFromFlight({
      bookingReference: "RZPNX8",
      from: "LHR",
      to: "JFK",
      departingAt: "2026-12-15T09:45:00.000Z",
      arrivingAt: "2026-12-15T12:40:00.000Z",
      airline: "British Airways",
    })!;
    const first = await handleCalendarWrite(write({ event }, w), deps);
    expect(
      ((await first.json()) as { alreadyThere: boolean }).alreadyThere,
    ).toBe(false);
    const again = await handleCalendarWrite(write({ event }, w), deps);
    const body = (await again.json()) as { alreadyThere: boolean };
    // Booking the same flight twice does not put it in the diary twice, and PayFlow says which happened.
    expect(body.alreadyThere).toBe(true);
    const res = await handleCalendarRead(read(w, ...WINDOW), deps);
    const events = (
      (await res.json()) as { events: { source: string; sourceRef: string }[] }
    ).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "FLIGHT", sourceRef: "RZPNX8" });
  });

  it("carries the reference, and does not pretend to be a diary note somebody typed", () => {
    const e = eventFromFlight({
      bookingReference: "RZPNX8",
      from: "LHR",
      to: "JFK",
      departingAt: "2026-12-15T09:45:00.000Z",
      arrivingAt: null,
      airline: null,
    })!;
    expect(e.source).toBe("FLIGHT");
    expect(e.sourceRef).toBe("RZPNX8");
    expect(e.notes).toContain("RZPNX8");
    expect(e.endsAt).toBeUndefined();
    // A booking with no departure time cannot become a diary entry at all, rather than one at an invented time.
    expect(
      eventFromFlight({
        bookingReference: "X",
        from: "A",
        to: "B",
        departingAt: null,
        arrivingAt: null,
        airline: null,
      }),
    ).toBeNull();
  });
});

/**
 * Both of these were found by driving the deployed site, not by a test.
 *
 * The browser journey passed because the month view always sends its own window, so no test ever asked the endpoint
 * what it does when nobody names one. A bare read answered with the WRITE's validation message -- it told the caller
 * to supply a title, for a request that has no title to supply.
 */
describe.skipIf(!url)("a read that names no window", () => {
  it("answers with what is coming up instead of refusing", async () => {
    const w = await workspace();
    const res = await handleCalendarRead(
      new Request(`${ORIGIN}/api/calendar`, {
        method: "GET",
        headers: headers({ cookie: w.cookie }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; events: unknown[] };
    expect(body.status).toBe("OK");
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("says the dates are the problem when the dates are the problem", async () => {
    const w = await workspace();
    const res = await handleCalendarRead(
      new Request(`${ORIGIN}/api/calendar?from=not-a-date&to=also-not`, {
        method: "GET",
        headers: headers({ cookie: w.cookie }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    // The defect was that this said "needs a title and a start time" on a read.
    expect(body.message).toMatch(/dates|range/iu);
    expect(body.message).not.toMatch(/title/iu);
  });

  it("still refuses a half-named window rather than guessing the other end", async () => {
    const w = await workspace();
    const res = await handleCalendarRead(
      new Request(`${ORIGIN}/api/calendar?from=2026-11-01T00:00:00.000Z`, {
        method: "GET",
        headers: headers({ cookie: w.cookie }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
  });
});
