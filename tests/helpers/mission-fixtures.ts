import { expect } from "vitest";
import type { Harness } from "./host-harness.js";

/** Shared fixtures for Mission OS integration tests (M28 onward). */
export const MISSIONS = "/v1/admin/org/missions";
let counter = 0;
export const idemKey = (prefix = "fx") =>
  `${prefix}-idem-key-${String(++counter).padStart(10, "0")}`;

export const contract = (over: Record<string, unknown> = {}) => ({
  objective: "Find and buy equipment for the studio",
  intendedOutcome: "Equipment delivered within budget",
  successCriteria: ["Three comparable quotes", "Purchase under budget"],
  currency: "USD",
  totalBudgetMinor: 150_000,
  maxCommitmentMinor: 60_000,
  spendingCategories: ["EQUIPMENT"],
  approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
  merchantRestrictions: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
  agents: [
    { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE", "DRAFT"] },
    { agentId: "b", capabilities: ["NEGOTIATE", "COMPARE"] },
    { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL", "RESERVE"] },
  ],
  approvalConditions: { humanApprovalAboveMinor: 30_000 },
  expiresAt: "2026-11-23T10:00:00.000Z",
  ...over,
});

/** An owner, three enrolled agents and an ACTIVE mission. */
export async function activeMission(h: Harness, c: unknown = contract()) {
  await h.ownerOf();
  const tokens = {
    a: await h.agentToken("a"),
    b: await h.agentToken("b"),
    c: await h.agentToken("c"),
  };
  const owner = await h.ownerOf();
  const r = await h.call(owner, "POST", MISSIONS, {
    contract: c,
    idempotencyKey: idemKey("m"),
  });
  const id = ((await r.json()) as { mission: { missionId: string } }).mission
    .missionId;
  expect(
    (await h.call(owner, "POST", `${MISSIONS}/${id}/approve`, { version: 1 }))
      .status,
  ).toBe(200);
  return { owner, id, ...tokens };
}
