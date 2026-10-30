import type { ActivityView, ManagedAuthority } from "./management-client.mjs";
import { formatMoney } from "./present";
import { BRAND } from "./brand";

/** Canonical customer-language map (BRAND-001 §7). Backend terms appear only in Proof. */
export const glossary = Object.freeze({
  Mandate: "Authority",
  AgentPassport: "Agent",
  "autonomous threshold": "Can spend without asking up to…",
  "human approval threshold": "Asks you above…",
  "cumulative limit": "Total budget",
  committed: "Used",
  reserved: "Pending",
  "fresh dispatch blocked": "Can't start new purchases",
  "provider conformance": "Payment verified",
  reconciliation: "Checking what happened",
  UNKNOWN_FINANCIAL_OUTCOME:
    "We haven't confirmed whether money moved. Don't retry yet.",
} as const);

export const UNKNOWN_BODY =
  "We haven't confirmed whether money moved. Don't retry yet.";

export const capabilityLabel: Record<string, string> = {
  SEARCH_PRODUCTS: "find products",
  EVALUATE_PRODUCTS: "compare products",
  CREATE_ORDER: "create purchase orders",
  CAPTURE_PAYMENT: "pay for purchases",
  REQUEST_REFUND: "request refunds",
  CREATE_SUBSCRIPTION: "create subscriptions",
  OPEN_DISPUTE: "open disputes",
};

export type AuthorityKind =
  "active" | "revoked" | "expired" | "paused" | "unavailable";

export function authorityKind(a: ManagedAuthority): AuthorityKind {
  if (a.state === "ACTIVE") return "active";
  if (a.state === "REVOKED") return "revoked";
  if (a.state === "EXPIRED") return "expired";
  if (a.state === "UNAVAILABLE")
    return a.agent.status === "SUSPENDED" ? "paused" : "unavailable";
  return "unavailable";
}

export const authorityWord: Record<AuthorityKind, string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  paused: "Paused",
  unavailable: "Temporarily unavailable",
};

export const authorityConsequence: Record<AuthorityKind, string | null> = {
  active: null,
  revoked: "Can't start new purchases. Completed payments are not reversed.",
  expired: "Can't start new purchases. Completed payments are not reversed.",
  paused: "The Agent is paused. Can't start new purchases.",
  unavailable: "Can't start new purchases right now.",
};

export type OutcomeKind = "paid" | "blocked" | "unresolved" | "failed";

export type Outcome = {
  kind: OutcomeKind;
  /** The money line (Layer 1). */
  headline: string;
  /** One calm sentence (Layer 2). */
  detail: string;
  /** Short word shown with the glyph so state never relies on shape or colour alone. */
  word: string;
  /** True when this needs the customer's attention on Home. */
  needsAttention: boolean;
};

/**
 * Maps the accepted M5D Activity projection to the money line. We only say "$0 moved" when the
 * projection says moneyMoved=NO, and only say "paid once" when it says COMPLETED + YES. Everything
 * else is shown as unresolved, never as a claim about money.
 */
export function activityOutcome(x: ActivityView): Outcome {
  const amount = formatMoney(x.amountMinor, x.currency ?? "USD");
  if (x.status === "COMPLETED" && x.moneyMoved === "YES")
    return {
      kind: "paid",
      headline: x.amountMinor === null ? "Paid once" : `${amount} paid once`,
      detail: x.explanation,
      word: "Paid",
      needsAttention: false,
    };
  if (x.moneyMoved === "NO")
    return {
      kind: "blocked",
      headline: "$0 moved",
      detail: x.explanation,
      word: x.status === "DENIED" ? "Blocked" : "Didn't go through",
      needsAttention: false,
    };
  if (x.status === "UNKNOWN_FINANCIAL_OUTCOME")
    return {
      kind: "unresolved",
      headline: "Checking what happened — don't retry yet",
      detail: UNKNOWN_BODY,
      word: "Checking",
      needsAttention: true,
    };
  if (x.status === "ESCALATED")
    return {
      kind: "unresolved",
      headline: "Needs your approval",
      detail: x.explanation,
      word: "Waiting",
      needsAttention: true,
    };
  if (x.status === "PENDING")
    return {
      kind: "unresolved",
      headline: "Payment not confirmed yet",
      detail: x.explanation + " Don't retry yet.",
      word: "Checking",
      needsAttention: true,
    };
  return {
    kind: "unresolved",
    headline:
      x.status === "ALLOWED" ? "Allowed — not paid yet" : "Not yet verified",
    detail: x.explanation,
    word: "Unverified",
    needsAttention: false,
  };
}

