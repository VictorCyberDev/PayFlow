import type { FinancialAction } from "./financial-action.js";

export interface EnterpriseConnectorContext {
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly sourceSystem: string;
  readonly sourceReference: string;
}

export interface EnterpriseConnector {
  readonly connectorId: string;
  normalizeInbound(raw: unknown, context: EnterpriseConnectorContext): Promise<FinancialAction>;
  publishOutcome(
    context: EnterpriseConnectorContext,
    outcome: { actionId: string; state: "SUCCEEDED" | "FAILED" | "UNKNOWN"; proofUrl?: string },
  ): Promise<void>;
}

export class FixtureAccountsPayableConnector implements EnterpriseConnector {
  readonly connectorId = "fixture-ap/v1";
  readonly published: Array<{ context: EnterpriseConnectorContext; outcome: unknown }> = [];

  async normalizeInbound(raw: unknown, context: EnterpriseConnectorContext): Promise<FinancialAction> {
    const invoice = raw as {
      invoiceId: string;
      principalId: string;
      agentId: string;
      supplierId: string;
      amountMinor: number;
      currency: string;
      costCenter: string;
      purpose: string;
      proposedAt: string;
    };
    return {
      version: "financial-action/v1",
      id: `ap:${context.sourceReference}:${invoice.invoiceId}`,
      kind: "INVOICE_SETTLEMENT",
      principalId: invoice.principalId,
      agentId: invoice.agentId,
      counterparty: { id: invoice.supplierId },
      amount: { currency: invoice.currency, minor: invoice.amountMinor },
      fees: [],
      taxes: [],
      items: [],
      purpose: invoice.purpose,
      costCenter: invoice.costCenter,
      invoiceReference: invoice.invoiceId,
      proposedAt: invoice.proposedAt,
      idempotencyKey: `ap-idempotency:${context.sourceSystem}:${invoice.invoiceId}`,
      metadata: { sourceSystem: context.sourceSystem },
    };
  }

  async publishOutcome(
    context: EnterpriseConnectorContext,
    outcome: { actionId: string; state: "SUCCEEDED" | "FAILED" | "UNKNOWN"; proofUrl?: string },
  ): Promise<void> {
    this.published.push({ context, outcome });
  }
}
