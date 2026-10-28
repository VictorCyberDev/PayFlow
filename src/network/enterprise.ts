import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DelegatedFinancialScopeSchema,
  validateDelegationAttenuation,
  type DelegatedFinancialScope,
} from "../protocols/a2a.js";

export type DelegationState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface DelegationEdge {
  readonly id: string;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  readonly scope: DelegatedFinancialScope;
  readonly state: DelegationState;
  readonly parentEdgeId?: string;
}

export class EnterpriseDelegationGraph {
  private readonly edges = new Map<string, DelegationEdge>();

  addRoot(edge: DelegationEdge): void {
    if (edge.parentEdgeId !== undefined)
      throw new Error("ROOT_HAS_PARENT_EDGE");
    if (this.edges.has(edge.id)) throw new Error("DUPLICATE_DELEGATION");
    this.edges.set(edge.id, edge);
  }

  addChild(parentEdgeId: string, edge: DelegationEdge): void {
    const parent = this.edges.get(parentEdgeId);
    if (!parent || parent.state !== "ACTIVE")
      throw new Error("PARENT_DELEGATION_INACTIVE");
    if (edge.parentEdgeId !== parentEdgeId)
      throw new Error("PARENT_EDGE_MISMATCH");
    if (this.edges.has(edge.id)) throw new Error("DUPLICATE_DELEGATION");
    const violations = validateDelegationAttenuation(parent.scope, edge.scope);
    if (violations.length > 0)
      throw new Error(`DELEGATION_WIDENING:${violations.join(",")}`);
    if (
      this.pathToRoot(parentEdgeId).some(
        (ancestor) => ancestor.childAgentId === edge.childAgentId,
      )
    ) {
      throw new Error("DELEGATION_CYCLE");
    }
    this.edges.set(edge.id, edge);
  }

  revoke(edgeId: string): void {
    const target = this.edges.get(edgeId);
    if (!target) throw new Error("DELEGATION_NOT_FOUND");
    this.edges.set(edgeId, { ...target, state: "REVOKED" });
    for (const [id, edge] of this.edges) {
      if (edge.parentEdgeId === edgeId && edge.state === "ACTIVE")
        this.revoke(id);
    }
  }

  pathToRoot(edgeId: string): readonly DelegationEdge[] {
    const path: DelegationEdge[] = [];
    let current = this.edges.get(edgeId);
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new Error("DELEGATION_CYCLE");
      seen.add(current.id);
      path.push(current);
      current = current.parentEdgeId
        ? this.edges.get(current.parentEdgeId)
        : undefined;
    }
    return path;
  }
}

export const ApprovalPolicySchema = z
  .object({
    id: z.string().min(1),
    requiredRoles: z
      .array(z.enum(["FINANCE_OWNER", "SECURITY_OWNER", "ORG_OWNER"]))
      .min(1),
    minimumApprovals: z.number().int().safe().positive(),
    forbidSelfApproval: z.boolean(),
    thresholdMinor: z.number().int().safe().nonnegative(),
  })
  .strict();
export type ApprovalPolicy = Readonly<z.infer<typeof ApprovalPolicySchema>>;

export interface ApprovalEvidence {
  readonly principalId: string;
  readonly role: "FINANCE_OWNER" | "SECURITY_OWNER" | "ORG_OWNER";
  readonly actionDigest: string;
  readonly approvedAt: string;
  readonly authenticationEvidence: string;
}

export function evaluateApprovalEvidence(
  policy: ApprovalPolicy,
  request: {
    requesterPrincipalId: string;
    actionDigest: string;
    amountMinor: number;
  },
  approvals: readonly ApprovalEvidence[],
): { approved: boolean; reasons: readonly string[] } {
  if (request.amountMinor < policy.thresholdMinor)
    return { approved: true, reasons: [] };
  const reasons: string[] = [];
  const valid = approvals.filter((approval) => {
    if (approval.actionDigest !== request.actionDigest) return false;
    if (!policy.requiredRoles.includes(approval.role)) return false;
    if (
      policy.forbidSelfApproval &&
      approval.principalId === request.requesterPrincipalId
    )
      return false;
    return approval.authenticationEvidence.length >= 16;
  });
  if (
    new Set(valid.map((approval) => approval.principalId)).size <
    policy.minimumApprovals
  ) {
    reasons.push("INSUFFICIENT_DISTINCT_APPROVALS");
  }
  for (const role of policy.requiredRoles) {
    if (!valid.some((approval) => approval.role === role))
      reasons.push(`MISSING_ROLE:${role}`);
  }
  return { approved: reasons.length === 0, reasons };
}

export type AgentLifecycle =
  "REGISTERED" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "RETIRED";

const transitions: Readonly<Record<AgentLifecycle, readonly AgentLifecycle[]>> =
  {
    REGISTERED: ["ACTIVE", "REVOKED"],
    ACTIVE: ["SUSPENDED", "REVOKED", "RETIRED"],
    SUSPENDED: ["ACTIVE", "REVOKED", "RETIRED"],
    REVOKED: [],
    RETIRED: [],
  };

export function transitionAgentLifecycle(
  from: AgentLifecycle,
  to: AgentLifecycle,
): AgentLifecycle {
  if (!transitions[from].includes(to))
    throw new Error(`INVALID_AGENT_LIFECYCLE_TRANSITION:${from}:${to}`);
  return to;
}

export function approvalActionDigest(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export { DelegatedFinancialScopeSchema };
