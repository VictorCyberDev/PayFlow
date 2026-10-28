export interface VerificationEconomicsInput {
  readonly verificationCalls: number;
  readonly cacheHitRateBps: number;
  readonly originCostMinorPerCall: number;
  readonly cachedCostMinorPerCall: number;
  readonly governedActions: number;
  readonly governedActionRevenueMinor: number;
  readonly enterpriseBaseRevenueMinor: number;
}

export interface VerificationEconomicsResult {
  readonly originCalls: number;
  readonly cachedCalls: number;
  readonly verificationCostMinor: number;
  readonly revenueMinor: number;
  readonly contributionMinor: number;
}

export function modelVerificationEconomics(
  input: VerificationEconomicsInput,
): VerificationEconomicsResult {
  for (const value of [
    input.verificationCalls,
    input.cacheHitRateBps,
    input.originCostMinorPerCall,
    input.cachedCostMinorPerCall,
    input.governedActions,
    input.governedActionRevenueMinor,
    input.enterpriseBaseRevenueMinor,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_ECONOMICS_INPUT");
  }
  if (input.cacheHitRateBps > 10_000) throw new Error("INVALID_CACHE_HIT_RATE");
  const cachedCalls = Math.floor((input.verificationCalls * input.cacheHitRateBps) / 10_000);
  const originCalls = input.verificationCalls - cachedCalls;
  const verificationCostMinor =
    originCalls * input.originCostMinorPerCall + cachedCalls * input.cachedCostMinorPerCall;
  const revenueMinor =
    input.governedActions * input.governedActionRevenueMinor + input.enterpriseBaseRevenueMinor;
  if (!Number.isSafeInteger(verificationCostMinor) || !Number.isSafeInteger(revenueMinor)) {
    throw new Error("ECONOMICS_OVERFLOW");
  }
  return {
    originCalls,
    cachedCalls,
    verificationCostMinor,
    revenueMinor,
    contributionMinor: revenueMinor - verificationCostMinor,
  };
}
