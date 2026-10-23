import { z } from "zod";
import {
  OperationTraceSchema,
  type OperationTrace,
} from "./operation-trace.js";
const id = z.string().min(1).max(128);
export const ActivityItemSchema = z
  .object({
    operationId: id,
    mandateId: id,
    agentId: id,
    agentName: z.string().min(1).max(120),
    occurredAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    status: z.enum([
      "ALLOWED",
      "DENIED",
      "ESCALATED",
      "PROPOSED",
      "PENDING",
      "UNKNOWN_FINANCIAL_OUTCOME",
      "COMPLETED",
      "FAILED",
      "INCOMPLETE",
    ]),
    label: z.string().max(120),
    explanation: z.string().max(500),
    decision: z.enum(["ALLOW", "DENY", "ESCALATE"]).nullable(),
    amountMinor: z.number().int().safe().nonnegative().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    merchant: id.nullable(),
    item: id.nullable(),
    moneyMoved: z.enum(["YES", "NO", "UNKNOWN"]),
    verification: OperationTraceSchema.shape.status,
    stages: OperationTraceSchema.shape.stages,
    references: z
      .object({
        paymentAttemptId: id.nullable(),
        providerOrderId: id.nullable(),
        providerCaptureId: id.nullable(),
      })
      .strict(),
  })
  .strict();
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
/** Presentation only: never reruns verification or upgrades the accepted trace status. */
export function activityItem(
  raw: unknown,
  facts: {
    operationId: string;
    mandateId: string;
    agentId: string;
    agentName: string;
    occurredAt: string;
    observedAt: string;
    decision: "ALLOW" | "DENY" | "ESCALATE" | null;
    reasonCodes?: readonly string[];
  },
): ActivityItem {
  const t: OperationTrace = OperationTraceSchema.parse(raw);
  if (
    t.operationId !== facts.operationId ||
    t.references.proposalId !== facts.operationId ||
    t.references.mandateId !== facts.mandateId ||
    t.references.agentId !== facts.agentId
  )
    throw new Error("UNAVAILABLE");
  const outcome = t.financialOutcome,
    trusted = t.status !== "INVALID" && t.status !== "LEGACY";
  const completed = t.status === "VERIFIED" && outcome === "CAPTURED";
  const noEffect =
    t.status === "VERIFIED" &&
    outcome === "FAILED" &&
    t.stages.some(
      (s) =>
        s.stage === "FINANCIAL_FINALIZATION" &&
        s.status === "VERIFIED" &&
        s.reasonCode === "PROVEN_NO_EFFECT_CREATE_REJECTION",
    );
  const denied =
    trusted &&
    outcome === "DENIED" &&
    t.stages.some(
      (s) =>
        s.stage === "EXECUTION" &&
        s.status === "NOT_APPLICABLE" &&
        s.reasonCode === "DENIED_NO_EXECUTION",
    );
  const ambiguous =
    [
      "CAPTURE_UNKNOWN",
      "ORDER_CREATE_UNKNOWN",
      "CAPTURE_IN_FLIGHT",
      "ORDER_CREATING",
      "CAPTURE_PENDING_PROVIDER",
      "QUARANTINED",
    ].includes(outcome) || t.status === "UNKNOWN_FINANCIAL_OUTCOME";
  let status: ActivityItem["status"] = "INCOMPLETE",
    label = "Verification incomplete",
    explanation =
      "The saved evidence does not establish a final payment outcome.";
  if (ambiguous) {
    status = "UNKNOWN_FINANCIAL_OUTCOME";
    label = "Payment still being verified";
    explanation = "We have not confirmed the final provider outcome yet.";
  } else if (completed) {
    status = "COMPLETED";
    label = "Payment verified";
    explanation = "PayFlow verified the completed payment from saved evidence.";
  } else if (noEffect) {
    status = "FAILED";
    label = "Payment did not start";
    explanation =
      "Verified provider rejection proves that this attempt had no financial effect.";
  } else if (denied) {
    status = "DENIED";
    label = "Purchase blocked";
    const reasons: Record<string, string> = {
      AMOUNT_EXCEEDS_LIMIT:
        "The request exceeded the maximum amount permitted by this authority.",
      CUMULATIVE_LIMIT_EXCEEDED:
        "The request exceeded the remaining cumulative authority.",
      MERCHANT_NOT_ALLOWED:
        "The merchant was outside this authority’s approved scope.",
      CONDITION_DENIED:
        "The item condition was not permitted by this authority.",
      QUANTITY_EXHAUSTED: "This authority’s quantity limit was exhausted.",
      HUMAN_APPROVAL_LIMIT_EXCEEDED:
        "The request exceeded this authority’s human approval limit.",
      CAPABILITY_DENIED: "This authority did not permit the requested action.",
      MANDATE_EXPIRED:
        "This authority had expired when the request was evaluated.",
      AGENT_SUSPENDED: "The agent was paused when the request was evaluated.",
    };
    explanation =
      (facts.reasonCodes ?? []).map((r) => reasons[r]).find(Boolean) ??
      "PayFlow denied this request before execution.";
  } else if (
    trusted &&
    facts.decision === "ESCALATE" &&
    !t.references.paymentAttemptId
  ) {
    status = "ESCALATED";
    label = "Approval required";
    explanation =
      "This request requires human approval before payment can proceed.";
  } else if (trusted && t.references.paymentAttemptId) {
    status = "PENDING";
    label = "Payment pending";
    explanation =
      "The saved payment attempt has not established a verified completion.";
  } else if (trusted && facts.decision === "ALLOW") {
    status = "ALLOWED";
    label = "Request allowed";
    explanation =
      "The saved authorization allowed this request. This alone does not prove payment.";
  } else if (trusted && !facts.decision) {
    status = "PROPOSED";
    label = "Request proposed";
    explanation =
      "No saved authorization decision is available for this request.";
  }
  if (t.status === "INVALID") {
    status = ambiguous ? "UNKNOWN_FINANCIAL_OUTCOME" : "INCOMPLETE";
    label = ambiguous
      ? "Final payment outcome unknown"
      : "Verification needs attention";
    explanation =
      "The saved verification is invalid. No successful or no-effect outcome is asserted.";
  }
  if (t.status === "LEGACY") {
    status = "INCOMPLETE";
    label = "Historical record · incomplete verification";
  }
  const c = t.authorityMeter.commerce,
    f = t.authorityMeter.financial;
  return ActivityItemSchema.parse({
    operationId: facts.operationId,
    mandateId: facts.mandateId,
    agentId: facts.agentId,
    agentName: facts.agentName,
    occurredAt: facts.occurredAt,
    observedAt: facts.observedAt,
    decision: facts.decision,
    status,
    label,
    explanation,
    amountMinor: trusted ? f.requestedMinor : null,
    currency: trusted ? f.currency : null,
    merchant: trusted ? c.logicalMerchant : null,
    item: trusted ? c.sku : null,
    moneyMoved: completed ? "YES" : noEffect || denied ? "NO" : "UNKNOWN",
    verification: t.status,
    stages: t.stages,
    references: {
      paymentAttemptId: t.references.paymentAttemptId,
      providerOrderId: t.references.providerOrderId,
      providerCaptureId: t.references.providerCaptureId,
    },
  });
}
