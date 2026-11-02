import type { FinancialActionKind } from "./financial-action.js";

export interface EmbeddedAuthorityProfile {
  readonly id: string;
  readonly audience: "CONSUMER" | "ENTERPRISE";
  readonly actionKinds: readonly FinancialActionKind[];
  readonly requiredBounds: readonly string[];
  readonly safeDefault: string;
}

export const CONSUMER_AUTHORITY_PROFILES: readonly EmbeddedAuthorityProfile[] =
  [
    {
      id: "travel",
      audience: "CONSUMER",
      actionKinds: ["PURCHASE"],
      requiredBounds: [
        "merchant/category",
        "budget",
        "currency",
        "trip window",
        "expiry",
      ],
      safeDefault: "Escalate itinerary or price substitution",
    },
    {
      id: "groceries",
      audience: "CONSUMER",
      actionKinds: ["PURCHASE"],
      requiredBounds: [
        "merchant",
        "basket/quantity",
        "budget",
        "currency",
        "expiry",
      ],
      safeDefault: "Deny item or merchant substitution outside bounds",
    },
    {
      id: "subscriptions",
      audience: "CONSUMER",
      actionKinds: ["SUBSCRIPTION_RENEWAL", "RECURRING_PAYMENT"],
      requiredBounds: [
        "vendor",
        "recurring key",
        "maximum renewal",
        "period",
        "expiry",
      ],
      safeDefault: "Escalate price increase or plan change",
    },
    {
      id: "household-bills",
      audience: "CONSUMER",
      actionKinds: ["INVOICE_SETTLEMENT", "RECURRING_PAYMENT"],
      requiredBounds: [
        "payee",
        "account reference",
        "amount",
        "currency",
        "period",
      ],
      safeDefault: "Deny payee or reference substitution",
    },
  ] as const;

export const ENTERPRISE_AUTHORITY_PROFILES: readonly EmbeddedAuthorityProfile[] =
  [
    {
      id: "erp-procurement",
      audience: "ENTERPRISE",
      actionKinds: ["PROCUREMENT_ORDER", "PURCHASE"],
      requiredBounds: [
        "organization",
        "vendor",
        "sku",
        "quantity",
        "cost center",
        "budget",
      ],
      safeDefault: "Escalate substitution or threshold breach",
    },
    {
      id: "accounts-payable",
      audience: "ENTERPRISE",
      actionKinds: ["INVOICE_SETTLEMENT"],
      requiredBounds: [
        "organization",
        "supplier",
        "invoice",
        "cost center",
        "amount",
        "currency",
      ],
      safeDefault: "Deny duplicate or invoice mismatch",
    },
    {
      id: "saas-platform",
      audience: "ENTERPRISE",
      actionKinds: ["SUBSCRIPTION_RENEWAL", "RECURRING_PAYMENT"],
      requiredBounds: [
        "organization",
        "vendor",
        "subscription",
        "period",
        "amount",
      ],
      safeDefault: "Escalate renewal changes",
    },
    {
      id: "marketplace",
      audience: "ENTERPRISE",
      actionKinds: ["MARKETPLACE_DISBURSEMENT", "PAYOUT"],
      requiredBounds: [
        "organization",
        "beneficiary",
        "order/reference",
        "amount",
        "currency",
      ],
      safeDefault: "Deny beneficiary substitution",
    },
    {
      id: "agent-platform",
      audience: "ENTERPRISE",
      actionKinds: [
        "PURCHASE",
        "INVOICE_SETTLEMENT",
        "MACHINE_RESOURCE_PURCHASE",
      ],
      requiredBounds: [
        "organization",
        "agent",
        "purpose",
        "counterparty",
        "amount",
        "expiry",
      ],
      safeDefault: "Require explicit Authority before execution",
    },
  ] as const;
