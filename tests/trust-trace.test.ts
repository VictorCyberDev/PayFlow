import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTrustTrace } from "../src/trust-trace.js";
import type { DurableEvidence } from "../src/persistence.js";

function canonical(v: unknown): string {
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, child]) => `${JSON.stringify(k)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const binding = {
  reviewId: "review",
  principalId: "human",
  agentId: "agent",
  draftFingerprint: "draft",
  reviewedHash: "review-hash",
};
const events: readonly [string, DurableEvidence["data"]][] = [
  ["INTENT_REVIEW_CREATED", binding],
  ["HUMAN_CONFIRMATION_ACCEPTED", binding],
  ["INTENT_MANDATE_ACTIVATED", { reviewId: "review", mandateId: "mandate" }],
  [
    "RESERVATION_CREATED",
    { reservationId: "reservation", proposalId: "proposal" },
  ],
  [
    "EXECUTION_GRANT_ISSUED",
    {
      grantId: "grant",
      reservationId: "reservation",
      proposalDigest: "digest",
    },
  ],
  [
    "EXECUTION_AUTHORITY_CLAIMED",
    { grantId: "grant", reservationId: "reservation" },
  ],
  [
    "PAYMENT_ATTEMPT_CREATED",
    {
      paymentAttemptId: "attempt",
      grantId: "grant",
      reservationId: "reservation",
    },
  ],
  [
    "PAYPAL_OPERATION_DISPATCHED",
    { paymentAttemptId: "attempt", status: "ORDER_CREATING" },
  ],
  [
    "PAYPAL_OPERATION_DISPATCHED",
    { paymentAttemptId: "attempt", status: "CAPTURE_IN_FLIGHT" },
  ],
  [
    "PAYPAL_RECONCILIATION_RESOLVED",
    { paymentAttemptId: "attempt", paypalCaptureId: "capture" },
  ],
  [
    "PAYMENT_COMMITTED",
    { paymentAttemptId: "attempt", paypalCaptureId: "capture" },
  ],
];
function chain(input = events): DurableEvidence[] {
  const out: DurableEvidence[] = [];
  for (const [type, data] of input) {
    const unsigned = {
      id: `event-${out.length}`,
      sequence: out.length + 1,
      type,
      data,
      occurredAt: "2026-10-09T12:00:00.000Z",
      previousHash: out.at(-1)?.hash ?? null,
    };
    out.push({
      ...unsigned,
      hash: createHash("sha256").update(canonical(unsigned)).digest("hex"),
    });
  }
  return out;
}
describe("M3F independent read-only Trust Trace verification", () => {
  it("verifies represented review-to-payment relationships and an external head anchor", () => {
    const ledger = chain(),
      head = { sequence: ledger.length, hash: ledger.at(-1)!.hash };
    expect(verifyTrustTrace(ledger, head)).toEqual({
      valid: true,
      issues: [],
      head,
    });
    expect(verifyTrustTrace(ledger.slice(0, -1), head).issues).toEqual([
      "TRACE_ANCHOR_MISMATCH",
    ]);
    // Without an independently retained anchor, valid-tail truncation is not detectable.
    expect(verifyTrustTrace(ledger.slice(0, -1)).valid).toBe(true);
  });
  it.each(
    events
      .map(([name], index) => [name, index] as const)
      .filter(([, index]) => [0, 1, 3, 4, 5, 6, 9].includes(index)),
  )(
    "detects missing prerequisite %s even after chain recomputation",
    (_, index) => {
      const omitted = events.filter((_, i) => i !== index);
      expect(verifyTrustTrace(chain(omitted)).valid).toBe(false);
    },
  );
  it.each([0, 1, 2, 3, 4, 5, 6, 9, 10])(
    "detects duplicate logical event %s with a valid recomputed hash chain",
    (index) => {
      const input = [...events];
      input.splice(index + 1, 0, events[index]!);
      expect(verifyTrustTrace(chain(input)).valid).toBe(false);
    },
  );
  it.each(["principalId", "agentId", "draftFingerprint", "reviewedHash"])(
    "rejects confirmation substitution %s",
    (field) => {
      const input = [...events];
      input[1] = [
        "HUMAN_CONFIRMATION_ACCEPTED",
        { ...binding, [field]: "substituted" },
      ];
      expect(verifyTrustTrace(chain(input)).issues).toEqual([
        "CONFIRMATION_BINDING_INVALID",
      ]);
    },
  );
  it("rejects a conflicting capture and dispatch after commitment", () => {
    const input = [...events];
    input[10] = [
      "PAYMENT_COMMITTED",
      { paymentAttemptId: "attempt", paypalCaptureId: "other" },
    ];
    expect(verifyTrustTrace(chain(input)).valid).toBe(false);
    expect(verifyTrustTrace(chain([...events, events[8]!])).issues).toEqual([
      "DISPATCH_TRACE_INVALID",
    ]);
  });
  it.each(["RELEASED", "FAILED", "EXPIRED"])(
    "rejects conflicting financial reservation outcome %s",
    (status) => {
      expect(
        verifyTrustTrace(
          chain([
            ...events,
            [`RESERVATION_${status}`, { reservationId: "reservation" }],
          ]),
        ).issues,
      ).toEqual(["RESERVATION_OUTCOME_CONFLICT"]);
      expect(
        verifyTrustTrace(
          chain([
            events[3]!,
            [`RESERVATION_${status}`, { reservationId: "reservation" }],
          ]),
        ).valid,
      ).toBe(true);
    },
  );
  it("rejects malformed, oversized, reordered and tampered records", () => {
    expect(verifyTrustTrace(null).valid).toBe(false);
    expect(verifyTrustTrace(new Array(100001)).valid).toBe(false);
    expect(verifyTrustTrace([{}]).valid).toBe(false);
    const ledger = chain();
    expect(verifyTrustTrace([...ledger].reverse()).valid).toBe(false);
    expect(
      verifyTrustTrace([
        { ...ledger[0], data: { ...binding, principalId: "attacker" } },
        ...ledger.slice(1),
      ]).valid,
    ).toBe(false);
    expect(
      verifyTrustTrace(chain([["DIAGNOSTIC", { text: "x".repeat(65536) }]]))
        .issues,
    ).toEqual(["TRACE_PAYLOAD_LIMIT"]);
    expect(
      verifyTrustTrace(
        chain([
          [
            "DIAGNOSTIC",
            Object.fromEntries(
              Array.from({ length: 101 }, (_, i) => [`key-${i}`, null]),
            ),
          ],
        ]),
      ).valid,
    ).toBe(false);
  });
  it("does not invent authority or semantic guarantees for unknown event types", () => {
    expect(
      verifyTrustTrace(chain([["FUTURE_DIAGNOSTIC", { opaque: true }]])).valid,
    ).toBe(true);
    expect(verifyTrustTrace([])).toEqual({
      valid: true,
      issues: [],
      head: { sequence: 0, hash: null },
    });
  });
});
