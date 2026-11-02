import { describe, expect, it } from "vitest";
import { createPublicVerifyRestHandler } from "../src/network/verify-rest.js";
import {
  acceptWebhookDeliveryOnce,
  signWebhookDelivery,
  type PayFlowEvent,
} from "../src/network/events.js";

describe("M21 public Verify REST surface", () => {
  it("routes read-only verification through quotas and stable HTTP semantics", async () => {
    const handler = createPublicVerifyRestHandler({
      now: () => "2026-10-28T03:00:00.000Z",
      consumeQuota: async () => ({
        allowed: true,
        remaining: 9,
        resetAt: "2026-10-28T04:00:00.000Z",
      }),
      verifyPresentation: async () => ({ verdict: "VALID" }),
    });
    const response = await handler({
      method: "POST",
      path: "/v1/verify/presentations",
      headers: { "X-PayFlow-Verifier-Client": "merchant-1" },
      body: { presentation: { signed: true } },
    });
    expect(response.status).toBe(200);
    expect(response.headers["x-ratelimit-remaining"]).toBe("9");
    expect(response.body).toEqual({ verdict: "VALID" });
  });

  it("fails closed when verifier identity is absent", async () => {
    const handler = createPublicVerifyRestHandler({
      now: () => "2026-10-28T03:00:00.000Z",
      consumeQuota: async () => {
        throw new Error("quota must not be called");
      },
      verifyPresentation: async () => ({ verdict: "VALID" }),
    });
    const response = await handler({
      method: "POST",
      path: "/v1/verify/presentations",
      body: { presentation: {} },
    });
    expect(response.status).toBe(400);
  });
});

describe("M7/M14 signed webhook events", () => {
  const event: PayFlowEvent = {
    version: "payflow-event/v1",
    id: "evt-1",
    type: "proof.available",
    organizationId: "org-1",
    environment: "SANDBOX",
    occurredAt: "2026-10-28T03:00:00.000Z",
    subjectId: "proof-1",
    data: { outcome: "SUCCEEDED", effectCount: 1 },
  };

  it("authenticates event bodies and treats duplicate delivery idempotently", async () => {
    const secret = "local-test-webhook-secret-not-production";
    const signed = signWebhookDelivery(
      event,
      secret,
      "delivery-1",
      "2026-10-28T03:00:00.000Z",
    );
    const claimed = new Set<string>();
    const store = {
      claimDelivery: async (deliveryId: string) => {
        if (claimed.has(deliveryId)) return false;
        claimed.add(deliveryId);
        return true;
      },
    };
    expect(
      await acceptWebhookDeliveryOnce(
        event,
        signed,
        secret,
        "2026-10-28T03:01:00.000Z",
        store,
      ),
    ).toBe("ACCEPTED");
    expect(
      await acceptWebhookDeliveryOnce(
        event,
        signed,
        secret,
        "2026-10-28T03:01:00.000Z",
        store,
      ),
    ).toBe("DUPLICATE");
    expect(
      await acceptWebhookDeliveryOnce(
        { ...event, subjectId: "tampered" },
        signed,
        secret,
        "2026-10-28T03:01:00.000Z",
        store,
      ),
    ).toBe("INVALID");
  });
});
