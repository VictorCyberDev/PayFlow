export type PendingView = {
  status: string;
  authority: string;
  mode: string;
  source: string;
  reviewId: string;
  displayHash: string;
  agentName: string;
  expiresAt: string;
  terms: { label: string; value: string }[];
};
export type ActiveView = {
  version: string;
  mandateId: string;
  state: string;
  agent: { id: string; displayName: string; status: string };
  purpose: string;
  currency: string;
  singleMaximumMinor: number;
  remainingMinor: number;
  quantityRemaining: number | null;
  merchantScopeSummary: string;
  allowedConditions: string[];
  expiresAt: string;
};
export type ActivationState = {
  status: string;
  pending: PendingView | null;
  authority: ActiveView | null;
};
export function createActivationController(
  publish: (state: ActivationState) => void,
  transport?: (
    path: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<unknown>,
  remember?: (id: string) => void,
  clock?: () => number,
): {
  getState: () => ActivationState;
  dispose: () => void;
  invalidate: () => void;
  restore: (id?: string | null) => Promise<void>;
  login: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  prepare: (source: string) => Promise<void>;
  confirm: () => Promise<void>;
  expire: () => void;
};
