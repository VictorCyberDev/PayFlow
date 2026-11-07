import { createHash } from "node:crypto";
import type { EvidenceKind, Stage } from "./ledger.js";

/**
 * V3 M40 — purchase orders and reconciliation. Pure and deterministic.
 *
 * A purchase order says exactly what may be paid and to whom. Reconciliation compares PayFlow's own operation trace for a payment to
 * that order and decides what the budget item should become. The trace is the only source of truth for what happened; the comparison
 * is exact, and anything that does not match holds the budget (UNKNOWN) rather than release it.
 */
export interface PurchaseOrderDoc {
  readonly merchant: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly lines: readonly {
    sku: string | null;
    description: string;
    quantity: number;
    unitPriceMinor: number | null;
  }[];
  readonly category: string;
  readonly purpose: string;
  readonly costCenter: string | null;
  readonly invoiceRef: string | null;
  readonly quoteId: string;
  readonly acceptanceId: string;
  readonly authorityId: string;
  readonly agentId: string;
  /** Carry this as the request id of the payment so the order and the payment can be tied together. */
  readonly requestId: string;
  readonly expiresAt: string;
}
export const digestOf = (d: PurchaseOrderDoc) =>
  createHash("sha256")
    .update(JSON.stringify(d, Object.keys(d).sort()))
    .digest("hex");

/** The slice of PayFlow's operation trace the reconciler relies on. */
export interface TraceFacts {
  readonly status:
    | "VERIFIED"
    | "INCOMPLETE"
    | "INVALID"
    | "UNKNOWN_FINANCIAL_OUTCOME"
    | "LEGACY";
  readonly financialOutcome: string;
  readonly references: {
    readonly mandateId: string | null;
    readonly agentId: string | null;
    readonly proposalId: string | null;
    readonly receiptId: string | null;
    readonly providerCaptureId: string | null;
    readonly providerOrderId: string | null;
  };
  readonly financial: {
    readonly currency: string | null;
    readonly requestedMinor: number | null;
    readonly committedMinor: number | null;
  };
  readonly commerce: {
    readonly logicalMerchant: string | null;
    readonly sku: string | null;
    readonly trustedTotalMinor: number | null;
    readonly quantity: number | null;
  };
}

export type Classification =
  "SETTLED" | "UNKNOWN" | "FAILED_NO_EFFECT" | "MISMATCH" | "INCOMPLETE";

/** Everything the payment must match. A field the trace does not carry is not a mismatch; a field it carries that differs is. */
export function mismatches(po: PurchaseOrderDoc, t: TraceFacts): string[] {
  const p: string[] = [];
  if (t.references.mandateId !== po.authorityId) p.push("AUTHORITY_DIFFERS");
  if (t.references.agentId !== po.agentId) p.push("AGENT_DIFFERS");
  if (t.financial.currency !== null && t.financial.currency !== po.currency)
    p.push("CURRENCY_DIFFERS");
  if (
    t.financial.requestedMinor !== null &&
    t.financial.requestedMinor !== po.totalMinor
  )
    p.push("AMOUNT_DIFFERS");
  if (
    t.commerce.trustedTotalMinor !== null &&
    t.commerce.trustedTotalMinor !== po.totalMinor
  )
    p.push("TRUSTED_TOTAL_DIFFERS");
  if (
    t.commerce.logicalMerchant !== null &&
    t.commerce.logicalMerchant !== po.merchant
  )
    p.push("MERCHANT_DIFFERS");
  if (t.commerce.sku !== null) {
    const skus = po.lines
      .map((l) => l.sku)
      .filter((s): s is string => s !== null);
    if (skus.length > 0 && !skus.includes(t.commerce.sku))
      p.push("SKU_DIFFERS");
  }
  if (t.commerce.quantity !== null) {
    const q = po.lines.reduce((a, l) => a + l.quantity, 0);
    if (t.commerce.quantity !== q) p.push("QUANTITY_DIFFERS");
  }
  return p;
}

export function classify(
  po: PurchaseOrderDoc,
  t: TraceFacts,
): { classification: Classification; problems: string[] } {
  const problems = mismatches(po, t);
  if (problems.length > 0) return { classification: "MISMATCH", problems };
  if (t.status === "INVALID")
    return { classification: "UNKNOWN", problems: ["TRACE_INVALID"] };
  if (t.status === "UNKNOWN_FINANCIAL_OUTCOME")
    return { classification: "UNKNOWN", problems: [] };
  if (t.status === "VERIFIED" && t.financialOutcome === "CAPTURED") {
    if (!t.references.providerCaptureId)
      return {
        classification: "UNKNOWN",
        problems: ["NO_PROVIDER_CAPTURE_ON_RECORD"],
      };
    if (
      t.financial.committedMinor !== null &&
      t.financial.committedMinor !== po.totalMinor
    )
      return {
        classification: "MISMATCH",
        problems: ["COMMITTED_AMOUNT_DIFFERS"],
      };
    return { classification: "SETTLED", problems: [] };
  }
  if (t.status === "VERIFIED" && t.financialOutcome === "FAILED")
    return { classification: "FAILED_NO_EFFECT", problems: [] };
  return { classification: "INCOMPLETE", problems: [] };
}

