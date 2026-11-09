/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  WorkspaceSourceRegistry,
  sandboxWorkspaceSource,
  type WorkspaceSource,
} from "../src/missions/workspace-sources.js";

/**
 * V3 M51/M52 — workspace discovery and comparison through the real Gateway on PostgreSQL. The only source is the FICTIONAL sandbox
 * fixture or a test double: no live availability, price or booking is claimed anywhere in this file.
 */
const url = process.env.TEST_DATABASE_URL;
let mode: "OK" | "THROW" | "HANG" | "GARBAGE" = "OK";
const flaky: WorkspaceSource = {
  ...sandboxWorkspaceSource,
  id: "flaky",
  displayName: "Test double",
  search: (q, signal) => {
    if (mode === "THROW") return Promise.reject(new Error("down"));
    if (mode === "HANG")
      return new Promise((_r, rej) =>
        signal.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    if (mode === "GARBAGE")
      return Promise.resolve([{ listingId: "x" }, "nope", null]);
    return sandboxWorkspaceSource.search(q, signal);
  },
};
const live: WorkspaceSource = {
  ...sandboxWorkspaceSource,
  id: "needs-key",
  kind: "LIVE_PROVIDER",
  mode: "LIVE",
  credential: "REQUIRED",
};

(url ? describe : describe.skip)(
  "M51/M52 workspace discovery (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        TRUNCATE + ",mission_workspace_listings,mission_workspace_searches",
      workspaceSources: () =>
        new WorkspaceSourceRegistry()
          .register(sandboxWorkspaceSource)
          .register(flaky)
          .register(live),
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const scene = (over: Record<string, unknown> = {}) =>
      activeMission(
        h,
        contract({
          currency: "GBP",
          approvedProviderTypes: ["WORKSPACE_PROVIDER"],
          maxCommitmentMinor: 200_000,
          totalBudgetMinor: 500_000,
          ...over,
        }),
      );
    const req = (over: Record<string, unknown> = {}) => ({
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
      idempotencyKey: idemKey("w"),
      ...over,
    });
    const search = (
      t: string,
      id: string,
      b: unknown,
      base = "/v1/admin/org",
    ) => post(t, `${base}/missions/${id}/workspaces`, b);

    it("a search returns ranked, honestly assessed listings: qualified first by lowest exposure, UNKNOWNs named, nothing booked", async () => {
      const s = await scene();
      const r = await search(s.owner, s.id, req());
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      const v = (await body(r)).search;
      expect(v.sourceKind).toBe("SANDBOX_FIXTURE");
      expect(v.notice).toContain("not quotes, bookings or reservations");
      const ids = v.results.map(
        (x: { listing: { listingId: string } }) => x.listing.listingId,
      );
      // Leeds is another city and never returned; the qualified office leads, the unknown-everything office is last
      expect(ids).not.toContain("sbx-leeds-office");
      expect(ids[0]).toBe("sbx-harbour-office");
      expect(ids[ids.length - 1]).toBe("sbx-mill-office");
      const mill = v.results.find(
        (x: any) => x.listing.listingId === "sbx-mill-office",
      ).assessment;
      expect(mill.qualified).toBe(false);
      expect(mill.problems).toEqual(
        expect.arrayContaining([
          "AVAILABILITY_UNKNOWN",
          "EXPOSURE_UNKNOWN",
          "TERM_UNKNOWN",
          "CANCELLATION_UNKNOWN",
        ]),
      );
      const harbour = v.results[0].assessment;
      expect(harbour).toMatchObject({ qualified: true, problems: [] });
      expect(harbour.liability).toMatchObject({
        rentMinor: 84_000,
        totalCostMinor: 86_500,
        depositMinor: 50_000,
        maxExposureMinor: 136_500,
        cancellationExposureMinor: 0,
      });
      // nothing was reserved, spent or committed
      const led = await body(await get(s.owner, `${MISSIONS}/${s.id}/ledger`));
      expect(led.summary.exposureMinor).toBe(0);
      expect(h.provider.createCalls + h.provider.captureCalls).toBe(0);
      // persisted append-only, and the listing page reads the same assessments
      const list = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/workspaces`),
      );
      expect(
        list.searches[0].results.map((x: any) => x.listing.listingId),
      ).toEqual(ids);
      await expect(
        h.repo
          .sql`update mission_workspace_listings set listing_id = listing_id`,
      ).rejects.toThrow(/append-only/);
      await expect(
        h.repo.sql`delete from mission_workspace_searches`,
      ).rejects.toThrow(/append-only/);
    });

    it("the same key replays; the same key with different terms is refused; many concurrent identical requests store one search", async () => {
      const s = await scene();
      const b = req();
      const first = await search(s.owner, s.id, b);
      expect(first.status).toBe(201);
      const again = await search(s.owner, s.id, b);
      expect([again.status, (await body(again)).replayed]).toEqual([200, true]);
      const changed = await search(s.owner, s.id, {
        ...b,
        cancelAt: "2026-12-02T09:00:00.000Z",
      });
      expect([changed.status, (await body(changed)).reason]).toEqual([
        409,
        "IDEMPOTENCY_KEY_REUSED",
      ]);
      const b2 = req();
      const rs = await Promise.all(
        Array.from({ length: 6 }, () => search(s.owner, s.id, b2)),
      );
      for (const r of rs) expect([200, 201, 409]).toContain(r.status);
      expect(rs.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
      const n = await h.repo
        .sql`select count(*)::int n from mission_workspace_searches where idempotency_key = ${b2.idempotencyKey}`;
      expect(n[0]!.n).toBe(1);
    });

    it("refuses what the mission does not allow, and who may not ask", async () => {
      const s = await scene();
      const code = async (r: Response) => [r.status, (await body(r)).reason];
      expect(
        await code(
          await search(
            s.owner,
            s.id,
            req({ need: { ...req().need, currency: "USD" } }),
          ),
        ),
      ).toEqual([422, "CURRENCY_MISMATCH"]);
      expect(
        await code(
          await search(
            s.owner,
            s.id,
            req({ need: { ...req().need, maxExposureMinor: 200_001 } }),
          ),
        ),
      ).toEqual([422, "EXPOSURE_ABOVE_COMMITMENT"]);
      expect(
        await code(await search(s.owner, s.id, req({ sourceId: "nope" }))),
      ).toEqual([404, "UNKNOWN_SOURCE"]);
      expect(
        await code(await search(s.owner, s.id, req({ sourceId: "needs-key" }))),
      ).toEqual([403, "SOURCE_NOT_ALLOWED_HERE"]);
      expect((await search(s.owner, s.id, { ...req(), extra: 1 })).status).toBe(
        400,
      );
      expect(
        (
          await search(
            s.owner,
            s.id,
            req({
              stay: {
                start: "2026-12-15T09:00:00.000Z",
                end: "2026-12-08T09:00:00.000Z",
                people: 4,
              },
            }),
          )
        ).status,
      ).toBe(400);
      // a research agent (SEARCH) may; a negotiation agent (no SEARCH) may not; nobody can search another tenant's mission
      expect((await search(s.a, s.id, req(), "/v1/agent")).status).toBe(201);
      expect(await code(await search(s.b, s.id, req(), "/v1/agent"))).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      const stranger = await h.ownerOf("org-other");
      expect((await search(stranger, s.id, req())).status).toBe(404);
      // a mission that does not approve workspace providers, and one that is not active
      const no = await scene({
        approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      });
      expect(await code(await search(no.owner, no.id, req()))).toEqual([
        403,
        "PROVIDER_TYPE_NOT_APPROVED",
      ]);
      const sec = await h.member("SECURITY_ADMIN");
      expect(
        (await post(sec, `${MISSIONS}/${s.id}/pause`, { reason: "x" })).status,
      ).toBe(200);
      expect(await code(await search(s.owner, s.id, req()))).toEqual([
        409,
        "MISSION_NOT_ACTIVE",
      ]);
    });

    it("a failing, hanging or lying source stores nothing it should not: throw and hang are SOURCE_FAILED with no search; garbage records are dropped and counted", async () => {
      const s = await scene();
      mode = "THROW";
      expect(
        (await search(s.owner, s.id, req({ sourceId: "flaky" }))).status,
      ).toBe(502);
      mode = "HANG";
      expect(
        (await search(s.owner, s.id, req({ sourceId: "flaky" }))).status,
      ).toBe(502);
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_workspace_searches where mission_id = ${s.id}`
          )[0]!.n,
        ),
      ).toBe(0);
      mode = "GARBAGE";
      const g = await search(s.owner, s.id, req({ sourceId: "flaky" }));
      expect(g.status).toBe(201);
      const v = (await body(g)).search;
      expect([v.results.length, v.rejected]).toEqual([0, 3]);
      mode = "OK";
    }, 30_000);
  },
);
