import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivationSurface } from "../app/activation-panel";
for (const status of ["PREPARING", "CONFIRMING", "VERIFYING", "ERROR"])
  test(`M5C ${status} has no active authority`, () => {
    const html = renderToStaticMarkup(
      <ActivationSurface state={{ status, pending: null, authority: null }} />,
    );
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /Authority active|Activating payment/);
  });
test("exact focused confirmation sheet shows terms and financial consequence", () => {
  const html = renderToStaticMarkup(
    <ActivationSurface
      state={{
        status: "PENDING",
        authority: null,
        pending: {
          status: "PENDING_REVIEW",
          mode: "NON_PRODUCTION_DEMO",
          authority: "NOT_YET_AUTHORIZED",
          source: "Buy a keyboard",
          reviewId: "r",
          displayHash: "a".repeat(64),
          agentName: "Shopping Agent",
          expiresAt: "2026-10-23T10:05:00.000Z",
          terms: [
            { label: "Maximum spend", value: "$100" },
            { label: "Quantity", value: "1" },
          ],
        },
      }}
    />,
  );
  assert.match(html, /Not yet authorized/);
  assert.match(html, /Shopping Agent/);
  assert.match(html, /Maximum spend/);
  assert.match(html, /financial authority within these exact limits/);
  assert.doesNotMatch(html, /Authority active/);
});
test("active wallet renders durable values and no payment claim", () => {
  const html = renderToStaticMarkup(
    <ActivationSurface
      state={{
        status: "ACTIVE",
        pending: null,
        authority: {
          version: "payflow.authority-view.v1",
          mandateId: "m",
          state: "ACTIVE",
          agent: { id: "a", displayName: "Shopping Agent", status: "ACTIVE" },
          purpose: "Keyboard purchase",
          currency: "USD",
          singleMaximumMinor: 10000,
          remainingMinor: 10000,
          quantityRemaining: 1,
          allowedConditions: ["NEW"],
          merchantScopeSummary: "Only Amazon",
          expiresAt: "2026-10-24T00:00:00.000Z",
        },
      }}
    />,
  );
  assert.match(html, /Authority active/);
  assert.match(html, /\$100.00 remaining/);
  assert.match(html, /does not execute a payment/);
});
