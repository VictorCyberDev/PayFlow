import { describe, expect, it } from "vitest";
import {
  ServiceNeedSchema,
  assessPackage,
  parsePackages,
  rankPackages,
  type ServicePackage,
} from "../src/missions/service-market.js";
import { sandboxServiceSource } from "../src/missions/service-market-sources.js";

const need = ServiceNeedSchema.parse({
  category: "DESIGN",
  currency: "GBP",
  maxPriceMinor: 100_000,
  maxDeliveryDays: 14,
  minRevisions: 1,
  minRefundBeforeStartBps: 5_000,
});
const fixture = async () =>
  parsePackages(
    await sandboxServiceSource.search(
      { category: "DESIGN" },
      new AbortController().signal,
    ),
  ).packages;

describe("M54 service packages (pure)", () => {
  it("only a package whose every term is stated and within the need qualifies; unknown is never favourable", async () => {
    const ps = await fixture();
    const a = ps.map((p) => assessPackage(p, need));
    const by = Object.fromEntries(a.map((x) => [x.packageId, x]));
    expect(by["sbx-logo-basic"]!.qualified).toBe(true);
    expect(by["sbx-logo-premium"]!.problems).toEqual(
      expect.arrayContaining(["ABOVE_PRICE_LIMIT", "TOO_SLOW"]),
    );
    expect(by["sbx-logo-quick"]!.problems).toEqual(
      expect.arrayContaining(["TOO_FEW_REVISIONS", "REFUND_TOO_SMALL"]),
    );
    const vague = by["sbx-logo-vague"]!;
    expect(vague.qualified).toBe(false);
    expect(vague.problems).toEqual(
      expect.arrayContaining([
        "PRICE_UNKNOWN",
        "DELIVERY_UNKNOWN",
        "REVISIONS_UNKNOWN",
        "REFUND_TERMS_UNKNOWN",
      ]),
    );
    expect(vague.priceMinor).toBeNull();
    expect(vague.lostIfCancelledBeforeStartMinor).toBeNull();
  });
  it("cancelling before work starts loses the unrefunded share, in whole minor units", () => {
    const p: ServicePackage = {
      packageId: "x",
      category: "DESIGN",
      providerName: "P",
      title: "T",
      deliverables: ["D"],
      priceMinor: 10_001,
      currency: "GBP",
      deliveryDays: 1,
      revisionsIncluded: 0,
      refundBeforeStartBps: 3_333,
      provenance: {
        sourceId: "s",
        observedAt: "2026-11-01T00:00:00.000Z",
        evidence: "DOCUMENT_REF",
      },
    };
    const a = assessPackage(p, {
      ...need,
      minRevisions: 0,
      minRefundBeforeStartBps: 0,
    });
    expect(a.lostIfCancelledBeforeStartMinor).toBe(10_001 - 3_333);
    expect(Number.isInteger(a.lostIfCancelledBeforeStartMinor)).toBe(true);
  });
  it("ranking puts qualified first, cheapest first, and an unknown price never sorts as cheap", async () => {
    const ps = await fixture();
    const loose = ServiceNeedSchema.parse({
      category: "DESIGN",
      currency: "GBP",
      maxPriceMinor: 1_000_000,
      maxDeliveryDays: 60,
    });
    const r = rankPackages(ps.map((p) => assessPackage(p, loose)));
    expect(r.map((x) => x.packageId)).toEqual([
      "sbx-logo-quick",
      "sbx-logo-basic",
      "sbx-logo-premium",
      "sbx-logo-vague",
    ]);
    expect(r.at(-1)!.qualified).toBe(false);
  });
  it("an untrusted source cannot smuggle records in: bad, duplicate, oversize and non-array output is dropped and counted", async () => {
    const good = (await fixture())[0]!;
    expect(
      parsePackages([good, good, { packageId: "x" }, "no", null]),
    ).toMatchObject({ rejected: 4, packages: [good] });
    expect(parsePackages({ not: "an array" }).packages).toEqual([]);
    expect(parsePackages([{ ...good, priceMinor: 1.5 }]).packages).toEqual([]);
    expect(parsePackages([{ ...good, extra: "field" }]).packages).toEqual([]);
    expect(
      parsePackages(Array(10).fill(good), { maxRecords: 5, maxBytes: 10 }),
    ).toMatchObject({ packages: [], truncated: true });
  });
});
