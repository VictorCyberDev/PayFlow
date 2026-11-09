import { z } from "zod";

/**
 * V3 M65 — approval quorum. Pure and deterministic. A large decision can need more than one person.
 *
 * Rules that cannot be configured away: approvals count once per distinct member; the requester never counts toward their own request
 * (separation of duties); any rejection from a member of a required role blocks the decision; an approval that arrives after the request
 * expired, or from a member who has since lost the role, does not count. Whether a quorum is met is computed here, never by a model.
 */
export const ROLES = [
  "OWNER",
  "FINANCE_ADMIN",
  "SECURITY_ADMIN",
  "DEVELOPER",
  "APPROVER",
  "AUDITOR",
  "VIEWER",
] as const;
export type Role = (typeof ROLES)[number];
export const QuorumPolicySchema = z
  .object({
    tiers: z
      .array(
        z
          .object({
            /** The tier applies when the amount is at or above this, in minor units. */
            aboveMinor: z.number().int().safe().min(0),
            approvals: z.number().int().min(1).max(10),
            /** Roles whose approval counts for this tier. */
            roles: z.array(z.enum(ROLES)).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (p) => new Set(p.tiers.map((t) => t.aboveMinor)).size === p.tiers.length,
    { message: "two tiers at one threshold" },
  );
export type QuorumPolicy = z.infer<typeof QuorumPolicySchema>;

export interface Vote {
  readonly memberId: string;
  /** The member's role NOW, not when they voted. */
  readonly roleNow: Role;
  readonly decision: "APPROVE" | "REJECT";
  readonly at: string;
}
export type QuorumVerdict =
  | { state: "NOT_REQUIRED"; required: 0 }
  | { state: "MET"; required: number; counted: number }
  | { state: "WAITING"; required: number; counted: number }
  | { state: "BLOCKED"; required: number; counted: number; by: string };

/** The tier in force for an amount: the highest threshold not above it. Below every threshold nothing extra is required. */
export function tierFor(policy: QuorumPolicy, amountMinor: number) {
  const hit = [...policy.tiers]
    .sort((a, b) => b.aboveMinor - a.aboveMinor)
    .find((t) => amountMinor >= t.aboveMinor);
  return hit ?? null;
}

export function evaluateQuorum(
  policy: QuorumPolicy,
  amountMinor: number,
  requesterId: string,
  votes: readonly Vote[],
  o: { expiresAt: string },
): QuorumVerdict {
  const tier = tierFor(policy, amountMinor);
  if (!tier) return { state: "NOT_REQUIRED", required: 0 };
  const seen = new Set<string>();
  let counted = 0;
  for (const v of [...votes].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (v.memberId === requesterId) continue; // never your own request
    if (!tier.roles.includes(v.roleNow)) continue; // not (or no longer) a role that counts
    if (Date.parse(v.at) > Date.parse(o.expiresAt)) continue; // too late
    if (seen.has(v.memberId)) continue; // one voice each: the first counts
    seen.add(v.memberId);
    if (v.decision === "REJECT")
      return {
        state: "BLOCKED",
        required: tier.approvals,
        counted,
        by: v.memberId,
      };
    counted++;
  }
  return counted >= tier.approvals
    ? { state: "MET", required: tier.approvals, counted }
    : { state: "WAITING", required: tier.approvals, counted };
}
