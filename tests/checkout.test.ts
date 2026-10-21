import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { proposalDigest } from "../src/canonical.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  CheckoutQuoteSchema,
  CheckoutManifestSchema,
  canonicalCheckoutManifest,
  checkoutQuoteFingerprint,
  checkoutManifestFingerprint,
  freezeCheckout,
  COMMERCE_METADATA_KEYS,
  hasCommerceMetadata,
} from "../src/checkout-contracts.js";
import { checkoutFixture } from "./checkout-fixture.js";

describe("M4B immutable complete checkout contracts", () => {
  it("binds explicit zero demo charges, exact offer/binding fingerprints and owner", () => {
    const { quote, manifest } = checkoutFixture();
    expect(quote.totalMinor).toBe(8400);
    expect(quote).toMatchObject({
      taxMinor: 0,
      shippingMinor: 0,
      customerDiscountMinor: 0,
      customerFeeMinor: 0,
    });
    expect(manifest.merchantBindingFingerprint).toBe(
      quote.merchantBindingFingerprint,
    );
    expect(manifest.controlledOfferFingerprint).toBe(
      quote.controlledOfferFingerprint,
    );
    expect(manifest.owner.principalId).toBe("commerce-p");
  });
  it("validates complete nonzero charges without treating discovery price as total", () => {
    const { quote } = checkoutFixture();
    expect(
      CheckoutQuoteSchema.parse({
        ...quote,
        unitAmountMinor: 9500,
        subtotalMinor: 9500,
        shippingMinor: 1200,
        totalMinor: 10700,
      }).totalMinor,
    ).toBe(10700);
    expect(
      CheckoutQuoteSchema.safeParse({
        ...quote,
        subtotalMinor: 9500,
        unitAmountMinor: 9500,
        shippingMinor: 1200,
        totalMinor: 9500,
      }).success,
    ).toBe(false);
    expect(
      CheckoutQuoteSchema.parse({
        ...quote,
        taxMinor: 20,
        shippingMinor: 30,
        customerFeeMinor: 40,
        customerDiscountMinor: 10,
        totalMinor: 8480,
      }).totalMinor,
    ).toBe(8480);
  });
  it.each([
    { quantity: 0 },
    { quantity: 1.5 },
    { quantity: 1001 },
    { unitAmountMinor: -1 },
    { totalMinor: 0 },
    { subtotalMinor: 8399 },
    { taxMinor: -1 },
    { shippingMinor: -1 },
    { customerFeeMinor: -1 },
    { customerDiscountMinor: -1 },
    { taxMinor: undefined },
    { shippingMinor: undefined },
    { customerFeeMinor: undefined },
    { customerDiscountMinor: undefined },
    { currency: "XXX" },
    { currency: "usd" },
    { currency: "ＵＳＤ" },
    { currency: { unit: "USD", total: "EUR" } },
    { unitAmountMinor: 84.01 },
    { totalMinor: Number.MAX_SAFE_INTEGER + 1 },
    {
      unitAmountMinor: Number.MAX_SAFE_INTEGER,
      quantity: 2,
      subtotalMinor: Number.MAX_SAFE_INTEGER,
      totalMinor: Number.MAX_SAFE_INTEGER,
    },
    { customerDiscountMinor: 9000 },
    { customerFeeMinor: Number.MAX_SAFE_INTEGER },
    { quotedAt: "yesterday" },
    { expiresAt: "2026-10-11T00:00:00.000Z" },
    { quotedAt: "2026-10-11T00:00:00Z" },
    { expiresAt: "2026-10-11T00:05:00.001Z" },
    { condition: "UNKNOWN" },
    { condition: "OPEN_BOX" },
    { condition: "LIKE_NEW" },
    { version: "payflow.checkout-quote.v2" },
    { version: undefined },
    { hiddenChargeMinor: 1200 },
    { authorized: true },
    { expectedPayPalMerchantId: "DEMOACCOUNT01" },
    { sku: "" },
    { sku: "PF-ＫＢ" },
    { offerId: "a".repeat(97) },
    { provenanceReference: "x".repeat(201) },
    {
      variant: {
        switchType: "BROWN",
        finish: "BLACK",
        layout: "ANSI",
        quantity: 10,
      },
    },
  ])(
    "rejects malformed, ambiguous or contradictory quote terms: %j",
    (change) => {
      const { quote } = checkoutFixture();
      expect(() => checkoutQuoteFingerprint({ ...quote, ...change })).toThrow();
    },
  );
  it.each([
    { expectedPayPalMerchantId: "OTHERACCOUNT1" },
    { merchantBindingFingerprint: "a".repeat(64) },
    { merchantBindingRevision: 2 },
    { controlledOfferFingerprint: "b".repeat(64) },
    { catalogRevision: 2 },
    { sku: "PF-KB-OTHER" },
    { variant: { switchType: "RED", finish: "GREY", layout: "ANSI" } },
    { condition: "USED" },
    { currency: "EUR" },
    { unitAmountMinor: 18400, subtotalMinor: 18400, totalMinor: 18400 },
    { unitAmountMinor: 8300, subtotalMinor: 8300, totalMinor: 8300 },
    { quantity: 2, subtotalMinor: 16800, totalMinor: 16800 },
    { shippingMinor: 1200, totalMinor: 9600 },
    { quoteExpiresAt: "2026-10-11T00:04:00.000Z" },
    { quoteId: "00000000-0000-4000-8000-000000000099" },
    { manifestId: "00000000-0000-4000-8000-000000000099" },
  ])(
    "changes exact manifest identity for security-relevant mutation: %j",
    (change) => {
      const { manifest } = checkoutFixture();
      expect(checkoutManifestFingerprint({ ...manifest, ...change })).not.toBe(
        checkoutManifestFingerprint(manifest),
      );
    },
  );
  it.each(["principalId", "agentId", "mandateId", "mandateFingerprint"])(
    "binds owner %s",
    (field) => {
      const { manifest } = checkoutFixture();
      const value =
        field === "mandateFingerprint" ? "c".repeat(64) : "other-owner";
      expect(
        checkoutManifestFingerprint({
          ...manifest,
          owner: { ...manifest.owner, [field]: value },
        }),
      ).not.toBe(checkoutManifestFingerprint(manifest));
    },
  );
  it("strict manifest validation rejects recipient/live/extra-field assertions", () => {
    const { manifest } = checkoutFixture();
    for (const change of [
      { environment: "live" },
      { expectedPayPalMerchantId: "" },
      { approved: true },
      { version: "payflow.checkout-manifest.v2" },
      { quoteVersion: "v2" },
      { logicalMerchantId: "Amazon" },
      { checkoutSourceId: "external" },
    ])
      expect(
        CheckoutManifestSchema.safeParse({ ...manifest, ...change }).success,
      ).toBe(false);
  });
  it("canonicalizes property order with explicit domain separation and freezes nested terms", () => {
    const { manifest, quote } = checkoutFixture();
    const reverse = Object.fromEntries(Object.entries(manifest).reverse());
    reverse.variant = { layout: "ANSI", finish: "BLACK", switchType: "BROWN" };
    expect(checkoutManifestFingerprint(reverse)).toBe(
      checkoutManifestFingerprint(manifest),
    );
    expect(checkoutManifestFingerprint(manifest)).toBe(
      createHash("sha256")
        .update(
          "payflow:checkout-manifest:v1\n" +
            canonicalCheckoutManifest(manifest),
        )
        .digest("hex"),
    );
    expect(checkoutManifestFingerprint(manifest)).not.toBe(
      checkoutQuoteFingerprint(quote),
    );
    freezeCheckout(manifest);
    expect(() => {
      manifest.variant.finish = "GREY";
    }).toThrow();
    expect(() => {
      manifest.owner.principalId = "other";
    }).toThrow();
  });
  it("reserves the entire metadata namespace without trusting caller assertions", async () => {
    const { manifest } = checkoutFixture();
    expect(
      hasCommerceMetadata({ [COMMERCE_METADATA_KEYS.id]: manifest.manifestId }),
    ).toBe(true);
    expect(
      hasCommerceMetadata({ "payflow.commerce.expectedRecipient": "fake" }),
    ).toBe(true);
    expect(hasCommerceMetadata({ note: "inert" })).toBe(false);
    const repo = PostgresTrustRepository.connect("postgres://not-used");
    const p = {
      id: "p",
      agentId: manifest.owner.agentId,
      mandateId: manifest.owner.mandateId,
      mandateFingerprint: manifest.owner.mandateFingerprint,
      amount: { minor: 8400, currency: "USD" },
      quantity: 1,
      merchant: { id: manifest.logicalMerchantId, displayName: "Demo" },
      category: "KEYBOARD",
      condition: "NEW" as const,
      requestedCapability: "CAPTURE_PAYMENT" as const,
      proposedAt: manifest.quotedAt,
      nonce: "proposal-nonce-test-1",
      metadata: { [COMMERCE_METADATA_KEYS.id]: manifest.manifestId },
    };
    // No connection is made: reject before SQL, not a simulated database pass.
    await expect(repo.saveProposal(p)).rejects.toThrow(
      "RESERVED_COMMERCE_METADATA",
    );
    await repo.close();
    const linked = {
      ...p,
      metadata: {
        ...p.metadata,
        [COMMERCE_METADATA_KEYS.version]: manifest.version,
        [COMMERCE_METADATA_KEYS.fingerprint]:
          checkoutManifestFingerprint(manifest),
      },
    };
    expect(proposalDigest(linked)).not.toBe(
      proposalDigest({
        ...linked,
        metadata: {
          ...linked.metadata,
          [COMMERCE_METADATA_KEYS.fingerprint]: "d".repeat(64),
        },
      }),
    );
  });
  it("checkout service has no financial dispatch, grant issuance or authorization calls", async () => {
    const source = await readFile("src/checkout.ts", "utf8");
    expect(source).not.toMatch(
      /\b(fetch|authorizeProposal|createReservation|issueGrant|captureOrder|createOrder|activateReviewedIntent)\s*\(/,
    );
    expect(source).not.toContain("./paypal.js");
    expect(source).not.toContain("./execution-grant.js");
  });
});
