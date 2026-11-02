// Presentation fixtures used by component tests and the visual QA gallery. NOT product data.
import type {
  ActivityView,
  ManagedAuthority,
} from "../lib/management-client.mjs";

export const NOW = new Date("2026-10-23T22:00:00.000Z");

export const authority: ManagedAuthority = {
  version: "payflow.authority-view.v1",
  mandateId: "auth_7f3a9c21",
  state: "ACTIVE",
  agent: {
    id: "agent_shop_01",
    displayName: "Shopping Agent",
    status: "ACTIVE",
  },
  purpose: "Keyboard purchase",
  currency: "USD",
  singleMaximumMinor: 10000,
  cumulativeLimitMinor: 10000,
  committedMinor: 8400,
  reservedMinor: 0,
  remainingMinor: 1600,
  quantityLimit: 1,
  quantityRemaining: 1,
  merchantScopeSummary: "Approved merchants only",
  allowedConditions: ["NEW"],
  allowedCapabilities: ["SEARCH_PRODUCTS", "CREATE_ORDER", "CAPTURE_PAYMENT"],
  autonomousThresholdMinor: 10000,
  humanApprovalThresholdMinor: 10000,
  createdAt: "2026-10-21T15:00:00.000Z",
  expiresAt: "2026-10-30T22:00:00.000Z",
  observedAt: "2026-10-23T21:59:00.000Z",
  freshDispatchBlocked: null,
};

const base: ActivityView = {
  operationId: "op_100",
  mandateId: authority.mandateId,
  agentId: authority.agent.id,
  agentName: "Shopping Agent",
  occurredAt: "2026-10-23T19:42:00.000Z",
  observedAt: "2026-10-23T19:43:00.000Z",
  status: "COMPLETED",
  label: "Payment verified",
  explanation: "PayFlow verified the completed payment from saved evidence.",
  decision: "ALLOW",
  amountMinor: 8400,
  currency: "USD",
  merchant: "Approved merchant",
  item: "Mechanical keyboard",
  moneyMoved: "YES",
  delegated: true,
  verification: "VERIFIED",
  stages: [
    { stage: "MANDATE", status: "VERIFIED", reasonCode: "MANDATE_ACTIVE" },
    { stage: "AUTHORIZATION", status: "VERIFIED", reasonCode: "ALLOWED" },
    { stage: "PROVIDER", status: "VERIFIED", reasonCode: "CAPTURE_COMPLETED" },
  ],
  references: {
    paymentAttemptId: "att_1",
    providerOrderId: "ORDER_1",
    providerCaptureId: "CAPTURE_1",
  },
};
export const paid: ActivityView = base;
export const blocked: ActivityView = {
  ...base,
  operationId: "op_101",
  occurredAt: "2026-10-23T19:36:00.000Z",
  status: "DENIED",
  label: "Purchase blocked",
  explanation:
    "The request exceeded the maximum amount permitted by this authority.",
  decision: "DENY",
  amountMinor: 18400,
  item: "Refurbished keyboard",
  moneyMoved: "NO",
  verification: "VERIFIED",
  stages: [
    { stage: "MANDATE", status: "VERIFIED", reasonCode: "MANDATE_ACTIVE" },
    {
      stage: "AUTHORIZATION",
      status: "VERIFIED",
      reasonCode: "AMOUNT_EXCEEDS_LIMIT",
    },
    {
      stage: "PROVIDER",
      status: "NOT_STARTED",
      reasonCode: "NO_PROVIDER_CALL",
    },
  ],
  references: {
    paymentAttemptId: null,
    providerOrderId: null,
    providerCaptureId: null,
  },
};
export const unknown: ActivityView = {
  ...base,
  operationId: "op_102",
  occurredAt: "2026-10-23T19:31:00.000Z",
  status: "UNKNOWN_FINANCIAL_OUTCOME",
  label: "Payment still being verified",
  explanation: "We have not confirmed the final provider outcome yet.",
  moneyMoved: "UNKNOWN",
  verification: "UNKNOWN_FINANCIAL_OUTCOME",
  stages: [
    {
      stage: "PROVIDER",
      status: "INCOMPLETE",
      reasonCode: "PROVIDER_UNCERTAIN",
    },
  ],
  references: {
    paymentAttemptId: "att_3",
    providerOrderId: "ORDER_3",
    providerCaptureId: null,
  },
};
export const revoked: ManagedAuthority = {
  ...authority,
  mandateId: "auth_old",
  state: "REVOKED",
  freshDispatchBlocked: true,
  purpose: "Headphones",
};
