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
  opts: {
    scope?: boolean;
    doc?: Record<string, unknown>;
    category?: string;
  } = {},
) {
  const m = await activeMission(
    h,
    contract({
      approvedProviderTypes: ["COMMERCE_MARKETPLACE", "TALENT_MARKETPLACE"],
      spendingCategories: ["EQUIPMENT", opts.category ?? "CONTRACTOR"],
      maxCommitmentMinor: 60_000,
      totalBudgetMinor: 150_000,
      agents: [
        { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE", "DRAFT"] },
        { agentId: "b", capabilities: ["NEGOTIATE", "COMPARE", "PURCHASE"] },
        {
          agentId: "c",
          capabilities: ["PURCHASE", "REQUEST_APPROVAL", "RESERVE"],
        },
      ],
    }),
  );
  let scopeId: string | null = null;
  if (opts.scope ?? true) {
    const p = await h.call(
      m.owner,
      "POST",
      `/v1/admin/org/missions/${m.id}/talent-scopes`,
      {
        document:
          opts.doc ?? scopeDoc({ category: opts.category ?? "CONTRACTOR" }),
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

/** M50 setup: a talent mission with a shortlisted candidate, checks passed, and an offer sent and ACCEPTED, so a contract with two committed milestones exists. */
export async function contractScene(
  h: Harness,
  milestones = [
    { title: "Landing page", amountMinor: 8_400, dueDate: "2026-11-02" },
    { title: "Design system", amountMinor: 12_000, dueDate: "2026-11-13" },
  ],
) {
  const post = (t: string, p: string, b: unknown = {}) =>
    h.call(t, "POST", p, b);
  // The sandbox payment rail pays catalog items whose category is the Authority's, so the demo contract uses that category.
  const s = await talentMission(h, { category: "KEYBOARD" });
  const imp = (await (
    await post(
      s.owner,
      `/v1/admin/org/missions/${s.id}/talent-candidates/import`,
      {
        sourceId: "payflow-sandbox-talent",
        roleId: "fe",
        idempotencyKey: idemKey("i"),
      },
    )
  ).json()) as { imported: { handle: string; candidateId: string }[] };
  const ada = imp.imported.find((c) => c.handle === "sandbox-ada")!.candidateId;
  expect(
    (
      await post(s.owner, `/v1/admin/org/missions/${s.id}/talent-shortlists`, {
        roleId: "fe",
        candidateIds: [ada],
        idempotencyKey: idemKey("s"),
      })
    ).status,
  ).toBe(201);
  for (const kind of ["IDENTITY_VERIFIED", "PORTFOLIO_REVIEWED"])
    await post(s.owner, `/v1/admin/org/missions/${s.id}/talent-checks`, {
      candidateId: ada,
      kind,
      result: "PASSED",
      evidenceKind: "DOCUMENT_REF",
      evidenceRef: `${kind}.pdf`,
      idempotencyKey: idemKey("c"),
    });
  const drafted = await post(
    s.owner,
    `/v1/admin/org/missions/${s.id}/talent-offers`,
    {
      candidateId: ada,
      terms: {
        currency: "USD",
        startDate: "2026-10-26",
        endDate: "2026-11-13",
        milestones,
        expiresAt: "2026-11-05T10:00:00.000Z",
      },
      idempotencyKey: idemKey("o"),
    },
  );
  const offer = ((await drafted.json()) as { offer: { offerId: string } })
    .offer;
  await post(s.owner, `/v1/admin/org/talent-offers/${offer.offerId}/approve`);
  await post(s.owner, `/v1/admin/org/talent-offers/${offer.offerId}/sent`, {
    note: "emailed",
  });
  const ans = await post(
    s.owner,
    `/v1/admin/org/talent-offers/${offer.offerId}/answer`,
    {
      outcome: "ACCEPTED",
      evidenceKind: "DOCUMENT_REF",
      evidenceRef: "signed.pdf",
    },
  );
  const contractId = ((await ans.json()) as { contractId: string }).contractId;
  expect(contractId).toMatch(/^tct_/u);
  return { ...s, ada, offerId: offer.offerId, contractId };
}
