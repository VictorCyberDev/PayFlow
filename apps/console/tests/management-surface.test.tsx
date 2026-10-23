import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagementSurface } from "../app/management-panel";
import type {
  ManagedAuthority,
  ManagementState,
  ActivityView,
} from "../lib/management-client.mjs";
const a: ManagedAuthority = {
  version: "payflow.authority-view.v1",
  mandateId: "m",
  state: "ACTIVE",
  agent: { id: "a", displayName: "Shopping Agent", status: "ACTIVE" },
  purpose: "Keyboard purchase",
  currency: "USD",
  singleMaximumMinor: 10000,
  cumulativeLimitMinor: 10000,
  committedMinor: 8400,
  reservedMinor: 0,
  remainingMinor: 1600,
  quantityLimit: 1,
  quantityRemaining: 0,
  merchantScopeSummary: "Only Demo Merchant",
  allowedConditions: ["NEW"],
  allowedCapabilities: ["CAPTURE_PAYMENT"],
  autonomousThresholdMinor: 10000,
  humanApprovalThresholdMinor: 10000,
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  observedAt: "2026-10-23T10:00:00.000Z",
  freshDispatchBlocked: null,
};
const state: ManagementState = {
  status: "READY",
  authorities: [a],
  activity: [],
  selected: null,
  error: null,
};
const activity: ActivityView = {
  operationId: "op",
  mandateId: "m",
  agentId: "a",
  agentName: "Shopping Agent",
  occurredAt: "2026-10-23T10:00:00.000Z",
  observedAt: "2026-10-23T10:01:00.000Z",
  status: "UNKNOWN_FINANCIAL_OUTCOME",
  label: "Payment still being verified",
  explanation: "We have not confirmed the final provider outcome yet.",
  decision: "ALLOW",
  amountMinor: 8400,
  currency: "USD",
  merchant: "Demo Merchant",
  item: "Keyboard",
  moneyMoved: "UNKNOWN",
  verification: "UNKNOWN_FINANCIAL_OUTCOME",
  stages: [
    {
      stage: "PROVIDER",
      status: "INCOMPLETE",
      reasonCode: "PROVIDER_UNCERTAIN",
    },
  ],
  references: {
    paymentAttemptId: "attempt",
    providerOrderId: "order",
    providerCaptureId: null,
  },
};
test("durable wallet includes readable limits and progressive verification", () => {
  const html = renderToStaticMarkup(<ManagementSurface state={state} />);
  for (const text of [
    "Active",
    "Shopping Agent",
    "$100.00",
    "$16.00 remaining",
    "Committed",
    "Currently reserved",
    "Quantity",
    "Human approval threshold",
    "Created",
    "Expires",
    "Technical references",
    "Revoke authority",
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Suspend authority|Refund/);
});
test("focused revoke sheet states exact consequence and cancel", () => {
  const html = renderToStaticMarkup(
    <ManagementSurface
      state={{ ...state, status: "CONFIRM_REVOKE", selected: "m" }}
    />,
  );
  assert.match(html, /Revoke this authority\?/);
  assert.match(html, /Existing completed payments are not reversed/);
  assert.match(html, /Keep authority/);
});
for (const status of ["REVOKING", "VERIFYING"])
  test(`${status} has no premature revoked claim`, () => {
    const html = renderToStaticMarkup(
      <ManagementSurface state={{ ...state, status }} />,
    );
    assert.match(html, /Active/);
    assert.doesNotMatch(html, /Authority revoked\./);
  });
test("durable revoked state blocks fresh dispatch and preserves historical payment truth", () => {
  const html = renderToStaticMarkup(
    <ManagementSurface
      state={{
        ...state,
        authorities: [{ ...a, state: "REVOKED", freshDispatchBlocked: true }],
      }}
    />,
  );
  assert.match(html, /Authority revoked/);
  assert.match(html, /Completed payments are not reversed/);
  assert.doesNotMatch(html, /revoke-button/);
});
test("paused passport is readable without inventing a mandate pause control", () => {
  const html = renderToStaticMarkup(
    <ManagementSurface
      state={{
        ...state,
        authorities: [
          {
            ...a,
            state: "UNAVAILABLE",
            agent: { ...a.agent, status: "SUSPENDED" },
            freshDispatchBlocked: true,
          },
        ],
      }}
    />,
  );
  assert.match(html, /Paused/);
  assert.match(html, /saved agent passport is paused/);
  assert.doesNotMatch(html, /Suspend authority/);
});
test("unknown Activity stays unknown with durable links and expanded checks", () => {
  const html = renderToStaticMarkup(
    <ManagementSurface state={{ ...state, activity: [activity] }} />,
  );
  assert.match(html, /Payment still being verified/);
  assert.match(html, /Money movement has not been confirmed/);
  assert.match(html, /href="\?authority=m#confirmed-authority"/);
  assert.match(html, /Technical references/);
  assert.doesNotMatch(
    html,
    /Payment complete|Your money didn’t move|Payment verified/,
  );
});
test("Activity escapes text and does not upgrade INVALID", () => {
  const html = renderToStaticMarkup(
    <ManagementSurface
      state={{
        ...state,
        activity: [
          {
            ...activity,
            label: "<script>danger</script>",
            verification: "INVALID",
          },
        ],
      }}
    />,
  );
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Invalid — needs attention/);
  assert.doesNotMatch(html, /<script>|Payment verified/);
});
test("empty durable list never fabricates example purchases", () => {
  const html = renderToStaticMarkup(<ManagementSurface state={state} />);
  assert.match(html, /No saved operations/);
  assert.doesNotMatch(html, /Paid \$84|Payment verified/);
});
