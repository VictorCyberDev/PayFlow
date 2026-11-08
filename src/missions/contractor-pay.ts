import { z } from "zod";
import type { PurchaseOrderDoc } from "./purchase.js";

/**
 * V3 M50 — deliverables and contractor payment. Pure and deterministic.
 *
 * A milestone's payment is described the same way a purchase is, so the same classifier reads PayFlow's own trace for it: this module
 * only builds that description and derives a milestone's state from facts. Nothing here believes what a contractor, a deliverable or an
 * agent says about money.
 */
export const SubmissionSchema = z
  .object({
    summary: z.string().trim().min(1).max(1000),
    refs: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  })
  .strict();
export type Submission = z.infer<typeof SubmissionSchema>;

export interface MilestoneFact {
  readonly index: number;
  readonly title: string;
  readonly amountMinor: number;
}
export function paymentDoc(f: {
  currency: string;
  milestone: MilestoneFact;
  contractId: string;
  paymentId: string;
  agentId: string;
  authorityId: string;
  category: string;
  payee: string;
  purpose: string;
  expiresAt: string;
}): PurchaseOrderDoc {
  return {
    merchant: f.payee,
    currency: f.currency,
    totalMinor: f.milestone.amountMinor,
    lines: [
      {
        sku: null,
        description: f.milestone.title,
        quantity: 1,
        unitPriceMinor: f.milestone.amountMinor,
      },
    ],
    category: f.category,
    purpose: f.purpose,
    costCenter: null,
    invoiceRef: null,
    quoteId: f.contractId,
    acceptanceId: f.contractId,
    authorityId: f.authorityId,
    agentId: f.agentId,
    requestId: f.paymentId,
    expiresAt: f.expiresAt,
  };
}

export type MilestoneState =
  | "NOT_STARTED"
  | "SUBMITTED"
  | "REJECTED"
  | "ACCEPTED"
  | "PAYMENT_ISSUED"
  | "PAID"
  | "CANCELLED";
export function milestoneState(f: {
  deliverables: readonly ("SUBMITTED" | "ACCEPTED" | "REJECTED")[];
  paymentIssued: boolean;
  settled: boolean;
  cancelled: boolean;
}): MilestoneState {
  if (f.cancelled) return "CANCELLED";
  if (f.settled) return "PAID";
  if (f.paymentIssued) return "PAYMENT_ISSUED";
  if (f.deliverables.includes("ACCEPTED")) return "ACCEPTED";
  if (f.deliverables.includes("SUBMITTED")) return "SUBMITTED";
  if (f.deliverables.length > 0) return "REJECTED";
  return "NOT_STARTED";
}
/** Termination keeps what is already in motion: only milestones with no payment instruction are cancelled. */
export function terminationPlan(
  milestones: readonly { index: number; paymentIssued: boolean }[],
) {
  return {
    cancel: milestones.filter((m) => !m.paymentIssued).map((m) => m.index),
    keep: milestones.filter((m) => m.paymentIssued).map((m) => m.index),
  };
}
