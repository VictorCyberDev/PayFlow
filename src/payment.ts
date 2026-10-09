import { randomUUID } from "node:crypto";
import type { DecisionReceipt, Money, TransactionProposal } from "./domain.js";
import type { EvidenceLedger } from "./evidence.js";

const AUTHORIZED = Symbol("PayFlowAuthorizedPayment");
export interface AuthorizationArtifact {
  readonly [AUTHORIZED]: true;
  readonly receipt: DecisionReceipt;
  readonly approvedByHuman: boolean;
}
export interface HumanApproval {
  readonly id: string;
  readonly receiptId: string;
  readonly proposalId: string;
  readonly principalId: string;
  readonly approvedAt: string;
}
export interface PaymentOrder {
  readonly id: string;
  readonly amount: Money;
  readonly status: "CREATED" | "CAPTURED";
}
export interface PaymentProvider {
  createOrder(
    proposal: TransactionProposal,
    authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder>;
  captureOrder(
    orderId: string,
    authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder>;
}

export class MockPaymentProvider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  async createOrder(
    proposal: TransactionProposal,
    _authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder> {
    this.createCalls++;
    return Promise.resolve({
      id: `mock-${randomUUID()}`,
      amount: proposal.amount,
      status: "CREATED",
    });
  }
  async captureOrder(
    orderId: string,
    _authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder> {
    this.captureCalls++;
    return Promise.resolve({
      id: orderId,
      amount: { currency: "USD", minor: 0 },
      status: "CAPTURED",
    });
  }
}

export class PayPalPaymentProvider implements PaymentProvider {
  async createOrder(
    _proposal: TransactionProposal,
    _authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder> {
    throw new Error(
      "PayPal network execution intentionally deferred beyond Milestone 1",
    );
  }
  async captureOrder(
    _orderId: string,
    _authorization: AuthorizationArtifact,
  ): Promise<PaymentOrder> {
    throw new Error(
      "PayPal network execution intentionally deferred beyond Milestone 1",
    );
  }
}

export class AuthorizedPaymentExecutor {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly ledger: EvidenceLedger,
  ) {}
  artifact(
    receipt: DecisionReceipt,
    approval?: HumanApproval,
  ): AuthorizationArtifact {
    if (receipt.decision === "DENY") throw new Error("PAYMENT_NOT_AUTHORIZED");
    if (
      receipt.decision === "ESCALATE" &&
      (!approval ||
        approval.receiptId !== receipt.receiptId ||
        approval.proposalId !== receipt.proposalId)
    )
      throw new Error("HUMAN_APPROVAL_REQUIRED");
    return Object.freeze({
      [AUTHORIZED]: true as const,
      receipt,
      approvedByHuman: receipt.decision === "ESCALATE",
    });
  }
  async createOrder(
    proposal: TransactionProposal,
    artifact: AuthorizationArtifact,
  ): Promise<PaymentOrder> {
    if (
      artifact[AUTHORIZED] !== true ||
      artifact.receipt.proposalId !== proposal.id
    )
      throw new Error("INVALID_AUTHORIZATION_ARTIFACT");
    const order = await this.provider.createOrder(proposal, artifact);
    this.ledger.append(
      "PAYMENT_ORDER_CREATED",
      { proposalId: proposal.id, orderId: order.id },
      new Date().toISOString(),
    );
    return order;
  }
}
