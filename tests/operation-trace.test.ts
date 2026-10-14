import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  traceOverall,
  TraceStageSchema,
  OperationTraceSchema,
} from "../src/operation-trace.js";
import {
  verifyHistoricalExecutionGrant,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import {
  ProviderObservationSchema,
  providerObservationFingerprint,
  AuthorizationMaterialSchema,
} from "../src/trace-material.js";
import {
  securityExplanation,
  AdversarialResultSchema,
  BREAK_PAYFLOW_ATTACKS,
  runBreakPayFlow,
} from "../src/adversarial-projection.js";
import { RankingMaterialSchema } from "../src/discovery-proof.js";
import { checkoutAuthority } from "./checkout-fixture.js";
import { canonicalDurableValue } from "../src/persistence.js";
const keys = generateKeyPairSync("ed25519"),
  ring = new StaticPublicKeyRing(new Map([["proof", keys.publicKey]]));
const claims = {
  version: "payflow.execution-grant.v1",
  jti: "00000000-0000-4000-8000-000000000001",
  kid: "proof",
  principalId: "p",
  agentId: "a",
  mandateId: "m",
  mandateFingerprint: "a".repeat(64),
  proposalId: "proposal",
  proposalDigest: "b".repeat(64),
  receiptId: "receipt",
  reservationId: "reservation",
  capability: "CAPTURE_PAYMENT",
  amountMinor: 8400,
  currency: "USD",
  merchantId: "payflow.demo.merchant",
  issuedAt: "2026-10-11T00:00:00.000Z",
  expiresAt: "2026-10-11T00:02:00.000Z",
  authorizationEngineVersion: "payflow-trust-kernel/1.0",
  audience: "payflow.payment-execution",
};
const payload = canonicalDurableValue(claims),
  token =
    Buffer.from(payload).toString("base64url") +
    "." +
    sign(null, Buffer.from(payload), keys.privateKey).toString("base64url");
describe("M4F trace proof and output contracts", () => {
  it("VERIFIED no-effect failure requires an explicit verified finalization stage and never means CAPTURED", () => {
    const stages = [
      {
        stage: "FINANCIAL_FINALIZATION",
        status: "VERIFIED" as const,
        reasonCode: "PROVEN_NO_EFFECT_CREATE_REJECTION",
      },
    ];
    expect(traceOverall(stages, "FAILED")).toBe("VERIFIED");
    expect(traceOverall([], "FAILED")).toBe("INCOMPLETE");
    expect(traceOverall(stages, "ORDER_CREATE_UNKNOWN")).toBe(
      "UNKNOWN_FINANCIAL_OUTCOME",
    );
    expect(traceOverall([{ ...stages[0]!, status: "INVALID" }], "FAILED")).toBe(
      "INVALID",
    );
  });
  it("verifies an expired historical signed delegation without permitting execution", () => {
    expect(verifyHistoricalExecutionGrant(token, ring).proposalDigest).toBe(
      claims.proposalDigest,
    );
  });
  it.each([
    "proposalDigest",
    "reservationId",
    "capability",
    "expiresAt",
    "principalId",
    "amountMinor",
    "currency",
    "merchantId",
  ])("rejects signed %s mutation", (key) => {
    const changed = {
      ...claims,
      [key]: key === "amountMinor" ? 18400 : "tampered",
    };
    const bad =
      Buffer.from(canonicalDurableValue(changed)).toString("base64url") +
      "." +
      token.split(".")[1];
    expect(() => verifyHistoricalExecutionGrant(bad, ring)).toThrow(
      "GRANT_PROOF_INVALID",
    );
  });
  it.each(["", "tampered", "a.b.c", "x".repeat(8193)])(
    "rejects malformed/oversized token",
    (t) => expect(() => verifyHistoricalExecutionGrant(t, ring)).toThrow(),
  );
  it("missing retained public key is explicitly unavailable, not fabricated signature proof", () =>
    expect(() =>
      verifyHistoricalExecutionGrant(token, new StaticPublicKeyRing(new Map())),
    ).toThrow("GRANT_PROOF_KEY_UNAVAILABLE"));
  it.each([
    "CAPTURE_UNKNOWN",
    "ORDER_CREATE_UNKNOWN",
    "CAPTURE_IN_FLIGHT",
    "ORDER_CREATING",
    "CAPTURE_PENDING_PROVIDER",
  ])("%s is not a completed verified payment", (s) =>
    expect(traceOverall([], s)).toBe("UNKNOWN_FINANCIAL_OUTCOME"),
  );
  it.each(["PAYER_ACTION_REQUIRED", "ORDER_CREATED", "AUTHORIZED", "DENIED"])(
    "%s remains incomplete as a full completed trace",
    (s) => expect(traceOverall([], s)).toBe("INCOMPLETE"),
  );
  it("INVALID takes precedence over financial UNKNOWN; legacy is not fake verification", () => {
    const stages = [
      { stage: "integrity", status: "INVALID" as const, reasonCode: "CORRUPT" },
    ];
    expect(traceOverall(stages, "CAPTURE_UNKNOWN")).toBe("INVALID");
    expect(traceOverall([], "CAPTURED", true)).toBe("LEGACY");
    expect(traceOverall([], "CAPTURED")).toBe("VERIFIED");
  });
  it("bounded stage schema rejects arbitrary reasons/payloads", () => {
    expect(
      TraceStageSchema.safeParse({
        stage: "x",
        status: "VERIFIED",
        reasonCode: "raw token: secret",
      }).success,
    ).toBe(false);
    expect(
      TraceStageSchema.safeParse({ stage: "x", status: "OK", reasonCode: "OK" })
        .success,
    ).toBe(false);
    expect(OperationTraceSchema.safeParse({ verified: true }).success).toBe(
      false,
    );
  });
  it("provider snapshots exclude URLs, credentials and unbounded representations", () => {
    const raw = {
      id: "ORDER",
      status: "APPROVED",
      purchaseUnits: [],
      captures: [],
    };
    expect(
      ProviderObservationSchema.safeParse({
        ...raw,
        access_token: "distinct-oauth-token",
      }).success,
    ).toBe(false);
    expect(
      ProviderObservationSchema.safeParse({
        ...raw,
        payerActionUrl: "https://sandbox.paypal.com/?token=secret",
      }).success,
    ).toBe(false);
    expect(providerObservationFingerprint(raw)).not.toBe(
      providerObservationFingerprint({ ...raw, status: "COMPLETED" }),
    );
    expect(
      ProviderObservationSchema.safeParse({
        ...raw,
        purchaseUnits: Array(11).fill({ referenceId: "r" }),
      }).success,
    ).toBe(false);
  });
  it("provider fingerprint survives PostgreSQL object-key reordering", () => {
    const amount = { value: "84.00", currency_code: "USD" };
    const observation = {
      id: "ORDER",
      status: "APPROVED",
      captures: [],
      purchaseUnits: [
        {
          referenceId: "proposal",
          breakdown: {
            item_total: amount,
            shipping: { ...amount, value: "0.00" },
          },
        },
      ],
    };
    const reordered = structuredClone(observation);
    reordered.purchaseUnits[0]!.breakdown = {
      shipping: observation.purchaseUnits[0]!.breakdown.shipping,
      item_total: amount,
    };
    expect(providerObservationFingerprint(observation)).toBe(
      providerObservationFingerprint(reordered),
    );
  });
  it("authorization replay context is bounded to existing policy inputs", () => {
    expect(
      AuthorizationMaterialSchema.safeParse({
        agent: checkoutAuthority().agent,
        context: {
          now: "2026-10-11T00:00:00.000Z",
          merchantRisk: "LOW",
          cumulativeSpentMinor: 0,
          replaySeen: false,
          authorized: true,
        },
      }).success,
    ).toBe(false);
  });
  it("ranking material cannot claim a globally reusable or absent candidate set", () => {
    expect(
      RankingMaterialSchema.safeParse({
        requestId: "request",
        candidates: [],
        selectedCandidateId: "invented",
      }).success,
    ).toBe(false);
  });
  it("37 attack IDs produce bounded deterministic explanations and truthful measured projections", async () => {
    expect(BREAK_PAYFLOW_ATTACKS).toHaveLength(37);
    const r = await runBreakPayFlow("LOST_CAPTURE", () =>
      Promise.resolve({
        threatBoundary: "RECONCILIATION",
        expectedDefense: "Original operation identity",
        result: "RECONCILED",
        stoppedAt: "COMMITTED",
        financialSideEffect: true,
        providerCreateCalls: 1,
        providerCaptureCalls: 1,
        traceStatus: "VERIFIED",
        reasonCode: "CAPTURE_RECONCILED",
      }),
    );
    expect(r.providerCaptureCalls).toBe(1);
    expect(
      AdversarialResultSchema.safeParse({ ...r, access_token: "secret" })
        .success,
    ).toBe(false);
    expect(securityExplanation("CAPTURE_RECONCILED")).toContain(
      "without another capture",
    );
    expect(securityExplanation("invented raw input")).not.toContain(
      "invented raw input",
    );
  });
});
