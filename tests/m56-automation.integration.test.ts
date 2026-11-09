/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it } from "vitest";
import { hostHarness, ADMIN_TOKEN } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  AutomationService,
  type Handler,
  type JobTenant,
} from "../src/automation/automation-service.js";

/**
 * V3 M56/M57 — durable automation on PostgreSQL. What these pin: two workers never run one job; a lost worker's pure job is re-queued but its
 * effectful job becomes UNKNOWN and is never run again; a thrown handler is not "did nothing"; recurring slots run once however many tickers fire.
 */
const url = process.env.TEST_DATABASE_URL;
const T: JobTenant = { organizationId: "org-a", environment: "SANDBOX" };
(url ? describe : describe.skip)("M56/M57 automation (PostgreSQL)", () => {
  const h = hostHarness({
    extraTruncate: TRUNCATE + ",automation_jobs,automation_schedules",
  });
  const mk = () =>
    new AutomationService({ sql: h.repo.sql, now: () => h.iso() }, 60);
  const ok: Handler = () => Promise.resolve({ outcome: "SUCCEEDED" });

  it("enqueue is once per key even when many callers race; a repeat returns the existing job", async () => {
    const a = mk();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        a.enqueue(T, { kind: "PING", effect: "NONE", dedupeKey: "k1" }),
      ),
    );
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.job.jobId)).size).toBe(1);
    const other = await a.enqueue(
      { ...T, organizationId: "org-b" },
      { kind: "PING", effect: "NONE", dedupeKey: "k1" },
    );
    expect(other.created).toBe(true); // the key is per tenant
  });

  it("concurrent workers each get distinct jobs and every job runs exactly once", async () => {
    const a = mk();
    for (let i = 0; i < 30; i++)
      await a.enqueue(T, { kind: "PING", effect: "NONE", dedupeKey: `j${i}` });
    const seen: string[] = [];
    const h1: Handler = (j) => {
      seen.push(j.jobId);
      return Promise.resolve({ outcome: "SUCCEEDED" });
    };
    await Promise.all(
      Array.from({ length: 6 }, (_v, i) =>
        (async () => {
          for (let k = 0; k < 4; k++) await a.runOnce(`w${i}`, { PING: h1 }, 3);
        })(),
      ),
    );
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect((await a.list(T, 100)).every((j) => j.state === "SUCCEEDED")).toBe(
      true,
    );
  });

  it("a pure job that throws is retried with backoff, not before it is due, and fails when attempts run out", async () => {
    const a = mk();
    const { job } = await a.enqueue(T, {
      kind: "FLAKY",
      effect: "NONE",
      dedupeKey: "f",
      maxAttempts: 3,
    });
    let calls = 0;
    const boom: Handler = () => {
      calls++;
      return Promise.reject(new Error("x"));
    };
    await a.runOnce("w", { FLAKY: boom });
    expect(calls).toBe(1);
    await a.runOnce("w", { FLAKY: boom }); // not due yet
    expect(calls).toBe(1);
    h.advance(10_000);
    await a.runOnce("w", { FLAKY: boom });
    h.advance(10_000);
    await a.runOnce("w", { FLAKY: boom });
    expect(calls).toBe(3);
    const j = (await a.list(T)).find((x) => x.jobId === job.jobId)!;
    expect([j.state, j.attempts]).toEqual(["FAILED", 3]);
  });

  it("an effectful job is never retried: a throw, a retry request and a lost worker all end in UNKNOWN; only a person settles it, once", async () => {
    const a = mk();
    for (const k of ["threw", "retry", "lost"])
      await a.enqueue(T, { kind: "PAY", effect: "EXTERNAL", dedupeKey: k });
    let runs = 0;
    // 1) throws, 2) asks for retry
    const res: Handler = (j) => {
      runs++;
      return j.payload.x === undefined && runs === 2
        ? Promise.resolve({ outcome: "RETRY", retryInSeconds: 1 })
        : Promise.reject(new Error("boom"));
    };
    await a.runOnce("w", { PAY: res }, 2);
    // 3) a worker claims it and is lost
    const [lost] = await a.claim("dead-worker", 1);
    expect(lost).toBeDefined();
    h.advance(61_000);
    expect(await a.reapExpired()).toEqual({
      requeued: 0,
      failed: 0,
      unknown: 1,
    });
    const all = await a.list(T);
    expect(all.map((j) => j.state)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    // never claimed or run again, however long we wait
    h.advance(10 * 86_400_000);
    expect(await a.claim("w2", 10)).toEqual([]);
    expect(runs).toBe(2);
    // the database itself refuses to put it back in the queue
    await expect(
      h.repo
        .sql`update automation_jobs set state = 'QUEUED' where state = 'UNKNOWN'`,
    ).rejects.toThrow(/never retried/);
    const id = all[0]!.jobId;
    expect(
      await a.settle(
        T,
        id,
        "SUCCEEDED",
        "member-1",
        "checked with the provider",
      ),
    ).toBe(true);
    expect(await a.settle(T, id, "FAILED", "member-1", "again")).toBe(false);
    expect(
      await a.settle(
        { ...T, organizationId: "org-b" },
        all[1]!.jobId,
        "FAILED",
        "x",
        "x",
      ),
    ).toBe(false);
  });

  it("a lost pure job is re-queued; only the lease holder may finish a job; a job with no handler fails", async () => {
    const a = mk();
    await a.enqueue(T, { kind: "PURE", effect: "NONE", dedupeKey: "p" });
    await a.enqueue(T, { kind: "NOBODY", effect: "NONE", dedupeKey: "n" });
    const [j] = await a.claim("w1", 1);
    expect(await a.finish(j!, "intruder", { outcome: "SUCCEEDED" })).toBe(
      false,
    );
    h.advance(61_000);
    expect(await a.reapExpired()).toMatchObject({ requeued: 1 });
    // the old holder's late answer is refused: it no longer holds the lease
    expect(await a.finish(j!, "w1", { outcome: "SUCCEEDED" })).toBe(false);
    await a.runOnce("w2", { PURE: ok });
    const by = Object.fromEntries(
      (await a.list(T)).map((x) => [x.kind, x.state]),
    );
    expect(by).toEqual({ PURE: "SUCCEEDED", NOBODY: "FAILED" });
  });

  it("a finished job cannot be changed, and jobs cannot be deleted", async () => {
    const a = mk();
    await a.enqueue(T, { kind: "PURE", effect: "NONE", dedupeKey: "d" });
    await a.runOnce("w", { PURE: ok });
    await expect(
      h.repo.sql`update automation_jobs set state = 'QUEUED'`,
    ).rejects.toThrow(/finished/);
    await expect(h.repo.sql`delete from automation_jobs`).rejects.toThrow(
      /append-only/,
    );
    await expect(
      h.repo.sql`update automation_jobs set payload = '{"x":1}'::jsonb`,
    ).rejects.toThrow(/never change/);
  });

  it("a recurring slot makes one job however many tickers fire, restarts do not repeat it, and a long outage is capped", async () => {
    const a = mk();
    const id = await a.createSchedule(T, {
      kind: "PURE",
      effect: "NONE",
      everySeconds: 60,
      createdBy: "m1",
    });
    const rs = await Promise.all(Array.from({ length: 5 }, () => a.tick()));
    expect(rs.reduce((n, r) => n + r.created, 0)).toBe(1);
    expect((await a.tick()).created).toBe(0);
    h.advance(60_000);
    expect((await a.tick()).created).toBe(1);
    h.advance(3 * 3_600_000); // a three-hour outage: 180 slots missed, only the latest 3 are made
    expect((await a.tick()).created).toBe(3);
    expect(await a.setScheduleActive(T, id, false)).toBe(true);
    h.advance(120_000);
    expect((await a.tick()).created).toBe(0);
    expect(
      await a.setScheduleActive({ ...T, organizationId: "org-b" }, id, true),
    ).toBe(false);
  });

  it("end to end: approving a booking schedules its expiry; the operator's run expires it and releases the held budget though nobody looked", async () => {
    const s = await activeMission(
      h,
      contract({
        currency: "GBP",
        approvedProviderTypes: ["WORKSPACE_PROVIDER"],
        maxCommitmentMinor: 200_000,
        totalBudgetMinor: 500_000,
      }),
    );
    const post = (p: string, b: unknown) => h.call(s.owner, "POST", p, b);
    const search = await post(`/v1/admin/org/missions/${s.id}/workspaces`, {
      sourceId: "sandbox-workspaces",
      need: {
        country: "GB",
        city: "Bristol",
        kinds: ["PRIVATE_OFFICE"],
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
      idempotencyKey: idemKey("w"),
    });
    const sid = ((await search.json()) as any).search.searchId;
    const prop = await post(`/v1/admin/org/missions/${s.id}/bookings`, {
      searchId: sid,
      listingId: "sbx-harbour-office",
      deadline: "2026-10-25T10:00:00.000Z",
      idempotencyKey: idemKey("b"),
    });
    const bid = ((await prop.json()) as any).booking.bookingId;
    expect(
      (await post(`/v1/admin/org/bookings/${bid}/approve`, {})).status,
    ).toBe(200);
    const exposure = async () =>
      (
        (await (
          await h.call(s.owner, "GET", `${MISSIONS}/${s.id}/ledger`)
        ).json()) as any
      ).summary.exposureMinor;
    expect(await exposure()).toBeGreaterThan(0);
    const jobs = await h.repo
      .sql`select state, run_after from automation_jobs where kind = 'BOOKING_EXPIRE'`;
    expect(jobs).toHaveLength(1);
    // before the deadline a run does nothing to it
    const early = await h.call(
      ADMIN_TOKEN,
      "POST",
      "/v1/admin/ops/automation/run",
    );
    expect(early.status, JSON.stringify(await early.clone().json())).toBe(200);
    expect(await exposure()).toBeGreaterThan(0);
    // after the deadline, with nobody viewing the booking, the run expires it and frees the budget
    h.advance(3 * 86_400_000);
    const run = await h.call(
      ADMIN_TOKEN,
      "POST",
      "/v1/admin/ops/automation/run",
    );
    expect(((await run.json()) as any).ran).toBeGreaterThanOrEqual(1);
    expect(await exposure()).toBe(0);
    const st = await h.repo
      .sql`select state from mission_bookings where booking_id = ${bid}`;
    expect(st[0]!.state).toBe("EXPIRED");
    // nobody without the operator token (or the scheduler secret) can run it
    expect(
      (await h.call(s.owner, "POST", "/v1/admin/ops/automation/run")).status,
    ).toBe(403);
    expect(
      (await h.call(null, "POST", "/v1/admin/ops/automation/run")).status,
    ).toBe(401);
  });

  it("the scheduler secret may run due automation by GET and nothing else; a wrong secret or POST is refused", async () => {
    const CRON = "c".repeat(48);
    await h.restart({ CRON_SECRET: CRON });
    const ok = await h.call(CRON, "GET", "/v1/admin/ops/automation/run");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ via: "SCHEDULER" });
    expect(
      (await h.call(CRON, "POST", "/v1/admin/ops/automation/run")).status,
    ).toBe(401);
    expect(
      (await h.call("x".repeat(48), "GET", "/v1/admin/ops/automation/run"))
        .status,
    ).toBe(401);
    expect(
      (await h.call(CRON, "GET", "/v1/admin/ops/alerts")).status,
    ).toBeGreaterThanOrEqual(401);
  });
});
