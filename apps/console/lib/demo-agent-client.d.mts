export declare const SCENARIOS: readonly ["VALID_PURCHASE", "PRICE_DRIFT"];
export type DemoScenario = (typeof SCENARIOS)[number];
export type DemoOutcome = {
  status: "COMPLETED" | "DENIED" | "NEEDS_HUMAN" | "REFUSED" | "UNRESOLVED";
  operationId: string | null;
  code: string | null;
};
type Transport = (
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<unknown>;
export function fetchDemoAgentStatus(
  transport?: Transport,
): Promise<{ payment: "SANDBOX_CONNECTED" | "NOT_CONNECTED" } | null>;
export function fetchPayPalVaultStatus(
  transport?: Transport,
): Promise<boolean | null>;
export function startPayPalVaultConnection(
  transport?: Transport,
): Promise<void>;
export function completePayPalVaultConnection(
  state: string,
  transport?: Transport,
): Promise<boolean>;
export function runDemoScenario(
  mandateId: string,
  scenario: DemoScenario,
  transport?: Transport,
): Promise<DemoOutcome>;
export function reconcileDemo(transport?: Transport): Promise<boolean>;
