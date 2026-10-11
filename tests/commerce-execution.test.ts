import { describe, expect, it } from "vitest";
import {
  paypalCommerceRequest,
  verifyPayPalCommerce,
} from "../src/paypal-commerce.js";
import { PayPalOAuthClient, PayPalPaymentProvider } from "../src/paypal.js";
import { vi } from "vitest";
import type { PayPalOrderView } from "../src/paypal.js";
import { checkoutFixture } from "./checkout-fixture.js";
import { proposalDigest } from "../src/canonical.js";
import type { TransactionProposal } from "../src/domain.js";
import {
  COMMERCE_METADATA_KEYS,
  checkoutManifestFingerprint,
} from "../src/checkout-contracts.js";

function order(): PayPalOrderView {
  const { manifest: m } = checkoutFixture();
  const request = paypalCommerceRequest(m);
  return {
    id: "ORDER-1",
    status: "APPROVED",
    purchaseUnits: [
      {
        referenceId: "proposal",
        amountValue: "84.00",
        currency: "USD",
        payeeMerchantId: m.expectedPayPalMerchantId,
        customId: m.manifestId,
        items: request.items,
        breakdown: request.breakdown,
      },
    ],
    captures: [],
  };
}
describe("M4C provider conformance", () => {
  it("constructs supported exact Orders v2 fields from immutable terms", () => {
    const r = paypalCommerceRequest(checkoutFixture().manifest);
    expect(r).toMatchObject({
      payee: { merchant_id: "DEMOACCOUNT01" },
      items: [
        {
          quantity: "1",
          unit_amount: { value: "84.00", currency_code: "USD" },
          category: "PHYSICAL_GOODS",
        },
      ],
      breakdown: { item_total: { value: "84.00" } },
    });
    expect(() =>
      verifyPayPalCommerce(checkoutFixture().manifest, order()),
    ).not.toThrow();
  });
  it.each([
    "amount",
    "currency",
    "recipient",
    "missing-recipient",
    "sku",
    "quantity",
    "unit",
    "unit-currency",
    "description",
    "custom",
    "items",
    "breakdown",
    "extra-charge",
    "order-id",
  ])("rejects provider %s substitution", (attack) => {
    const o = structuredClone(order());
    const u = o.purchaseUnits[0]!;
    const item = u.items![0]!;
    const broken = { ...u, items: [{ ...item }] };
    if (attack === "amount") broken.amountValue = "184.00";
    if (attack === "currency") broken.currency = "EUR";
    if (attack === "recipient") broken.payeeMerchantId = "DEMOACCOUNT02";
    if (attack === "missing-recipient") delete broken.payeeMerchantId;
    if (attack === "sku") broken.items[0]!.sku = "PF-OTHER";
    if (attack === "quantity") broken.items[0]!.quantity = "10";
    if (attack === "unit")
      broken.items[0]!.unit_amount = { currency_code: "USD", value: "184.00" };
    if (attack === "unit-currency")
      broken.items[0]!.unit_amount = { currency_code: "EUR", value: "84.00" };
    if (attack === "description")
      broken.items[0]!.description = "USED;RED;BLACK;ANSI";
    if (attack === "custom") broken.customId = "other-manifest";
    if (attack === "items") broken.items = [];
    if (attack === "breakdown") broken.breakdown = {};
    if (attack === "extra-charge")
      broken.breakdown = {
        ...broken.breakdown,
        handling: { value: "10.00", currency_code: "USD" },
      };
    expect(() =>
      verifyPayPalCommerce(checkoutFixture().manifest, {
        ...o,
        id: attack === "order-id" ? "x".repeat(65) : o.id,
        purchaseUnits: [broken],
      }),
    ).toThrow();
  });
  it.each(["amount", "currency", "id", "order", "status"])(
    "rejects capture %s mismatch",
    (attack) => {
      const c = {
        id: "CAPTURE-1",
        status: "COMPLETED",
        amountValue: "84.00",
        currency: "USD",
        orderId: "ORDER-1",
      };
      if (attack === "amount") c.amountValue = "184.00";
      if (attack === "currency") c.currency = "EUR";
      if (attack === "id") c.id = "";
      if (attack === "order") c.orderId = "ORDER-2";
      if (attack === "status") c.status = "FAILED";
      expect(() =>
        verifyPayPalCommerce(
          checkoutFixture().manifest,
          { ...order(), status: "COMPLETED", captures: [c] },
          true,
        ),
      ).toThrow();
    },
  );
  it("real adapter serializes exact fields and retains provider-attested item/payee data", async () => {
    const m = checkoutFixture().manifest,
      request = paypalCommerceRequest(m);
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        await Promise.resolve();
        if (
          (typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url
          ).includes("oauth2")
        )
          return new Response(
            JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
          );
        if (typeof init?.body !== "string")
          throw new Error("EXPECTED_JSON_BODY");
        body = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "ORDER-1",
            status: "APPROVED",
            purchase_units: [
              {
                reference_id: "proposal",
                amount: {
                  value: "84.00",
                  currency_code: "USD",
                  breakdown: request.breakdown,
                },
                payee: request.payee,
                custom_id: request.custom_id,
                items: request.items,
              },
            ],
          }),
        );
      },
    );
    const provider = new PayPalPaymentProvider(
      new PayPalOAuthClient("test-client", "test-secret", fetcher),
      fetcher,
    );
    const view = await provider.createOrder({
      amountValue: "84.00",
      currency: "USD",
      merchantReference: "proposal",
      requestId: "stable-key",
      commerce: request,
    });
    expect(body).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "proposal",
          amount: {
            value: "84.00",
            currency_code: "USD",
            breakdown: request.breakdown,
          },
          payee: request.payee,
          custom_id: request.custom_id,
          items: request.items,
        },
      ],
    });
    expect(() => verifyPayPalCommerce(m, view)).not.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("proposal digest cryptographically includes reserved metadata", () => {
    const { manifest: m } = checkoutFixture();
    const p: TransactionProposal = {
      id: "p",
      agentId: m.owner.agentId,
      mandateId: m.owner.mandateId,
      mandateFingerprint: m.owner.mandateFingerprint,
      amount: { minor: 8400, currency: "USD" },
      quantity: 1,
      merchant: { id: m.logicalMerchantId, displayName: "Demo" },
      category: "KEYBOARD",
      condition: "NEW",
      requestedCapability: "CAPTURE_PAYMENT",
      proposedAt: m.quotedAt,
      nonce: "proposal-nonce-123",
      metadata: {
        [COMMERCE_METADATA_KEYS.id]: m.manifestId,
        [COMMERCE_METADATA_KEYS.version]: m.version,
        [COMMERCE_METADATA_KEYS.fingerprint]: checkoutManifestFingerprint(m),
      },
    };
    for (const key of Object.values(COMMERCE_METADATA_KEYS))
      expect(
        proposalDigest({
          ...p,
          metadata: { ...p.metadata, [key]: "substitution" },
        }),
      ).not.toBe(proposalDigest(p));
    expect(proposalDigest({ ...p, metadata: {} })).not.toBe(proposalDigest(p));
  });
});
