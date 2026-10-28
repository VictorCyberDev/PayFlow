import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mandateFingerprint } from "../canonical.js";
import {
  CapabilitySchema,
  MerchantRiskSchema,
  MoneySchema,
  ProductConditionSchema,
  type AgentPassport,
  type DecisionReceipt,
  type Mandate,
  type TransactionProposal,
} from "../domain.js";
import { authorize } from "../kernel.js";
import { requireAgentAccess, type ExternalAgentAccess } from "./access.js";

export const GATEWAY_AUDIENCE = "payflow-gateway-v1";

export const GatewayActionRequestSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    mandateId: z.string().min(1),
    agentId: z.string().min(1),
    amount: MoneySchema,
    quantity: z.number().int().safe().positive().max(1000).optional(),
    merchant: z
      .object({ id: z.string().min(1), displayName: z.string().min(1) })
      .strict(),
    category: z.string().min(1),
    condition: ProductConditionSchema,
    requestedCapability: CapabilitySchema,
    proposedAt: z.string().datetime(),
    nonce: z.string().min(16),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type GatewayActionRequest = Readonly<
  z.infer<typeof GatewayActionRequestSchema>
>;

export interface GatewayTrustedContext {
  readonly now: string;
  readonly merchantRisk: z.infer<typeof MerchantRiskSchema>;
}

export interface BoundedExecutionCapability {
  readonly grantId: string;
  readonly expiresAt: string;
  readonly proposalDigest: string;
}

export interface GatewayDependencies {
  loadMandate(id: string): Promise<Mandate | null>;
  loadAgent(id: string): Promise<AgentPassport | null>;
  cumulativeSpentMinor(mandateId: string): Promise<number>;
  consumedQuantity(mandateId: string): Promise<number | undefined>;
  /** Atomic. Returns true only for the first claim of this replay key. */
  claimReplayKey(scope: string, key: string): Promise<boolean>;
  issueExecutionCapability?(
    receipt: DecisionReceipt,
    proposal: TransactionProposal,
    mandate: Mandate,
  ): Promise<BoundedExecutionCapability>;
}

export type GatewayErrorCode =
  | "REQUEST_MALFORMED"
  | "AUTHORITY_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "ACCESS_AGENT_MISMATCH"
  | "ACCESS_PRINCIPAL_MISMATCH";

export class GatewayRequestError extends Error {
  constructor(readonly code: GatewayErrorCode) {
    super(code);
    this.name = "GatewayRequestError";
  }
}

export interface GatewayActionResult {
  readonly requestId: string;
  readonly decision: DecisionReceipt;
  readonly executionCapability?: BoundedExecutionCapability;
}

export class FinancialAuthorityGateway {
  constructor(private readonly deps: GatewayDependencies) {}

  async readAuthority(
    rawAccess: unknown,
    mandateId: string,
    now: string,
  ): Promise<{
    id: string;
    principalId: string;
    authorizedAgentId: string;
    purpose: string;
    category: string;
    currency: string;
    maxSingleTransactionMinor: number;
    cumulativeLimitMinor?: number;
    expiresAt: string;
    status: "ACTIVE" | "EXPIRED";
    fingerprint: string;
  }> {
    const access = requireAgentAccess(
      rawAccess,
      "authority:read",
      now,
      GATEWAY_AUDIENCE,
    );
    const mandate = await this.deps.loadMandate(mandateId);
    if (!mandate) throw new GatewayRequestError("AUTHORITY_NOT_FOUND");
    this.assertBinding(access, mandate, mandate.authorizedAgentId);
    return {
      id: mandate.id,
      principalId: mandate.principalId,
      authorizedAgentId: mandate.authorizedAgentId,
      purpose: mandate.purpose,
      category: mandate.category,
      currency: mandate.currency,
      maxSingleTransactionMinor: mandate.maxSingleTransactionMinor,
      ...(mandate.cumulativeLimitMinor === undefined
        ? {}
        : { cumulativeLimitMinor: mandate.cumulativeLimitMinor }),
      expiresAt: mandate.expiresAt,
      status:
        Date.parse(now) < Date.parse(mandate.expiresAt) ? "ACTIVE" : "EXPIRED",
      fingerprint: mandateFingerprint(mandate),
    };
  }

  async requestAction(
    rawAccess: unknown,
    rawRequest: unknown,
    trusted: GatewayTrustedContext,
  ): Promise<GatewayActionResult> {
    const access = requireAgentAccess(
      rawAccess,
      "action:request",
      trusted.now,
      GATEWAY_AUDIENCE,
    );
    const parsed = GatewayActionRequestSchema.safeParse(rawRequest);
    if (
      !parsed.success ||
      !MerchantRiskSchema.safeParse(trusted.merchantRisk).success
    ) {
      throw new GatewayRequestError("REQUEST_MALFORMED");
    }
    const request = parsed.data;
    const [mandate, agent] = await Promise.all([
      this.deps.loadMandate(request.mandateId),
      this.deps.loadAgent(request.agentId),
    ]);
    if (!mandate) throw new GatewayRequestError("AUTHORITY_NOT_FOUND");
    if (!agent) throw new GatewayRequestError("AGENT_NOT_FOUND");
    this.assertBinding(access, mandate, agent.id);

    const replayScope = `gateway:${mandate.id}:${agent.id}`;
    const firstClaim = await this.deps.claimReplayKey(
      replayScope,
      request.nonce,
    );
    const proposal: TransactionProposal = {
      id: request.requestId ?? randomUUID(),
      agentId: agent.id,
      mandateId: mandate.id,
      mandateFingerprint: mandateFingerprint(mandate),
      amount: request.amount,
      ...(request.quantity === undefined ? {} : { quantity: request.quantity }),
      merchant: request.merchant,
      category: request.category,
      condition: request.condition,
      requestedCapability: request.requestedCapability,
      proposedAt: request.proposedAt,
      nonce: request.nonce,
      metadata: request.metadata,
    };
    const decision = authorize(mandate, agent, proposal, {
      now: trusted.now,
      merchantRisk: trusted.merchantRisk,
      cumulativeSpentMinor: await this.deps.cumulativeSpentMinor(mandate.id),
      replaySeen: !firstClaim,
      ...(mandate.quantityLimit === undefined
        ? {}
        : { consumedQuantity: await this.deps.consumedQuantity(mandate.id) }),
    });

    if (decision.decision !== "ALLOW" || !this.deps.issueExecutionCapability) {
      return { requestId: proposal.id, decision };
    }
    const executionCapability = await this.deps.issueExecutionCapability(
      decision,
      proposal,
      mandate,
    );
    return { requestId: proposal.id, decision, executionCapability };
  }

  private assertBinding(
    access: ExternalAgentAccess,
    mandate: Mandate,
    agentId: string,
  ): void {
    if (access.agentId !== agentId || mandate.authorizedAgentId !== agentId) {
      throw new GatewayRequestError("ACCESS_AGENT_MISMATCH");
    }
    if (access.principalId !== mandate.principalId) {
      throw new GatewayRequestError("ACCESS_PRINCIPAL_MISMATCH");
    }
  }
}
