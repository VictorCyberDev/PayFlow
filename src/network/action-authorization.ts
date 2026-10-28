import { z } from "zod";
import { mandateFingerprint } from "../canonical.js";
import type { AgentPassport, Capability, Mandate, TransactionProposal } from "../domain.js";
import { authorize, type AuthorizationContext } from "../kernel.js";
import {
  FinancialActionKindSchema,
  MonetaryBoundarySchema,
  evaluateMonetaryBoundary,
  type FinancialAction,
} from "./financial-action.js";

export const FinancialActionAuthorityExtensionSchema = z
  .object({
    version: z.literal("financial-action-authority/v1"),
    allowedKinds: z.array(FinancialActionKindSchema).min(1),
    allowedCounterpartyIds: z.array(z.string().min(1)).min(1),
    monetary: MonetaryBoundarySchema,
    requireInvoiceReferenceForSettlement: z.boolean(),
    requireRecurringKeyForRecurring: z.boolean(),
  })
  .strict();
export type FinancialActionAuthorityExtension = Readonly<
  z.infer<typeof FinancialActionAuthorityExtensionSchema>
>;

export type FinancialActionViolation =
  | "ACTION_KIND_DENIED"
  | "COUNTERPARTY_DENIED"
  | "INVOICE_REFERENCE_REQUIRED"
  | "RECURRING_KEY_REQUIRED"
  | "QUANTITY_NOT_REPRESENTABLE_IN_KERNEL"
  | `MONEY:${string}`;

function capabilityFor(kind: FinancialAction["kind"]): Capability {
  switch (kind) {
    case "SUBSCRIPTION_RENEWAL":
    case "RECURRING_PAYMENT":
      return "CREATE_SUBSCRIPTION";
    case "PURCHASE":
    case "INVOICE_SETTLEMENT":
    case "PAYOUT":
    case "REIMBURSEMENT":
    case "PROCUREMENT_ORDER":
    case "MARKETPLACE_DISBURSEMENT":
    case "MACHINE_RESOURCE_PURCHASE":
      return "CAPTURE_PAYMENT";
  }
}

export function authorizeFinancialAction(
  mandate: Mandate,
  extension: FinancialActionAuthorityExtension,
  agent: AgentPassport,
  action: FinancialAction,
  context: AuthorizationContext,
): {
  readonly decision: "ALLOW" | "DENY" | "ESCALATE";
  readonly extensionViolations: readonly FinancialActionViolation[];
  readonly kernelReceipt: ReturnType<typeof authorize>;
  readonly proposal: TransactionProposal;
} {
  const violations: FinancialActionViolation[] = [];
  if (!extension.allowedKinds.includes(action.kind)) violations.push("ACTION_KIND_DENIED");
  if (!extension.allowedCounterpartyIds.includes(action.counterparty.id)) {
    violations.push("COUNTERPARTY_DENIED");
  }
  if (
    action.kind === "INVOICE_SETTLEMENT" &&
    extension.requireInvoiceReferenceForSettlement &&
    !action.invoiceReference
  ) {
    violations.push("INVOICE_REFERENCE_REQUIRED");
  }
  if (
    (action.kind === "SUBSCRIPTION_RENEWAL" || action.kind === "RECURRING_PAYMENT") &&
    extension.requireRecurringKeyForRecurring &&
    !action.recurringKey
  ) {
    violations.push("RECURRING_KEY_REQUIRED");
  }
  if (action.quantity !== undefined && action.quantity > 1000) {
    // Legacy TransactionProposal is deliberately capped at 1000. Never clamp a
    // broader action into a narrower representation and accidentally authorize it.
    violations.push("QUANTITY_NOT_REPRESENTABLE_IN_KERNEL");
  }
  for (const moneyViolation of evaluateMonetaryBoundary(action, extension.monetary)) {
    violations.push(`MONEY:${moneyViolation}`);
  }

  const proposal: TransactionProposal = {
    id: action.id,
    agentId: action.agentId,
    mandateId: mandate.id,
    mandateFingerprint: mandateFingerprint(mandate),
    amount: action.amount,
    ...(action.quantity === undefined || action.quantity > 1000
      ? {}
      : { quantity: action.quantity }),
    merchant: {
      id: action.counterparty.id,
      displayName: action.counterparty.displayName ?? action.counterparty.id,
    },
    category: mandate.category,
    condition: mandate.allowedConditions[0] ?? "NEW",
    requestedCapability: capabilityFor(action.kind),
    proposedAt: action.proposedAt,
    nonce: action.idempotencyKey,
    metadata: { ...action.metadata, financialActionKind: action.kind },
  };
  const kernelReceipt = authorize(mandate, agent, proposal, context);
  const decision = violations.length > 0 ? "DENY" : kernelReceipt.decision;
  return { decision, extensionViolations: violations, kernelReceipt, proposal };
}
