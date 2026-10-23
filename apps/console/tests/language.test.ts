import test from "node:test";
import assert from "node:assert/strict";
import {
  activityOutcome,
  approvalLine,
  authorityKind,
  glossary,
  traceSteps,
  UNKNOWN_BODY,
} from "../lib/language";
import { authority, blocked, paid, unknown } from "../qa/fixtures";
import type { ActivityView } from "../lib/management-client.mjs";

test("glossary keeps backend words out of the customer vocabulary", () => {
  assert.equal(glossary.Mandate, "Authority");
  assert.equal(glossary.AgentPassport, "Agent");
  assert.equal(glossary.committed, "Used");
  assert.equal(glossary.reserved, "Pending");
  assert.equal(glossary["fresh dispatch blocked"], "Can't start new purchases");
  assert.equal(glossary.UNKNOWN_FINANCIAL_OUTCOME, UNKNOWN_BODY);
});

test("completed and verified money movement reads '$84 paid once' with no celebration", () => {
  const o = activityOutcome(paid);
  assert.equal(o.kind, "paid");
  assert.equal(o.headline, "$84 paid once");
  assert.doesNotMatch(o.headline + o.detail, /!|🎉|congrat|success/i);
});

test("a blocked request leads with '$0 moved'", () => {
  const o = activityOutcome(blocked);
  assert.equal(o.kind, "blocked");
  assert.equal(o.headline, "$0 moved");
  assert.match(o.detail, /maximum amount/);
});

test("an unconfirmed outcome stays unresolved and says not to retry", () => {
  const o = activityOutcome(unknown);
  assert.equal(o.kind, "unresolved");
  assert.equal(o.headline, "Checking what happened — don't retry yet");
  assert.equal(
    o.detail,
    "We haven't confirmed whether money moved. Don't retry yet.",
  );
  assert.equal(o.needsAttention, true);
});

const variant = (over: Partial<ActivityView>): ActivityView => ({
  ...paid,
  ...over,
});

test("never claims '$0 moved' unless the projection says moneyMoved=NO", () => {
  for (const status of [
    "ALLOWED",
    "PROPOSED",
    "INCOMPLETE",
    "PENDING",
    "ESCALATED",
    "UNKNOWN_FINANCIAL_OUTCOME",
  ] as const) {
    const o = activityOutcome(variant({ status, moneyMoved: "UNKNOWN" }));
    assert.doesNotMatch(o.headline, /\$0 moved|paid once/, status);
    assert.equal(o.kind, "unresolved", status);
  }
});

test("never claims 'paid once' unless COMPLETED and moneyMoved=YES", () => {
  assert.doesNotMatch(
    activityOutcome(variant({ status: "COMPLETED", moneyMoved: "UNKNOWN" }))
      .headline,
    /paid once/,
  );
  assert.doesNotMatch(
    activityOutcome(variant({ status: "PENDING", moneyMoved: "YES" })).headline,
    /paid once/,
  );
});

test("pending and escalated records are attention items, merely allowed ones are not", () => {
  assert.equal(
    activityOutcome(variant({ status: "PENDING", moneyMoved: "UNKNOWN" }))
      .needsAttention,
    true,
  );
  assert.equal(
    activityOutcome(variant({ status: "ESCALATED", moneyMoved: "UNKNOWN" }))
      .headline,
    "Needs your approval",
  );
  assert.equal(
    activityOutcome(variant({ status: "ALLOWED", moneyMoved: "UNKNOWN" }))
      .needsAttention,
    false,
  );
});

test("Gate trace: a denial stops at the Gate before the payment rail", () => {
  const steps = traceSteps(blocked);
  assert.deepEqual(
    steps.map((s) => [s.id, s.state]),
    [
      ["authority", "done"],
      ["gate", "stopped"],
      ["payment", "none"],
    ],
  );
});

test("Gate trace: paid resolves fully; unknown never resolves the payment node", () => {
  assert.deepEqual(
    traceSteps(paid).map((s) => s.state),
    ["done", "done", "done"],
  );
  const u = traceSteps(unknown);
  assert.equal(u[2]!.state, "unconfirmed");
  assert.equal(u[2]!.word, "Not confirmed");
});

test("authority kinds and approval wording are plain", () => {
  assert.equal(authorityKind(authority), "active");
  assert.equal(authorityKind({ ...authority, state: "REVOKED" }), "revoked");
  assert.equal(
    authorityKind({
      ...authority,
      state: "UNAVAILABLE",
      agent: { ...authority.agent, status: "SUSPENDED" },
    }),
    "paused",
  );
  assert.equal(approvalLine(authority), "Can spend without asking up to $100");
  assert.equal(
    approvalLine({ ...authority, autonomousThresholdMinor: 5000 }),
    "Can spend without asking up to $50 · Asks you above $100",
  );
  assert.equal(
    approvalLine({ ...authority, autonomousThresholdMinor: 0 }),
    "Asks you before every purchase",
  );
});
