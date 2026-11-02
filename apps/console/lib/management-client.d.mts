import type { ActiveView } from "./activation-client.mjs";
export type ManagedAuthority = ActiveView & {
  cumulativeLimitMinor: number | null;
  committedMinor: number;
  reservedMinor: number;
  quantityLimit: number | null;
  allowedCapabilities: string[];
  autonomousThresholdMinor: number;
  humanApprovalThresholdMinor: number;
  createdAt: string;
  observedAt: string;
  freshDispatchBlocked: boolean | null;
};
export type ActivityView = {
  operationId: string;
  mandateId: string;
  agentId: string;
  agentName: string;
  occurredAt: string;
  observedAt: string;
  status: string;
  label: string;
  explanation: string;
  decision: string | null;
  amountMinor: number | null;
  currency: string | null;
  merchant: string | null;
  item: string | null;
  moneyMoved: "YES" | "NO" | "UNKNOWN";
  /** True only for a completed purchase that no human approved at payment time. */
  delegated?: boolean;
  verification: string;
  stages: { stage: string; status: string; reasonCode: string }[];
  references: {
    paymentAttemptId: string | null;
    providerOrderId: string | null;
    providerCaptureId: string | null;
  };
};
export type ManagementState = {
  status: string;
  authorities: ManagedAuthority[];
  activity: ActivityView[];
  error: string | null;
  selected: string | null;
};
export function createManagementController(
  publish: (state: ManagementState) => void,
  transport?: (
    path: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<unknown>,
  clock?: () => number,
): {
  getState: () => ManagementState;
  dispose: () => void;
  refresh: () => Promise<void>;
  requestRevoke: (id: string) => void;
  cancelRevoke: () => void;
  revoke: () => Promise<void>;
  expire: () => void;
};
