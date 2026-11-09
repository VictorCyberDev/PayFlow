/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { activeMission, contract } from "./helpers/mission-fixtures.js";

/** V3 M54 — service-package search through the real Gateway on PostgreSQL. FICTIONAL sandbox source only; nothing is bought. */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M54 service marketplace (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const scene = (over: Record<string, unknown> = {}) =>
      activeMission(
        h,
        contract({
          currency: "GBP",
          approvedProviderTypes: ["PROFESSIONAL_SERVICES"],
          maxCommitmentMinor: 200_000,
          totalBudgetMinor: 500_000,
          ...over,
        }),
      );
    const need = (over: Record<string, unknown> = {}) => ({
      category: "DESIGN",
      currency: "GBP",
      maxPriceMinor: 100_000,
      maxDeliveryDays: 14,
      minRevisions: 1,
      minRefundBeforeStartBps: 5_000,
      ...over,
    });
    const search = (
      t: string,
      id: string,
      n: unknown = need(),
      base = "/v1/admin/org",
      sourceId = "sandbox-services",
    ) =>
      post(t, `${base}/missions/${id}/services/search`, { sourceId, need: n });
    const code = async (r: Response) => [r.status, (await body(r)).reason];

    it("returns ranked, honestly assessed packages, labelled as fictional, and stores and spends nothing", async () => {
      const s = await scene();
      const r = await search(s.owner, s.id);
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      const v = await body(r);
      expect(v.sourceKind).toBe("SANDBOX_FIXTURE");
      expect(v.notice).toContain("not quotes, engagements or purchases");
      expect(v.results[0].package.packageId).toBe("sbx-logo-basic");
      expect(v.results[0].assessment.qualified).toBe(true);
      const vague = v.results.find(
        (x: any) => x.package.packageId === "sbx-logo-vague",
      );
      expect(vague.assessment.priceMinor).toBeNull();
      expect(vague.assessment.qualified).toBe(false);
      const n = await h.repo
        .sql`select count(*)::int n from mission_ledger_items`;
      expect(n[0]!.n).toBe(0);
    });

    it("refuses what the mission does not allow", async () => {
      const s = await scene();
      expect(
        await code(await search(s.owner, s.id, need({ currency: "USD" }))),
      ).toEqual([422, "CURRENCY_MISMATCH"]);
      expect(
        await code(
          await search(s.owner, s.id, need({ maxPriceMinor: 200_001 })),
        ),
      ).toEqual([422, "PRICE_ABOVE_COMMITMENT"]);
      expect(
        await code(await search(s.owner, s.id, need(), undefined, "nope")),
      ).toEqual([404, "UNKNOWN_SOURCE"]);
      expect(
        (await search(s.owner, s.id, { ...need(), extra: 1 })).status,
      ).toBe(400);
      const no = await scene({ approvedProviderTypes: ["DIRECT_SUPPLIER"] });
      expect(await code(await search(no.owner, no.id))).toEqual([
        403,
        "PROVIDER_TYPE_NOT_APPROVED",
      ]);
      const stranger = await h.ownerOf("org-other");
      expect((await search(stranger, s.id)).status).toBe(404);
    });

    it("a research agent may search; an agent without SEARCH may not; an unauthenticated agent is refused", async () => {
      const s = await scene();
      expect((await search(s.a, s.id, need(), "/v1/agent")).status).toBe(200);
      expect(await code(await search(s.b, s.id, need(), "/v1/agent"))).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      expect(
        (await search("pf_act_nonsense", s.id, need(), "/v1/agent")).status,
      ).toBe(401);
    });
  },
);
