import type { FinancialActionKind } from "./financial-action.js";

export interface OrganizationPolicyPack {
  readonly id: string;
  readonly label: string;
  readonly candidateActionKinds: readonly FinancialActionKind[];
  readonly requiredContext: readonly string[];
  readonly defaultEscalation: string;
}

export const ORGANIZATION_POLICY_PACKS: readonly OrganizationPolicyPack[] = [
  {
    id: "procurement",
    label: "Procurement",
    candidateActionKinds: ["PROCUREMENT_ORDER", "PURCHASE"],
    requiredContext: ["vendor", "sku", "quantity", "costCenter", "purpose"],
    defaultEscalation: "unapproved vendor, SKU, tolerance or threshold",
  },
  {
    id: "accounts-payable",
    label: "Accounts Payable",
    candidateActionKinds: ["INVOICE_SETTLEMENT"],
    requiredContext: ["payee", "invoiceReference", "amount", "currency", "costCenter"],
    defaultEscalation: "invoice mismatch, duplicate or amount boundary",
  },
  {
    id: "travel",
    label: "Travel",
    candidateActionKinds: ["PURCHASE", "REIMBURSEMENT"],
    requiredContext: ["traveler", "merchant", "purpose", "amount"],
    defaultEscalation: "merchant/category/budget boundary",
  },
  {
    id: "saas-renewals",
    label: "SaaS renewals",
    candidateActionKinds: ["SUBSCRIPTION_RENEWAL", "RECURRING_PAYMENT"],
    requiredContext: ["vendor", "recurringKey", "period", "amount"],
    defaultEscalation: "price increase or renewal outside approved period",
  },
  {
    id: "inventory",
    label: "Inventory",
    candidateActionKinds: ["PROCUREMENT_ORDER"],
    requiredContext: ["sku", "quantity", "warehouse", "vendor"],
    defaultEscalation: "quantity/vendor substitution",
  },
  {
    id: "reimbursements",
    label: "Reimbursements",
    candidateActionKinds: ["REIMBURSEMENT"],
    requiredContext: ["recipient", "expenseReference", "purpose", "amount"],
    defaultEscalation: "missing evidence or policy threshold",
  },
] as const;

/** Policy packs are templates for candidate constraints, never automatic Authority. */
export function getOrganizationPolicyPack(id: string): OrganizationPolicyPack | null {
  return ORGANIZATION_POLICY_PACKS.find((pack) => pack.id === id) ?? null;
}
