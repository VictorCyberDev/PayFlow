import { describe, expect, it } from "vitest";
import {
  DeterministicFakeRail,
  financialActionDigest,
} from "../src/network/rail.js";
import {
  evaluateExternalIssuerAssertion,
  federatedVerify,
} from "../src/network/federation.js";
import {
  evaluateMachineEconomicAction,
  type MachineAuthority,
} from "../src/network/machine-authority.js";
import {
  MODEL_EVAL_DATASET,
  scoreModelEval,
} from "../src/protocols/model-eval.js";
import { FinancialActionSchema } from "../src/network/financial-action.js";

describe("launch security review regressions", () => {
  it("invalid rail time cannot bypass grant expiry", async () => {
    const action = FinancialActionSchema.parse({
      version: "financial-action/v1",
      id: "review",
      kind: "PURCHASE",
      principalId: "p",
      agentId: "a",
      counterparty: { id: "m" },
      amount: { currency: "USD", minor: 84 },
      purpose: "review",
      proposedAt: "2026-10-29T00:00:00Z",
      idempotencyKey: "review-idempotency-001",
    });
    const rail = new DeterministicFakeRail("test", "SUCCESS");
    await expect(
      rail.execute({
        action,
        grant: {
          grantId: "g",
          authorityId: "auth",
          actionDigest: financialActionDigest(action),
          idempotencyKey: action.idempotencyKey,
          expiresAt: "invalid",
        },
        now: "invalid",
      }),
    ).rejects.toThrow("EXECUTION_GRANT_INVALID_TIME");
    expect(rail.providerEffectWrites).toBe(0);
  });
  it("federation invalid clock/stale metadata and remote failures never produce VALID", async () => {
    const domains = new Map([
      [
        "issuer",
        {
          issuer: "issuer",
          status: "TRUSTED" as const,
          metadataFreshUntil: "invalid",
          verify: () => Promise.resolve({ verdict: "VALID" }),
        },
      ],
    ]);
    expect(
      (await federatedVerify(domains, "issuer", {}, "aud", "invalid")).verdict,
    ).toBe("STALE_METADATA");
    expect(
      evaluateExternalIssuerAssertion({}, {}, "aud", "invalid").trusted,
    ).toBe(false);
    domains.set("issuer", {
      issuer: "issuer",
      status: "TRUSTED",
      metadataFreshUntil: "2099-01-01T00:00:00Z",
      verify: () => Promise.reject(new Error("remote secret detail")),
    });
    expect(
      (
        await federatedVerify(
          domains,
          "issuer",
          {},
          "aud",
          "2026-10-29T00:00:00Z",
        )
      ).verdict,
    ).toBe("INVALID");
  });
  it("machine input cannot use NaN or negative trusted counters to bypass amount and velocity", () => {
    const authority: MachineAuthority = {
      authorityId: "a",
      sponsorPrincipalId: "p",
      machineIdentity: "m",
      allowedPurposes: ["x"],
      allowedResourceKinds: ["API"],
      currency: "USD",
      maxSingleActionMinor: 100,
      maxTotalMinor: 100,
      maxActionsPerHour: 1,
      expiresAt: "2027-01-01T00:00:00Z",
    };
    const action = {
      machineIdentity: "m",
      purpose: "x",
      resourceKind: "API" as const,
      amountMinor: 84,
      currency: "USD",
      proposedAt: "2026-10-29T00:00:00Z",
    };
    expect(
      evaluateMachineEconomicAction(authority, action, {
        cumulativeSpentMinor: -100,
        actionsInPreviousHour: -1,
        now: "invalid",
      }),
    ).toContain("INVALID_MACHINE_CONTEXT");
  });
  it("eval metrics refuse missing or duplicate results instead of manufacturing scores", () => {
    expect(MODEL_EVAL_DATASET.length).toBeGreaterThanOrEqual(35);
    expect(() => scoreModelEval(MODEL_EVAL_DATASET, [])).toThrow(
      "EVAL_INCOMPLETE_OR_DUPLICATE",
    );
  });
});

import { ReconciliationOperationsCenter } from "../src/network/reconciliation-ops.js";
import { mayAssumeReservationOwnership } from "../src/network/region.js";
import { evaluateApprovalEvidence } from "../src/network/enterprise.js";
it("wrong provider reference cannot resolve a different reconciliation case", async () => {
  let writes = 0;
  const center = new ReconciliationOperationsCenter(
    {
      load: () =>
        Promise.resolve({
          id: "c",
          attemptId: "a",
          railId: "expected",
          idempotencyKey: "original-key",
          state: "PENDING",
          openedAt: "2026-10-29T00:00:00Z",
          updatedAt: "2026-10-29T00:00:00Z",
          evidence: [],
        }),
      compareAndSet: () => {
        writes++;
        return Promise.resolve(true);
      },
    },
    new Map([
      [
        "expected",
        {
          railId: "expected",
          execute: () => Promise.reject(new Error("must never execute")),
          lookup: () =>
            Promise.resolve({
              rail: "wrong",
              idempotencyKey: "another-key",
              state: "SUCCEEDED",
              effectCount: 1,
              observedAt: "2026-10-29T01:00:00Z",
              reason: "provider",
            }),
        },
      ],
    ]),
  );
  await expect(center.investigate("c", "2026-10-29T01:00:00Z")).rejects.toThrow(
    "RECONCILIATION_EVIDENCE_BINDING_MISMATCH",
  );
  expect(writes).toBe(0);
});
it("NaN epoch and negative approval amount cannot bypass boundaries", () => {
  expect(
    mayAssumeReservationOwnership(
      {
        reservationId: "r",
        authorityId: "a",
        ownerRegion: "eu",
        epoch: 1,
        leaseExpiresAt: "2026-01-01T00:00:00Z",
      },
      "us",
      NaN,
      "2026-10-29T00:00:00Z",
    ),
  ).toBe(false);
  expect(
    evaluateApprovalEvidence(
      {
        id: "p",
        requiredRoles: ["FINANCE_OWNER"],
        minimumApprovals: 1,
        forbidSelfApproval: true,
        thresholdMinor: 100,
      },
      { requesterPrincipalId: "p", actionDigest: "digest", amountMinor: -1 },
      [],
    ).approved,
  ).toBe(false);
});
