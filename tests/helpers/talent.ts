import { expect } from "vitest";
import type { Harness } from "./host-harness.js";
import { activeMission, contract, idemKey } from "./mission-fixtures.js";

/** Shared setup for M47+: a mission that approves talent work, with a talent scope (one role "fe") approved and in force. */
export const scopeDoc = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  category: "CONTRACTOR",
  currency: "USD",
  roles: [
    {
      roleId: "fe",
      title: "Frontend engineer",
      requiredSkills: ["TypeScript", "React"],
      preferredSkills: ["Accessibility"],
      engagement: "FIXED_PRICE",
      budgetCapMinor: 40_000,
      deliverables: ["Landing page", "Design system"],
    },
  ],
  requiredChecks: ["IDENTITY_VERIFIED", "PORTFOLIO_REVIEWED"],
  expiresAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
export async function talentMission(
  h: Harness,
  opts: { scope?: boolean; doc?: Record<string, unknown> } = {},
) {
  const m = await activeMission(
    h,
    contract({
      approvedProviderTypes: ["COMMERCE_MARKETPLACE", "TALENT_MARKETPLACE"],
      spendingCategories: ["EQUIPMENT", "CONTRACTOR"],
      maxCommitmentMinor: 60_000,
      totalBudgetMinor: 150_000,
    }),
  );
  let scopeId: string | null = null;
  if (opts.scope ?? true) {
    const p = await h.call(
      m.owner,
      "POST",
      `/v1/admin/org/missions/${m.id}/talent-scopes`,
      {
        document: opts.doc ?? scopeDoc(),
        idempotencyKey: idemKey("t"),
      },
    );
    scopeId = ((await p.json()) as { scope: { scopeId: string } }).scope
      .scopeId;
    const a = await h.call(
      m.owner,
      "POST",
      `/v1/admin/org/talent-scopes/${scopeId}/approve`,
      {},
    );
    expect(a.status).toBe(200);
  }
  return { ...m, scopeId };
}
