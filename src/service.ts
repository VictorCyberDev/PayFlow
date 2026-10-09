import { randomUUID } from "node:crypto";
import { mandateFingerprint } from "./canonical.js";
import type {
  AgentPassport,
  DecisionReceipt,
  Mandate,
  TransactionProposal,
} from "./domain.js";
import type { EvidenceLedger } from "./evidence.js";
import { authorize, type AuthorizationContext } from "./kernel.js";
import type {
  AuthorizedPaymentExecutor,
  HumanApproval,
  PaymentOrder,
} from "./payment.js";

interface EvaluatedDecision {
  readonly receipt: DecisionReceipt;
  readonly mandate: Mandate;
  readonly proposal: TransactionProposal;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export class TrustKernelService {
  readonly #executedReceipts = new Set<string>();
  readonly #seenNonces = new Set<string>();
  readonly #seenProposalIds = new Set<string>();
  readonly #spent = new Map<string, number>();
  readonly #approvals = new Map<string, HumanApproval>();
  readonly #decisions = new Map<string, EvaluatedDecision>();

  constructor(
    private readonly ledger: EvidenceLedger,
    private readonly executor: AuthorizedPaymentExecutor,
  ) {}

  evaluate(
    mandate: Mandate,
    agent: AgentPassport,
    proposal: TransactionProposal,
    context: Omit<AuthorizationContext, "cumulativeSpentMinor" | "replaySeen">,
  ): DecisionReceipt {
    this.ledger.append(
      "TRANSACTION_PROPOSED",
      { proposalId: proposal.id, agentId: proposal.agentId },
      context.now,
    );

    const nonceKey = `${mandate.id}:${proposal.nonce}`;
    const proposalKey = `${mandate.id}:${proposal.id}`;
    const receipt = immutable(
      authorize(mandate, agent, proposal, {
        ...context,
        cumulativeSpentMinor: this.#spent.get(mandate.id) ?? 0,
        replaySeen:
          this.#seenNonces.has(nonceKey) ||
          this.#seenProposalIds.has(proposalKey),
      }),
    );

    this.#seenNonces.add(nonceKey);
    this.#seenProposalIds.add(proposalKey);
    this.#decisions.set(
      receipt.receiptId,
      Object.freeze({
        receipt,
        mandate: immutable(structuredClone(mandate)),
        proposal: immutable(structuredClone(proposal)),
      }),
    );

    this.ledger.append(
      "POLICY_EVALUATED",
      {
        receiptId: receipt.receiptId,
        decision: receipt.decision,
        mandateFingerprint: receipt.mandateFingerprint,
      },
      context.now,
    );
    this.ledger.append(
      receipt.decision === "ALLOW"
        ? "AUTHORIZATION_ALLOWED"
        : receipt.decision === "DENY"
          ? "AUTHORIZATION_DENIED"
          : "AUTHORIZATION_ESCALATED",
      { receiptId: receipt.receiptId, proposalId: proposal.id },
      context.now,
    );
    return receipt;
  }

  approve(
    receipt: DecisionReceipt,
    principalId: string,
    now: string,
  ): HumanApproval {
    const evaluated = this.#requireIssuedDecision(receipt);
    if (receipt.decision !== "ESCALATE") {
      throw new Error("APPROVAL_NOT_APPLICABLE");
    }
    if (principalId !== evaluated.mandate.principalId) {
      throw new Error("APPROVAL_PRINCIPAL_MISMATCH");
    }

    if (this.#approvals.has(receipt.receiptId))
      throw new Error("APPROVAL_ALREADY_RECORDED");
    const approval = Object.freeze({
      id: randomUUID(),
      receiptId: receipt.receiptId,
      proposalId: receipt.proposalId,
      principalId,
      approvedAt: now,
    });
    this.#approvals.set(receipt.receiptId, approval);
    this.ledger.append(
      "HUMAN_APPROVAL_GRANTED",
      { approvalId: approval.id, receiptId: receipt.receiptId, principalId },
      now,
    );
    return approval;
  }

  async execute(
    proposal: TransactionProposal,
    receipt: DecisionReceipt,
  ): Promise<PaymentOrder> {
    const evaluated = this.#requireIssuedDecision(receipt);
    if (JSON.stringify(proposal) !== JSON.stringify(evaluated.proposal)) {
      throw new Error("PROPOSAL_SUBSTITUTION_DETECTED");
    }

    const approval = this.#approvals.get(receipt.receiptId);
    const artifact = this.executor.artifact(receipt, approval);
    if (this.#executedReceipts.has(receipt.receiptId))
      throw new Error("EXECUTION_REPLAY_DETECTED");
    const consumed =
      (this.#spent.get(receipt.mandateId) ?? 0) + proposal.amount.minor;
    if (
      !Number.isSafeInteger(consumed) ||
      (evaluated.mandate.cumulativeLimitMinor !== undefined &&
        consumed > evaluated.mandate.cumulativeLimitMinor)
    )
      throw new Error("CUMULATIVE_LIMIT_EXCEEDED");
    this.#executedReceipts.add(receipt.receiptId);
    // Reserve before awaiting the mock provider. Errors retain the demo hold.

    this.#spent.set(receipt.mandateId, consumed);
    return this.executor.createOrder(proposal, artifact);
  }

  #requireIssuedDecision(receipt: DecisionReceipt): EvaluatedDecision {
    const evaluated = this.#decisions.get(receipt.receiptId);
    if (!evaluated || evaluated.receipt !== receipt) {
      throw new Error("UNTRUSTED_DECISION_RECEIPT");
    }
    return evaluated;
  }
}

export function issueMandateEvidence(
  ledger: EvidenceLedger,
  mandate: Mandate,
): string {
  const fp = mandateFingerprint(mandate);
  ledger.append(
    "MANDATE_CREATED",
    { mandateId: mandate.id, principalId: mandate.principalId },
    mandate.createdAt,
  );
  ledger.append(
    "MANDATE_FINGERPRINTED",
    { mandateId: mandate.id, mandateFingerprint: fp },
    mandate.createdAt,
  );
  return fp;
}
