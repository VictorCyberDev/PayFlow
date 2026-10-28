import { randomUUID } from "node:crypto";
import { mandateFingerprint } from "../canonical.js";
import type {
  DecisionReceipt,
  Mandate,
  TransactionProposal,
} from "../domain.js";
import type { DurableAuthorizationService } from "../durable-service.js";
import type { ExecutionGrantIssuer } from "../execution-grant.js";
import { authorize } from "../kernel.js";
import type { PostgresTrustRepository } from "../persistence.js";
import { requireAgentAccess, type ExternalAgentAccess } from "./access.js";
import {
  GATEWAY_AUDIENCE,
  GatewayActionRequestSchema,
  GatewayRequestError,
  type GatewayTrustedContext,
} from "./gateway.js";

export interface DurableGatewayResult {
  readonly requestId: string;
  readonly decision: DecisionReceipt;
  /** Present only for ALLOW: the durable Reservation that consumed Authority. */
  readonly reservationId?: string;
  /**
   * One-time, action-bound, signed Execution Grant. It is not a payment
   * credential; the Execution Boundary revalidates durable Authority before
   * any provider effect.
   */
  readonly executionGrant?: string;
}

interface PgError {
  readonly code?: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as PgError | null)?.code === "23505";
}

/**
 * External-agent Gateway backed by the durable Trust Kernel path:
 * persisted proposal -> row-locked authorization -> durable Reservation ->
 * signed one-time Execution Grant. The agent-supplied request can never
 * supply the Authority fingerprint, merchant risk, time, or lifecycle truth.
 */
export class DurableFinancialAuthorityGateway {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly service: DurableAuthorizationService,
    private readonly issuer: ExecutionGrantIssuer,
  ) {}

  async requestAction(
    rawAccess: unknown,
    rawRequest: unknown,
    trusted: GatewayTrustedContext,
  ): Promise<DurableGatewayResult> {
    const access = requireAgentAccess(
      rawAccess,
      "action:request",
      trusted.now,
      GATEWAY_AUDIENCE,
    );
    const parsed = GatewayActionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new GatewayRequestError("REQUEST_MALFORMED");
    const request = parsed.data;

    const mandate = await this.repo.getMandate(request.mandateId);
    if (!mandate) throw new GatewayRequestError("AUTHORITY_NOT_FOUND");
    const agent = await this.repo.getAgent(
      request.agentId,
      this.repo.sql,
      false,
    );
    if (!agent) throw new GatewayRequestError("AGENT_NOT_FOUND");
    this.assertBinding(access, mandate, agent.id);
    await this.assertActive(mandate.id);

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
    try {
      await this.repo.saveProposal(proposal);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Same proposal id or nonce already exists: a replay. Never reserve twice.
      return {
        requestId: proposal.id,
        decision: authorize(mandate, agent, proposal, {
          now: trusted.now,
          merchantRisk: trusted.merchantRisk,
          cumulativeSpentMinor: 0,
          replaySeen: true,
        }),
      };
    }

    let result;
    try {
      result = await this.service.authorizeProposal(
        proposal.id,
        trusted.merchantRisk,
        trusted.now,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (message === "MANDATE_REVOKED" || message === "PRINCIPAL_INACTIVE") {
        throw new GatewayRequestError("AUTHORITY_INACTIVE");
      }
      throw error;
    }
    if (result.receipt.decision !== "ALLOW" || !result.reservation) {
      return { requestId: proposal.id, decision: result.receipt };
    }
    const executionGrant = await this.issuer.issue(
      result.reservation.id,
      trusted.now,
    );
    return {
      requestId: proposal.id,
      decision: result.receipt,
      reservationId: result.reservation.id,
      executionGrant,
    };
  }

  private async assertActive(mandateId: string): Promise<void> {
    const rows = await this.repo
      .sql`select revoked_at from mandates where id=${mandateId}`;
    if (!rows[0] || rows[0].revoked_at !== null) {
      throw new GatewayRequestError("AUTHORITY_INACTIVE");
    }
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