export interface LedgerStep {
  readonly to: Stage;
  readonly evidenceKind: EvidenceKind;
  readonly evidence: Record<string, string | number>;
}
/**
 * The ledger moves for a classification, from wherever the item is now, each with the evidence the ledger requires: a receipt for
 * reservations and unknown outcomes, Proof or provider confirmation for settlement and release.
 */
export function ledgerSteps(
  from: Stage,
  c: Classification,
  t: TraceFacts,
  proposalId: string,
): LedgerStep[] {
  const receipt = {
    evidenceKind: "PAYFLOW_AUTHORITY_RECEIPT" as const,
    evidence: {
      receipt: t.references.receiptId ?? "none",
      proposal: proposalId,
    },
  };
  const proof = {
    evidenceKind: "PAYFLOW_PROOF" as const,
    evidence: { proposal: proposalId },
  };
  const provider = {
    evidenceKind: "PROVIDER_CONFIRMATION" as const,
    evidence: {
      provider: "paypal",
      capture: t.references.providerCaptureId ?? "none",
      proposal: proposalId,
    },
  };
  const steps: LedgerStep[] = [];
  const toInFlight = (s: Stage) => {
    if (s === "APPROVED" || s === "COMMITTED")
      steps.push({ to: "RESERVED", ...receipt });
    if (s === "APPROVED" || s === "COMMITTED" || s === "RESERVED")
      steps.push({ to: "IN_FLIGHT", ...receipt });
  };
  if (c === "SETTLED") {
    if (from === "SETTLED") return [];
    toInFlight(from);
    steps.push({ to: "SETTLED", ...provider });
  } else if (c === "UNKNOWN" || c === "MISMATCH") {
    if (from === "UNKNOWN" || from === "SETTLED") return [];
    // Hold the budget: nobody can say money did not move.
    if (t.references.receiptId === null && from === "APPROVED") return [];
    toInFlight(from);
    steps.push({ to: "UNKNOWN", ...receipt });
  } else if (c === "FAILED_NO_EFFECT") {
    if (from === "UNKNOWN") steps.push({ to: "RELEASED", ...proof });
    else if (from === "IN_FLIGHT") steps.push({ to: "FAILED", ...proof });
    else if (from === "APPROVED" || from === "COMMITTED" || from === "RESERVED")
      steps.push({ to: "CANCELLED", ...proof });
  }
  return steps;
}

/**
 * A payment under another Authority or by another agent is not this order's payment at all: it must not move this order's budget
 * (otherwise anyone could freeze it by naming an unrelated proposal). Every other disagreement holds the budget.
 */
export const isForeignPayment = (problems: readonly string[]) =>
  problems.includes("AUTHORITY_DIFFERS") || problems.includes("AGENT_DIFFERS");

/** Reduce a full operation trace to the facts the reconciler compares. */
export function traceFactsOf(t: {
  status: TraceFacts["status"];
  financialOutcome: string;
  references: Record<string, string | null>;
  authorityMeter: {
    financial: TraceFacts["financial"];
    commerce: {
      logicalMerchant: string | null;
      sku: string | null;
      trustedTotalMinor: number | null;
      quantity: number | null;
    };
  };
}): TraceFacts {
  const r = t.references;
  const f = t.authorityMeter.financial;
  const c = t.authorityMeter.commerce;
  return {
    status: t.status,
    financialOutcome: t.financialOutcome,
    references: {
      mandateId: r["mandateId"] ?? null,
      agentId: r["agentId"] ?? null,
      proposalId: r["proposalId"] ?? null,
      receiptId: r["receiptId"] ?? null,
      providerCaptureId: r["providerCaptureId"] ?? null,
      providerOrderId: r["providerOrderId"] ?? null,
    },
    financial: {
      currency: f.currency,
      requestedMinor: f.requestedMinor,
      committedMinor: f.committedMinor,
    },
    commerce: {
      logicalMerchant: c.logicalMerchant,
      sku: c.sku,
      trustedTotalMinor: c.trustedTotalMinor,
      quantity: c.quantity,
    },
  };
}
