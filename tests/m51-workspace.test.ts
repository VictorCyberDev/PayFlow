import { describe, expect, it } from "vitest";
import {
  assess,
  billableUnits,
  liability,
  parseListings,
  rank,
  type Stay,
  type WorkspaceListing,
  type WorkspaceNeed,
} from "../src/missions/workspace.js";

/** V3 M51/M52 — workspace domain: untrusted parsing, UNKNOWN is never favourable, liability is integer and monotone. Pure; no source is contacted. */
const l = (over: Partial<WorkspaceListing> = {}): WorkspaceListing => ({
  listingId: "ws-1",
  kind: "PRIVATE_OFFICE",
  name: "Harbour Studio",
  locality: { country: "GB", city: "Bristol" },
  capacity: 6,
  rate: { basis: "DAILY", minor: 12_000, currency: "GBP" },
  depositMinor: 50_000,
  feesMinor: 2_500,
  minTermDays: 7,
  cancellation: {
    policy: "FREE_UNTIL",
    freeHoursBeforeStart: 48,
    penaltyBps: 5_000,
  },
  amenities: ["Wi-Fi", "Kitchen"],
  availableWindows: [
    { start: "2026-12-01T00:00:00.000Z", end: "2026-12-31T00:00:00.000Z" },
  ],
  provenance: {
    sourceId: "sandbox-workspaces",
    observedAt: "2026-11-09T10:00:00.000Z",
    evidence: "DOCUMENT_REF",
    url: null,
  },
  ...over,
});
const stay: Stay = {
  start: "2026-12-08T09:00:00.000Z",
  end: "2026-12-15T09:00:00.000Z",
  people: 4,
};
const need: WorkspaceNeed = {
  country: "GB",
  city: "bristol",
  kinds: ["PRIVATE_OFFICE", "DESK"],
  minCapacity: 4,
  currency: "GBP",
  maxExposureMinor: 200_000,
  requiredAmenities: ["wi-fi"],
  maxMinTermDays: 14,
};
const CANCEL = "2026-12-01T09:00:00.000Z";

describe("M51 parsing is bounded and never repairs", () => {
  it("drops bad and duplicate records, counts them, and refuses non-arrays and oversize output", () => {
    const r = parseListings([
      l(),
      l({ listingId: "ws-2" }),
      { listingId: "bad" },
      l(),
      { ...l({ listingId: "ws-3" }), extra: 1 },
    ]);
    expect(r.listings.map((x) => x.listingId)).toEqual(["ws-1", "ws-2"]);
    expect(r.rejected).toBe(3);
    expect(parseListings({ not: "an array" }).listings).toEqual([]);
    expect(
      parseListings([l()], { maxRecords: 50, maxBytes: 10 }),
    ).toMatchObject({ listings: [], truncated: true });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(parseListings(circular).listings).toEqual([]);
    expect(
      parseListings(
        Array.from({ length: 60 }, (_, i) => l({ listingId: `ws-${i}` })),
      ).listings,
    ).toHaveLength(50);
  });
  it("refuses non-https urls, credentials in urls and inverted availability windows", () => {
    const prov = l().provenance;
    for (const url of [
      "http://x.example/a",
      "https://u:p@x.example/a",
      "javascript:alert(1)",
    ])
      expect(
        parseListings([l({ provenance: { ...prov, url } })]).listings,
      ).toEqual([]);
    expect(
      parseListings([
        l({
          availableWindows: [
            {
              start: "2026-12-31T00:00:00.000Z",
              end: "2026-12-01T00:00:00.000Z",
            },
          ],
        }),
      ]).listings,
    ).toEqual([]);
    expect(
      parseListings([
        l({ provenance: { ...prov, url: "https://x.example/a" } }),
      ]).listings,
    ).toHaveLength(1);
  });
});

