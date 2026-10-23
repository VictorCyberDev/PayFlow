import { describe, it, expect } from "vitest";
import {
  OperationTraceSchema,
  type OperationTrace,
} from "../src/operation-trace.js";
import {
  activityItem,
  ActivityItemSchema,
} from "../src/activity-projection.js";
const facts = {
  operationId: "op",
  mandateId: "m",
  agentId: "a",
  agentName: "Shopping Agent",
  occurredAt: "2026-10-23T10:00:00.000Z",
  observedAt: "2026-10-23T10:01:00.000Z",
  decision: "ALLOW" as "ALLOW" | "DENY" | "ESCALATE" | null,
};
function trace(
  status: OperationTrace["status"] = "INCOMPLETE",
  financialOutcome = "NOT_STARTED",
): OperationTrace {
  const refs = Object.fromEntries(
    Object.keys(OperationTraceSchema.shape.references.shape).map((k) => [
      k,
      null,
    ]),
  );
  return OperationTraceSchema.parse({
    version: "payflow.operation-trace.v1",
    operationId: "op",
    status,
    financialOutcome,
    references: {
      ...refs,
      principalId: "p",
      mandateId: "m",
      agentId: "a",
      proposalId: "op",
    },
    stages: [],
    evidence: [],
    authorityMeter: {
      financial: {
        currency: "USD",
        singleMaximumMinor: 10000,
        principalState: "ACTIVE",
        agentState: "ACTIVE",
        mandateState: "ACTIVE",
        requestedMinor: 8400,
        authorizedMinor: null,
        reservedMinor: 0,
        committedMinor: 0,
        remainingMinor: 10000,
        capability: "CAPTURE_PAYMENT",
        mandateExpiresAt: null,
        reservationState: null,
        grantState: null,
        freshDispatchBlocked: null,
      },
      commerce: {
        trust: "TRUSTED_CHECKOUT",
        observedPrice: {
          trust: "UNTRUSTED_OBSERVATION",
          minor: null,
          currency: null,
        },
        trustedTotalMinor: null,
        category: null,
        condition: null,
        logicalMerchant: "shop",
        expectedRecipient: null,
        observedRecipient: null,
        observedAmount: null,
        observedCurrency: null,
        sku: "keyboard",
        productFamily: null,
        variant: null,
        quantity: null,
        mappingRevision: null,
        offerFingerprint: null,
        manifestFingerprint: null,
      },
    },
  });
}
describe("M5D bounded presentation over accepted OperationTrace", () => {
  it.each(["ALLOW", "DENY", "ESCALATE", null] as const)(
    "maps %s without asserting payment",
    (decision) => {
      const t = trace(
        "INCOMPLETE",
        decision === "DENY" ? "DENIED" : "NOT_STARTED",
      );
      if (decision === "DENY")
        t.stages.push({
          stage: "EXECUTION",
          status: "NOT_APPLICABLE",
          reasonCode: "DENIED_NO_EXECUTION",
        });
      const item = activityItem(t, {
        ...facts,
        decision,
        reasonCodes: ["AMOUNT_EXCEEDS_LIMIT"],
      });
      expect(item.status).toBe(
        decision === "ALLOW"
          ? "ALLOWED"
          : decision === "DENY"
            ? "DENIED"
            : decision === "ESCALATE"
              ? "ESCALATED"
              : "PROPOSED",
      );
      expect(item.moneyMoved).toBe(decision === "DENY" ? "NO" : "UNKNOWN");
      if (decision === "DENY")
        expect(item.explanation).toContain("maximum amount");
    },
  );
  it("verified completed capture means money moved YES", () =>
    expect(activityItem(trace("VERIFIED", "CAPTURED"), facts)).toMatchObject({
      status: "COMPLETED",
      moneyMoved: "YES",
      verification: "VERIFIED",
    }));
  it("proven no effect requires accepted explicit finalization proof", () => {
    const t = trace("VERIFIED", "FAILED");
    expect(activityItem(t, facts).moneyMoved).toBe("UNKNOWN");
    t.stages.push({
      stage: "FINANCIAL_FINALIZATION",
      status: "VERIFIED",
      reasonCode: "PROVEN_NO_EFFECT_CREATE_REJECTION",
    });
    expect(activityItem(t, facts)).toMatchObject({
      status: "FAILED",
      moneyMoved: "NO",
    });
  });
  it.each([
    "CAPTURE_UNKNOWN",
    "ORDER_CREATE_UNKNOWN",
    "CAPTURE_IN_FLIGHT",
    "ORDER_CREATING",
    "CAPTURE_PENDING_PROVIDER",
    "QUARANTINED",
  ])("%s never becomes success or no-effect", (outcome) => {
    const r = activityItem(trace("UNKNOWN_FINANCIAL_OUTCOME", outcome), facts);
    expect(r.status).toBe("UNKNOWN_FINANCIAL_OUTCOME");
    expect(r.moneyMoved).toBe("UNKNOWN");
    expect(r.label).toBe("Payment still being verified");
  });
  it.each(["INVALID", "INCOMPLETE", "LEGACY"] as const)(
    "preserves %s and cannot upgrade captured outcome",
    (status) => {
      const r = activityItem(trace(status, "CAPTURED"), facts);
      expect(r.verification).toBe(status);
      expect(r.moneyMoved).toBe("UNKNOWN");
      expect(r.status).not.toBe("COMPLETED");
    },
  );
  it("invalid trace with ambiguous payment cannot claim failure or completion", () => {
    const r = activityItem(trace("INVALID", "CAPTURE_UNKNOWN"), facts);
    expect(r.moneyMoved).toBe("UNKNOWN");
    expect(r.label).toBe("Final payment outcome unknown");
    expect(r.verification).toBe("INVALID");
  });
  it("pending attempt remains pending, never confirmed financial effect", () => {
    const t = trace("INCOMPLETE", "PAYER_ACTION_REQUIRED");
    t.references.paymentAttemptId = "attempt";
    expect(activityItem(t, facts)).toMatchObject({
      status: "PENDING",
      moneyMoved: "UNKNOWN",
    });
  });
  it.each(["operationId", "mandateId", "agentId"])(
    "rejects swapped %s",
    (key) =>
      expect(() =>
        activityItem(trace(), { ...facts, [key]: "other" }),
      ).toThrow(),
  );
  it("strict projection does not carry raw blobs, credentials, assertions or trace evidence payload", () => {
    const t = trace();
    const result = activityItem(t, facts);
    expect(
      ActivityItemSchema.safeParse({ ...result, session: "secret" }).success,
    ).toBe(false);
    expect(() =>
      activityItem({ ...t, provider: { oauth: "secret" } }, facts),
    ).toThrow();
    expect(JSON.stringify(result)).not.toMatch(
      /csrf|oauth|privateKey|resumeSecret|signedToken|evidence/,
    );
  });
});
