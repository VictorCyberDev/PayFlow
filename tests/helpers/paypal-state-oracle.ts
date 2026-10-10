// Test oracle for the existing rail, not a replacement state machine. Provider
// observation can resolve any nonterminal dispatched state to CAPTURED.
const legal: Readonly<Record<string, readonly string[]>> = {
  NOT_STARTED: ["ORDER_CREATING"],
  ORDER_CREATING: [
    "ORDER_CREATED",
    "PAYER_ACTION_REQUIRED",
    "ORDER_CREATE_UNKNOWN",
    "CAPTURED",
  ],
  ORDER_CREATE_UNKNOWN: ["ORDER_CREATING", "CAPTURED"],
  ORDER_CREATED: [
    "CAPTURE_IN_FLIGHT",
    "CAPTURE_UNKNOWN",
    "CAPTURE_PENDING_PROVIDER",
    "CAPTURED",
  ],
  PAYER_ACTION_REQUIRED: [
    "CAPTURE_IN_FLIGHT",
    "CAPTURE_UNKNOWN",
    "CAPTURE_PENDING_PROVIDER",
    "CAPTURED",
  ],
  CAPTURE_PENDING: ["CAPTURE_UNKNOWN", "CAPTURE_PENDING_PROVIDER", "CAPTURED"],
  CAPTURE_IN_FLIGHT: [
    "CAPTURE_IN_FLIGHT",
    "CAPTURE_UNKNOWN",
    "CAPTURE_PENDING_PROVIDER",
    "CAPTURED",
  ],
  CAPTURE_UNKNOWN: [
    "CAPTURE_IN_FLIGHT",
    "CAPTURE_UNKNOWN",
    "CAPTURE_PENDING_PROVIDER",
    "CAPTURED",
  ],
  CAPTURE_PENDING_PROVIDER: [
    "CAPTURE_UNKNOWN",
    "CAPTURE_PENDING_PROVIDER",
    "CAPTURED",
  ],
  CAPTURED: ["CAPTURED"],
  FAILED: ["FAILED"],
  CANCELLED: ["CANCELLED"],
};
export function assertPayPalTransitions(states: readonly string[]): void {
  if (!states.length || states.some((state) => !Object.hasOwn(legal, state)))
    throw new Error("UNKNOWN_PAYMENT_STATE");
  for (let index = 1; index < states.length; index++) {
    if (!legal[states[index - 1]!]!.includes(states[index]!))
      throw new Error("ILLEGAL_PAYMENT_TRANSITION");
  }
}
export const paypalTransitionOracle = legal;
