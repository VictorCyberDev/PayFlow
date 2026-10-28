import { z } from "zod";
import {
  FinancialActionSchema,
  type FinancialAction,
} from "./financial-action.js";

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

const FixtureInvoiceSchema = z
  .object({
    invoiceId: z.string().min(1).max(256),
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    supplierId: z.string().min(1),
    amountMinor: z.number().int().safe().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    costCenter: z.string().min(1).max(128),
    purpose: z.string().min(1).max(1024),
    proposedAt: z.string().datetime(),
  })
  .strict();

export class FixtureAccountsPayableConnector implements EnterpriseConnector {
  readonly connectorId = "fixture-ap/v1";
  readonly published: Array<{ context: EnterpriseConnectorContext; outcome: unknown }> = [];

  async normalizeInbound(raw: unknown, context: EnterpriseConnectorContext): Promise<FinancialAction> {
    const invoice = FixtureInvoiceSchema.parse(raw);
    return FinancialActionSchema.parse({
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
    });
  }

  async publishOutcome(
    context: EnterpriseConnectorContext,
    outcome: { actionId: string; state: "SUCCEEDED" | "FAILED" | "UNKNOWN"; proofUrl?: string },
  ): Promise<void> {
    this.published.push({ context, outcome });
  }
}
