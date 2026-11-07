import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Mission Contract v1 (`payflow-mission/v1`).
 *
 * A Mission Contract is a durable, versioned PLANNING AND PERMISSION boundary. It is not an Authority: it never moves money and
 * it is not a second Trust Kernel. Later milestones compile an owner-approved contract into the existing Authority/delegation
 * representations (M29); every economic action still goes through the one Trust Kernel.
 *
 * Authoritative financial fields (budget, currency, capabilities, merchants) are only ever set from a schema-validated request
 * made by an authenticated MEMBER. Model output is never written into them: a model may only PROPOSE a revision, which is stored
 * as a proposed version that does nothing until an owner approves it.
 */
export const MISSION_SCHEMA = "payflow-mission/v1" as const;

export const CAPABILITIES = [
  "SEARCH",
  "READ",
  "COMPARE",
  "DRAFT",
  "COMMUNICATE",
  "NEGOTIATE",
  "REQUEST_APPROVAL",
  "RESERVE",
  "CONTRACT",
  "PURCHASE",
  "REFUND_REQUEST",
  "STATUS",
  "VERIFY",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities that can create an economic or contractual commitment. Everything else is research or bookkeeping. */
export const COMMITMENT_CAPABILITIES: readonly Capability[] = [
  "RESERVE",
  "CONTRACT",
  "PURCHASE",
  "REFUND_REQUEST",
];

export const PROVIDER_TYPES = [
  "COMMERCE_MARKETPLACE",
  "DIRECT_SUPPLIER",
  "TALENT_MARKETPLACE",
  "PAYMENT_PROVIDER",
  "WORKSPACE_PROVIDER",
  "PROFESSIONAL_SERVICES",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const Text = (max: number) => z.string().trim().min(1).max(max);
/** Money is an integer count of minor units. Never a float. */
const Minor = z.number().int().safe().min(1).max(1_000_000_000_000);

const AgentAssignment = z
  .object({
    agentId: Id,
    capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  })
  .strict();

export const MissionContractSchema = z
  .object({
    schema: z.literal(MISSION_SCHEMA).default(MISSION_SCHEMA),
    objective: Text(500),
    description: z.string().trim().max(4000).default(""),
    intendedOutcome: Text(1000),
    successCriteria: z.array(Text(300)).min(1).max(20),
    businessContext: z.string().trim().max(2000).default(""),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/u)
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    totalBudgetMinor: Minor,
    maxCommitmentMinor: Minor,
    spendingCategories: z.array(Id).max(50).default([]),
    approvedProviderTypes: z
      .array(z.enum(PROVIDER_TYPES))
      .max(PROVIDER_TYPES.length)
      .default([]),
    merchantRestrictions: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("NONE_ALLOWED") }).strict(),
        z
          .object({ mode: z.literal("ONLY"), ids: z.array(Id).min(1).max(200) })
          .strict(),
        z.object({ mode: z.literal("ANY") }).strict(),
      ])
      .default({ mode: "NONE_ALLOWED" }),
    agents: z.array(AgentAssignment).max(25).default([]),
    approvalConditions: z
      .object({
        /** A single commitment above this needs a human decision. Never above `maxCommitmentMinor`. */
        humanApprovalAboveMinor: Minor.optional(),
        requireApprovalToNegotiate: z.boolean().default(true),
        requireApprovalToContract: z.boolean().default(true),
      })
      .strict()
      .default({
        requireApprovalToNegotiate: true,
        requireApprovalToContract: true,
      }),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
    riskTier: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.maxCommitmentMinor > c.totalBudgetMinor)
      ctx.addIssue({
        code: "custom",
        path: ["maxCommitmentMinor"],
        message: "MAX_COMMITMENT_ABOVE_BUDGET",
      });
    if (
      c.approvalConditions.humanApprovalAboveMinor !== undefined &&
      c.approvalConditions.humanApprovalAboveMinor > c.maxCommitmentMinor
    )
      ctx.addIssue({
        code: "custom",
        path: ["approvalConditions", "humanApprovalAboveMinor"],
        message: "THRESHOLD_ABOVE_MAX_COMMITMENT",
      });
    const seen = new Set<string>();
    for (const [i, a] of c.agents.entries()) {
      if (seen.has(a.agentId))
        ctx.addIssue({
          code: "custom",
          path: ["agents", i, "agentId"],
          message: "DUPLICATE_AGENT",
        });
      seen.add(a.agentId);
    }
  });
export type MissionContract = z.infer<typeof MissionContractSchema>;

