import { z } from "zod";
import {
  calculateMeteredAmountMinor,
  type PricingPlan,
  type UsageEvent,
} from "./metering.js";

export const InvoiceLineSchema = z
  .object({
    meter: z.enum([
      "BASE",
      "GOVERNED_ACTION",
      "VERIFY_CALL",
      "ACTIVE_AGENT",
      "ENTERPRISE_CONTROL",
    ]),
    quantity: z.number().int().safe().nonnegative(),
    unitAmountMinor: z.number().int().safe().nonnegative(),
    amountMinor: z.number().int().safe().nonnegative(),
  })
  .strict();

export const UsageInvoiceSchema = z
  .object({
    version: z.literal("usage-invoice/v1"),
    invoiceId: z.string().min(1),
    organizationId: z.string().min(1),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    planId: z.enum(["DEVELOPER", "PLATFORM", "ENTERPRISE"]),
    currency: z.literal("USD"),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    lines: z.array(InvoiceLineSchema).min(1),
    totalMinor: z.number().int().safe().nonnegative(),
    status: z.enum(["DRAFT", "FINALIZED", "VOID"]),
  })
  .strict();
export type UsageInvoice = Readonly<z.infer<typeof UsageInvoiceSchema>>;

export interface BillingProvider {
  readonly providerId: string;
  createInvoice(invoice: UsageInvoice): Promise<{
    providerInvoiceId: string;
    state: "DRAFT" | "FINALIZED";
  }>;
  voidInvoice(providerInvoiceId: string): Promise<{ state: "VOID" }>;
}

function unitAmountFor(plan: PricingPlan, meter: UsageEvent["meter"]): number {
  if (meter === "GOVERNED_ACTION") return plan.governedActionMinor;
  if (meter === "VERIFY_CALL") return plan.verificationMinor;
  if (meter === "ACTIVE_AGENT") return plan.activeAgentMinor;
  return plan.enterpriseControlMinor;
}

export function buildUsageInvoice(
  input: {
    invoiceId: string;
    organizationId: string;
    environment: "SANDBOX" | "PRODUCTION";
    periodStart: string;
    periodEnd: string;
  },
  plan: PricingPlan,
  events: readonly UsageEvent[],
): UsageInvoice {
  const relevant = events.filter(
    (event) =>
      event.organizationId === input.organizationId &&
      event.environment === input.environment &&
      Date.parse(event.occurredAt) >= Date.parse(input.periodStart) &&
      Date.parse(event.occurredAt) < Date.parse(input.periodEnd),
  );
  const aggregate = new Map<UsageEvent["meter"], number>();
  for (const event of relevant) {
    aggregate.set(event.meter, (aggregate.get(event.meter) ?? 0) + event.quantity);
  }
  const lines = [
    {
      meter: "BASE" as const,
      quantity: 1,
      unitAmountMinor: plan.monthlyBaseMinor,
      amountMinor: plan.monthlyBaseMinor,
    },
    ...[...aggregate.entries()].map(([meter, quantity]) => {
      const unitAmountMinor = unitAmountFor(plan, meter);
      return {
        meter,
        quantity,
        unitAmountMinor,
        amountMinor: unitAmountMinor * quantity,
      };
    }),
  ];
  const totalMinor = calculateMeteredAmountMinor(plan, relevant);
  return UsageInvoiceSchema.parse({
    version: "usage-invoice/v1",
    ...input,
    planId: plan.id,
    currency: plan.currency,
    lines,
    totalMinor,
    status: "DRAFT",
  });
}

/** Local-only provider for tests; it never charges or creates financial liability. */
export class InMemoryBillingProvider implements BillingProvider {
  readonly providerId = "in-memory-billing/v1";
  private readonly invoices = new Map<string, UsageInvoice>();

  async createInvoice(invoice: UsageInvoice) {
    if (invoice.environment !== "SANDBOX") {
      throw new Error("IN_MEMORY_BILLING_SANDBOX_ONLY");
    }
    this.invoices.set(invoice.invoiceId, invoice);
    return {
      providerInvoiceId: `local:${invoice.invoiceId}`,
      state: "DRAFT" as const,
    };
  }

  async voidInvoice(providerInvoiceId: string) {
    const id = providerInvoiceId.replace(/^local:/u, "");
    if (!this.invoices.has(id)) throw new Error("INVOICE_NOT_FOUND");
    this.invoices.delete(id);
    return { state: "VOID" as const };
  }
}