describe("M52 liability", () => {
  it("bills started units, adds stated fees and states deposit and cancellation exposure separately", () => {
    expect(billableUnits("DAILY", stay)).toBe(7);
    expect(
      billableUnits("HOURLY", {
        start: stay.start,
        end: "2026-12-08T10:01:00.000Z",
      }),
    ).toBe(2); // a started hour is billed
    expect(billableUnits("MONTHLY", stay)).toBe(1);
    const a = liability(l(), stay, CANCEL);
    expect(a).toMatchObject({
      rentMinor: 84_000,
      totalCostMinor: 86_500,
      depositMinor: 50_000,
      maxExposureMinor: 136_500,
      cancellationExposureMinor: 0,
      unknown: [],
    });
    // after the free period the penalty applies to rent + fees
    expect(
      liability(l(), stay, "2026-12-07T09:00:00.000Z")
        .cancellationExposureMinor,
    ).toBe(43_250);
    expect(
      liability(l({ cancellation: { policy: "NON_REFUNDABLE" } }), stay, CANCEL)
        .cancellationExposureMinor,
    ).toBe(86_500);
  });
  it("an unstated component makes the figure UNKNOWN, never lower", () => {
    expect(liability(l({ feesMinor: null }), stay, CANCEL)).toMatchObject({
      totalCostMinor: null,
      maxExposureMinor: null,
      unknown: ["FEES"],
    });
    expect(liability(l({ depositMinor: null }), stay, CANCEL)).toMatchObject({
      maxExposureMinor: null,
      unknown: ["DEPOSIT"],
    });
    expect(
      liability(l({ cancellation: { policy: "UNKNOWN" } }), stay, CANCEL),
    ).toMatchObject({
      cancellationExposureMinor: null,
      unknown: ["CANCELLATION"],
    });
  });
  it("property: integer, never negative, monotone in the stay length and in the rate", () => {
    let seed = 51;
    const rnd = (n: number) =>
      ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % n;
    for (let i = 0; i < 2000; i++) {
      const basis = (["HOURLY", "DAILY", "MONTHLY"] as const)[rnd(3)]!;
      const base = l({
        rate: { basis, minor: rnd(500_000), currency: "GBP" },
        feesMinor: rnd(10_000),
        depositMinor: rnd(100_000),
        cancellation: {
          policy: "FREE_UNTIL",
          freeHoursBeforeStart: rnd(200),
          penaltyBps: rnd(10_001),
        },
      });
      const s1: Stay = {
        start: stay.start,
        end: new Date(
          Date.parse(stay.start) + (1 + rnd(2000)) * 3_600_000,
        ).toISOString(),
        people: 1,
      };
      const s2: Stay = {
        ...s1,
        end: new Date(Date.parse(s1.end) + rnd(500) * 3_600_000).toISOString(),
      };
      const a = liability(
        base,
        s1,
        new Date(Date.parse(stay.start) - rnd(400) * 3_600_000).toISOString(),
      );
      const b = liability(
        base,
        s2,
        new Date(Date.parse(stay.start) - rnd(400) * 3_600_000).toISOString(),
      );
      for (const v of [
        a.rentMinor,
        a.totalCostMinor!,
        a.maxExposureMinor!,
        a.cancellationExposureMinor!,
      ]) {
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(b.rentMinor).toBeGreaterThanOrEqual(a.rentMinor);
      expect(a.cancellationExposureMinor!).toBeLessThanOrEqual(
        a.totalCostMinor!,
      );
      expect(a.maxExposureMinor).toBe(a.totalCostMinor! + a.depositMinor!);
    }
  });
});

describe("M52 qualification", () => {
  it("a listing that fits qualifies; every shortfall has its own named problem", () => {
    expect(assess(l(), need, stay, CANCEL)).toMatchObject({
      qualified: true,
      problems: [],
    });
    const p = (
      over: Partial<WorkspaceListing>,
      n: Partial<WorkspaceNeed> = {},
      s: Stay = stay,
    ) => assess(l(over), { ...need, ...n }, s, CANCEL).problems;
    expect(p({ locality: { country: "GB", city: "Leeds" } })).toEqual([
      "WRONG_CITY",
    ]);
    expect(p({ kind: "MEETING_ROOM" })).toEqual(["WRONG_KIND"]);
    expect(p({ capacity: 3 })).toEqual(["TOO_SMALL"]);
    expect(p({}, {}, { ...stay, people: 7 })).toEqual(["TOO_SMALL"]);
    expect(
      p({ rate: { basis: "DAILY", minor: 12_000, currency: "USD" } }),
    ).toEqual(["WRONG_CURRENCY"]);
    expect(p({ amenities: ["Kitchen"] })).toEqual(["MISSING_AMENITY"]);
    expect(
      p({
        availableWindows: [
          {
            start: "2026-12-10T00:00:00.000Z",
            end: "2026-12-31T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual(["NOT_AVAILABLE_FOR_STAY"]);
    expect(p({}, { maxExposureMinor: 136_499 })).toEqual([
      "ABOVE_EXPOSURE_LIMIT",
    ]);
    expect(p({}, { maxExposureMinor: 136_500 })).toEqual([]); // the limit is inclusive
    expect(p({ minTermDays: 30 })).toEqual(["TERM_TOO_LONG"]);
  });
  it("UNKNOWN is a problem, never a favourable reading", () => {
    const p = (over: Partial<WorkspaceListing>) =>
      assess(l(over), need, stay, CANCEL).problems;
    expect(p({ availableWindows: null })).toEqual(["AVAILABILITY_UNKNOWN"]);
    expect(p({ depositMinor: null })).toEqual(["EXPOSURE_UNKNOWN"]);
    expect(p({ feesMinor: null })).toEqual(["EXPOSURE_UNKNOWN"]);
    expect(p({ minTermDays: null })).toEqual(["TERM_UNKNOWN"]);
    expect(p({ cancellation: { policy: "UNKNOWN" } })).toEqual([
      "CANCELLATION_UNKNOWN",
    ]);
  });
  it("ranks qualified listings by lowest total exposure, then the rest by fewest problems, deterministically", () => {
    const a = assess(
      l({
        listingId: "a",
        rate: { basis: "DAILY", minor: 20_000, currency: "GBP" },
      }),
      need,
      stay,
      CANCEL,
    );
    const b = assess(
      l({
        listingId: "b",
        rate: { basis: "DAILY", minor: 10_000, currency: "GBP" },
      }),
      need,
      stay,
      CANCEL,
    );
    const c = assess(l({ listingId: "c", capacity: 1 }), need, stay, CANCEL);
    const d = assess(
      l({ listingId: "d", capacity: 1, availableWindows: null }),
      need,
      stay,
      CANCEL,
    );
    expect(rank([d, c, a, b]).map((x) => x.listingId)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    expect(rank([b, a, c, d]).map((x) => x.listingId)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
});