/** Capabilities canonicalised (deduplicated, sorted) so equal contracts have equal digests. */
export function normalize(contract: MissionContract): MissionContract {
  return {
    ...contract,
    successCriteria: [...contract.successCriteria],
    spendingCategories: [...new Set(contract.spendingCategories)].sort(),
    approvedProviderTypes: [...new Set(contract.approvedProviderTypes)].sort(),
    merchantRestrictions:
      contract.merchantRestrictions.mode === "ONLY"
        ? {
            mode: "ONLY",
            ids: [...new Set(contract.merchantRestrictions.ids)].sort(),
          }
        : contract.merchantRestrictions,
    agents: contract.agents
      .map((a) => ({
        agentId: a.agentId,
        capabilities: [...new Set(a.capabilities)].sort() as Capability[],
      }))
      .sort((a, b) => (a.agentId < b.agentId ? -1 : 1)),
  };
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
export const contractDigest = (c: MissionContract): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(normalize(c))))
    .digest("hex");

/**
 * Does `next` grant ANYTHING that `prev` did not? This is the single rule deciding whether a revision needs a fresh owner
 * approval. It errs on the side of "widening": anything it cannot show to be no wider counts as wider.
 * Returns the list of reasons (empty = narrowing or equal).
 */
export function wideningReasons(
  prev: MissionContract,
  next: MissionContract,
): string[] {
  const a = normalize(prev);
  const b = normalize(next);
  const out: string[] = [];
  if (a.currency !== b.currency) out.push("CURRENCY_CHANGED");
  if (b.totalBudgetMinor > a.totalBudgetMinor) out.push("BUDGET_INCREASED");
  if (b.maxCommitmentMinor > a.maxCommitmentMinor)
    out.push("MAX_COMMITMENT_INCREASED");
  if (Date.parse(b.expiresAt) > Date.parse(a.expiresAt))
    out.push("EXPIRY_EXTENDED");
  for (const cat of b.spendingCategories)
    if (!a.spendingCategories.includes(cat)) out.push(`CATEGORY_ADDED:${cat}`);
  if (a.spendingCategories.length > 0 && b.spendingCategories.length === 0)
    out.push("CATEGORY_RESTRICTION_REMOVED");
  for (const t of b.approvedProviderTypes)
    if (!a.approvedProviderTypes.includes(t))
      out.push(`PROVIDER_TYPE_ADDED:${t}`);
  const ma = a.merchantRestrictions;
  const mb = b.merchantRestrictions;
  if (ma.mode === "NONE_ALLOWED" && mb.mode !== "NONE_ALLOWED")
    out.push("MERCHANTS_ENABLED");
  else if (ma.mode === "ONLY" && mb.mode === "ANY")
    out.push("MERCHANTS_UNRESTRICTED");
  else if (ma.mode === "ONLY" && mb.mode === "ONLY")
    for (const id of mb.ids)
      if (!ma.ids.includes(id)) out.push(`MERCHANT_ADDED:${id}`);
  const prevCaps = new Map(
    a.agents.map((x) => [x.agentId, new Set<string>(x.capabilities)]),
  );
  for (const ag of b.agents) {
    const before = prevCaps.get(ag.agentId);
    if (!before) out.push(`AGENT_ADDED:${ag.agentId}`);
    for (const cap of ag.capabilities)
      if (!before?.has(cap)) out.push(`CAPABILITY_ADDED:${ag.agentId}:${cap}`);
  }
  const ca = a.approvalConditions;
  const cb = b.approvalConditions;
  // Approval conditions are guardrails: relaxing any of them is a widening.
  if (ca.requireApprovalToNegotiate && !cb.requireApprovalToNegotiate)
    out.push("NEGOTIATION_APPROVAL_RELAXED");
  if (ca.requireApprovalToContract && !cb.requireApprovalToContract)
    out.push("CONTRACT_APPROVAL_RELAXED");
  const ta = ca.humanApprovalAboveMinor ?? a.maxCommitmentMinor;
  const tb = cb.humanApprovalAboveMinor ?? b.maxCommitmentMinor;
  if (tb > ta) out.push("HUMAN_APPROVAL_THRESHOLD_RAISED");
  if (rank(b.riskTier) > rank(a.riskTier)) out.push("RISK_TIER_RAISED");
  return out;
}
const rank = (r: "LOW" | "MEDIUM" | "HIGH") =>
  ({ LOW: 0, MEDIUM: 1, HIGH: 2 })[r];