/** Whether the Agent acted under an Authority that did not require asking the human again. */
export const delegatedLine =
  "Your Agent did this without asking you, within your Authority.";

const verificationWord: Record<string, string> = {
  VERIFIED: "Verified from saved evidence",
  INCOMPLETE: "Checking what happened",
  INVALID: "Needs attention",
  UNKNOWN_FINANCIAL_OUTCOME: "Checking what happened",
  LEGACY: "Older record, not fully verified",
};
export const verificationSummary = (v: string, moneyMoved?: string) =>
  moneyMoved === "NO" && v === "INCOMPLETE"
    ? "No payment was started."
    : (verificationWord[v] ?? "Not verified");

/** Human sentence for the Authority's approval behaviour. */
export function approvalLine(a: ManagedAuthority): string {
  const free = formatMoney(a.autonomousThresholdMinor, a.currency);
  const ask = formatMoney(a.humanApprovalThresholdMinor, a.currency);
  if (a.autonomousThresholdMinor <= 0) return "Asks you before every purchase";
  const base = `Can spend without asking up to ${free}`;
  return a.humanApprovalThresholdMinor > a.autonomousThresholdMinor
    ? `${base} · Asks you above ${ask}`
    : base;
}

export function conditionLine(conditions: string[]): string {
  return conditions.length
    ? conditions.map((c) => c.toLowerCase()).join(" or ") + " only"
    : "Any condition";
}

export function agentCan(a: ManagedAuthority): string {
  const items = a.allowedCapabilities
    .map((c) => capabilityLabel[c])
    .filter(Boolean);
  return items.length ? items.join(", ") : "No actions";
}

export type TraceState =
  "done" | "stopped" | "waiting" | "none" | "unconfirmed";
export type TraceStep = {
  id: "authority" | "gate" | "payment";
  label: string;
  state: TraceState;
  word: string;
};

/**
 * Customer-level Frame → Gate → Trace for one Activity record (BRAND-001 §4–5). Derived only
 * from the accepted projection; the detailed stage list stays in Proof.
 */
export function traceSteps(x: ActivityView): TraceStep[] {
  const o = activityOutcome(x);
  const authority: TraceStep = {
    id: "authority",
    label: "Authority",
    state: "done",
    word: "Applied",
  };
  if (o.kind === "blocked" && x.decision === "DENY")
    return [
      authority,
      {
        id: "gate",
        label: `${BRAND.name} Gate`,
        state: "stopped",
        word: "Stopped here",
      },
      { id: "payment", label: "Payment", state: "none", word: "Not started" },
    ];
  if (o.kind === "paid")
    return [
      authority,
      {
        id: "gate",
        label: `${BRAND.name} Gate`,
        state: "done",
        word: "Allowed",
      },
      { id: "payment", label: "Payment", state: "done", word: "Paid" },
    ];
  if (o.kind === "blocked")
    return [
      authority,
      {
        id: "gate",
        label: `${BRAND.name} Gate`,
        state: "done",
        word: "Allowed",
      },
      {
        id: "payment",
        label: "Payment",
        state: "none",
        word: "Didn't go through",
      },
    ];
  if (x.status === "ESCALATED")
    return [
      authority,
      {
        id: "gate",
        label: `${BRAND.name} Gate`,
        state: "waiting",
        word: "Waiting for you",
      },
      { id: "payment", label: "Payment", state: "none", word: "Not started" },
    ];
  if (x.status === "UNKNOWN_FINANCIAL_OUTCOME" || x.status === "PENDING")
    return [
      authority,
      {
        id: "gate",
        label: `${BRAND.name} Gate`,
        state: "done",
        word: "Allowed",
      },
      {
        id: "payment",
        label: "Payment",
        state: "unconfirmed",
        word: "Not confirmed",
      },
    ];
  return [
    authority,
    {
      id: "gate",
      label: `${BRAND.name} Gate`,
      state: x.decision === "ALLOW" ? "done" : "none",
      word: x.decision === "ALLOW" ? "Allowed" : "Not verified",
    },
    { id: "payment", label: "Payment", state: "none", word: "Not started" },
  ];
}

/** Customer-facing merchant name. Unknown identifiers are shown as given. */
export const merchantName = (id: string): string =>
  id === "payflow.demo.merchant" ? `${BRAND.name} Demo Merchant — Sandbox` : id;
