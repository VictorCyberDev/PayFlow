import { randomUUID } from "node:crypto";
import { authorize } from "./kernel.js";
import {
  MerchantRiskSchema,
  type DecisionReceipt,
  type MerchantRisk,
} from "./domain.js";
import {
  PostgresTrustRepository,
  ReservationStatusSchema,
  canTransitionReservation,
  type DurableApproval,
  type Reservation,
  type ReservationStatus,
} from "./persistence.js";

export interface DurableAuthorizationResult {
  readonly receipt: DecisionReceipt;
  readonly reservation: Reservation | null;
}

/**
 * Security-critical orchestration for Milestone 2B.
 *
 * A mandate row is the serialization point for authority under that mandate.
 * Every authorization/approval that can reserve money takes FOR UPDATE on that
 * row before reading accounting state. PostgreSQL READ COMMITTED is sufficient
 * for this per-mandate invariant because contenders cannot pass the same lock
 * until the previous transaction commits or rolls back.
 */
export class DurableAuthorizationService {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly reservationTtlMs = 15 * 60_000,
  ) {}

  async authorizeProposal(
    proposalId: string,
    merchantRisk: MerchantRisk,
    now: string,
  ): Promise<DurableAuthorizationResult> {
    MerchantRiskSchema.parse(merchantRisk);
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_AUTHORIZATION_TIME");
    return this.repo.sql.begin(async (tx) => {
      const proposal = await this.repo.getProposal(proposalId, tx);
      if (!proposal) throw new Error("PROPOSAL_NOT_FOUND");
      const mandate = await this.repo.getMandate(proposal.mandateId, tx, true);
      if (!mandate) throw new Error("MANDATE_NOT_FOUND");
      const agent = await this.repo.getAgent(proposal.agentId, tx);
      if (!agent) throw new Error("AGENT_NOT_FOUND");
      const prior =
        await tx`select id from decision_receipts where proposal_id=${proposal.id}`;
      if (prior.length) throw new Error("AUTHORIZATION_ALREADY_EVALUATED");

      const accounting = await this.repo.authorityAccounting(
        mandate.id,
        mandate.cumulativeLimitMinor,
        tx,
      );
      const replayRows =
        await tx`select 1 from replay_keys where scope=${mandate.id} and replay_key in (${proposal.id},${proposal.nonce}) limit 1`;
      const receipt = authorize(mandate, agent, proposal, {
        now,
        merchantRisk,
        cumulativeSpentMinor: accounting.consumedMinor,
        replaySeen: replayRows.length > 0,
      });

      await this.repo.appendEvidenceInTransaction(
        tx,
        "POLICY_EVALUATED",
        {
          receiptId: receipt.receiptId,
          proposalId: proposal.id,
          decision: receipt.decision,
        },
        now,
      );
      await this.repo.saveReceipt(receipt, tx);

      if (receipt.decision === "DENY") {
        await this.repo.appendEvidenceInTransaction(
          tx,
          "AUTHORIZATION_DENIED",
          { receiptId: receipt.receiptId, proposalId: proposal.id },
          now,
        );
        return Object.freeze({ receipt, reservation: null });
      }
      if (receipt.decision === "ESCALATE") {
        await this.repo.appendEvidenceInTransaction(
          tx,
          "AUTHORIZATION_ESCALATED",
          { receiptId: receipt.receiptId, proposalId: proposal.id },
          now,
        );
        return Object.freeze({ receipt, reservation: null });
      }

      if (
        !(await this.repo.claimReplay(mandate.id, proposal.id, tx)) ||
        !(await this.repo.claimReplay(mandate.id, proposal.nonce, tx))
      )
        throw new Error("REPLAY_DETECTED_DURING_COMMIT");
      const reservation = this.reservation(receipt, now);
      await this.repo.createReservation(reservation, tx);
      await this.repo.appendEvidenceInTransaction(
        tx,
        "AUTHORIZATION_ALLOWED",
        { receiptId: receipt.receiptId, proposalId: proposal.id },
        now,
      );
      await this.repo.appendEvidenceInTransaction(
        tx,
        "RESERVATION_CREATED",
        {
          reservationId: reservation.id,
          proposalId: proposal.id,
          amountMinor: reservation.amountMinor,
        },
        now,
      );
      return Object.freeze({ receipt, reservation });
    });
  }

  async approveEscalation(
    receiptId: string,
    principalId: string,
    now: string,
  ): Promise<{
    readonly approval: DurableApproval;
    readonly reservation: Reservation;
  }> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_APPROVAL_TIME");
    return this.repo.sql.begin(async (tx) => {
      const receipt = await this.repo.getReceipt(receiptId, tx);
      if (!receipt || receipt.decision !== "ESCALATE")
        throw new Error("APPROVAL_NOT_APPLICABLE");
      const proposal = await this.repo.getProposal(receipt.proposalId, tx);
      if (!proposal) throw new Error("PROPOSAL_NOT_FOUND");
      const mandate = await this.repo.getMandate(receipt.mandateId, tx, true);
      if (!mandate) throw new Error("MANDATE_NOT_FOUND");
      if (mandate.principalId !== principalId)
        throw new Error("APPROVAL_PRINCIPAL_MISMATCH");
      if (await this.repo.getApprovalByReceipt(receiptId, tx))
        throw new Error("APPROVAL_ALREADY_RECORDED");
      const agent = await this.repo.getAgent(receipt.agentId, tx);
      if (!agent) throw new Error("AGENT_NOT_FOUND");
      const accounting = await this.repo.authorityAccounting(
        mandate.id,
        mandate.cumulativeLimitMinor,
        tx,
      );
      const revalidated = authorize(mandate, agent, proposal, {
        now,
        merchantRisk: mandate.merchantRiskCeiling,
        cumulativeSpentMinor: accounting.consumedMinor,
        replaySeen: false,
      });
      if (revalidated.decision !== "ESCALATE")
        throw new Error(
          `ESCALATION_REVALIDATION_FAILED:${revalidated.decision}`,
        );
      if (
        !(await this.repo.claimReplay(mandate.id, proposal.id, tx)) ||
        !(await this.repo.claimReplay(mandate.id, proposal.nonce, tx))
      )
        throw new Error("REPLAY_DETECTED_DURING_APPROVAL");

      const approval: DurableApproval = Object.freeze({
        id: randomUUID(),
        receiptId,
        proposalId: proposal.id,
        principalId,
        status: "APPROVED",
        approvedAt: now,
      });
      await this.repo.saveApproval(approval, tx);
      const reservation = this.reservation(receipt, now);
      await this.repo.createReservation(reservation, tx);
      await this.repo.appendEvidenceInTransaction(
        tx,
        "HUMAN_APPROVAL_RECORDED",
        { approvalId: approval.id, receiptId, principalId },
        now,
      );
      await this.repo.appendEvidenceInTransaction(
        tx,
        "RESERVATION_CREATED",
        {
          reservationId: reservation.id,
          proposalId: proposal.id,
          amountMinor: reservation.amountMinor,
        },
        now,
      );
      return Object.freeze({ approval, reservation });
    });
  }

  async transitionReservation(
    id: string,
    to: ReservationStatus,
    now: string,
  ): Promise<void> {
    ReservationStatusSchema.parse(to);
    await this.repo.sql.begin(async (tx) => {
      const rows =
        await tx`select id,mandate_id,status from authorization_reservations where id=${id} for update`;
      if (!rows[0]) throw new Error("RESERVATION_NOT_FOUND");
      const from = ReservationStatusSchema.parse(rows[0].status);
      if (!canTransitionReservation(from, to))
        throw new Error("INVALID_RESERVATION_TRANSITION");
      await tx`select id from mandates where id=${rows[0].mandate_id} for update`;
      await tx`update authorization_reservations set status=${to},updated_at=${now} where id=${id}`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        `RESERVATION_${to}`,
        { reservationId: id, from, to },
        now,
      );
    });
  }

  async expireStaleReservations(now: string): Promise<number> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_EXPIRY_TIME");
    return this.repo.sql.begin(async (tx) => {
      const rows =
        await tx`select id,mandate_id from authorization_reservations where status in ('PENDING','AUTHORIZED') and expires_at<=${now} order by id for update`;
      for (const item of rows) {
        await tx`select id from mandates where id=${item.mandate_id} for update`;
        await tx`update authorization_reservations set status='EXPIRED',updated_at=${now} where id=${item.id}`;
        await this.repo.appendEvidenceInTransaction(
          tx,
          "RESERVATION_EXPIRED",
          { reservationId: String(item.id) },
          now,
        );
      }
      return rows.length;
    });
  }

  private reservation(receipt: DecisionReceipt, now: string): Reservation {
    return Object.freeze({
      id: randomUUID(),
      mandateId: receipt.mandateId,
      proposalId: receipt.proposalId,
      receiptId: receipt.receiptId,
      amountMinor: receipt.amount.minor,
      currency: receipt.amount.currency,
      status: "AUTHORIZED" as const,
      expiresAt: new Date(
        Date.parse(now) + this.reservationTtlMs,
      ).toISOString(),
    });
  }
}
