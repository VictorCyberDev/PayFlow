export type UsageMeter =
  "GOVERNED_ACTION" | "VERIFY_CALL" | "ACTIVE_AGENT" | "ENTERPRISE_CONTROL";

export interface UsageEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly meter: UsageMeter;
  readonly quantity: number;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

export interface PricingPlan {
  readonly id: "DEVELOPER" | "PLATFORM" | "ENTERPRISE";
  readonly monthlyBaseMinor: number;
  readonly governedActionMinor: number;
  readonly verificationMinor: number;
  readonly activeAgentMinor: number;
  readonly enterpriseControlMinor: number;
  readonly currency: "USD";
}

export const PRICING_ARCHITECTURE: readonly PricingPlan[] = [
  {
    id: "DEVELOPER",
    monthlyBaseMinor: 0,
    governedActionMinor: 0,
    verificationMinor: 0,
    activeAgentMinor: 0,
    enterpriseControlMinor: 0,
    currency: "USD",
  },
  {
    id: "PLATFORM",
    monthlyBaseMinor: 0,
    governedActionMinor: 1,
    verificationMinor: 0,
    activeAgentMinor: 0,
    enterpriseControlMinor: 0,
    currency: "USD",
  },
  {
    id: "ENTERPRISE",
    monthlyBaseMinor: 0,
    governedActionMinor: 0,
    verificationMinor: 0,
    activeAgentMinor: 0,
    enterpriseControlMinor: 0,
    currency: "USD",
  },
] as const;

/**
 * Price points are intentionally placeholders, not market-validation claims.
 * Enterprise/base pricing remains negotiated/external until willingness-to-pay evidence exists.
 */
export function calculateMeteredAmountMinor(
  plan: PricingPlan,
  events: readonly UsageEvent[],
): number {
  let total = plan.monthlyBaseMinor;
  for (const event of events) {
    if (!Number.isSafeInteger(event.quantity) || event.quantity <= 0) {
      throw new Error("INVALID_USAGE_QUANTITY");
    }
    const unit =
      event.meter === "GOVERNED_ACTION"
        ? plan.governedActionMinor
        : event.meter === "VERIFY_CALL"
          ? plan.verificationMinor
          : event.meter === "ACTIVE_AGENT"
            ? plan.activeAgentMinor
            : plan.enterpriseControlMinor;
    total += unit * event.quantity;
    if (!Number.isSafeInteger(total)) throw new Error("USAGE_AMOUNT_OVERFLOW");
  }
  return total;
}
