import test from "node:test";
import assert from "node:assert/strict";
import { createReviewController } from "../lib/review-client.mjs";
const view = (status = "VALID_DRAFT", source = "buy keyboard") => ({
  version: "payflow.intent-review.v1",
  authority: "NOT_YET_AUTHORIZED",
  source,
  interpretationStatus: "INTERPRETED",
  status,
  fingerprint: status === "VALID_DRAFT" ? "a".repeat(64) : null,
  interpreted: [],
  terms: [],
  message: "Nothing is authorized yet.",
  question: status === "NEEDS_CLARIFICATION" ? "Which currency?" : null,
  reasonCodes: [],
  provenance: {
    mode: "NON_PRODUCTION_REVIEW",
    instructionVersion: "v1",
    sourceReference: "test",
  },
  reviewedAt: "2026-10-22T09:00:00.000Z",
  expiresAt: "2026-10-22T09:05:00.000Z",
});
const clock = () => Date.parse("2026-10-22T09:01:00.000Z");
test("empty and interpreting never imply authority, valid review remains untrusted", async () => {
  const states = [];
  const c = createReviewController(
    (s) => states.push(s),
    async () => view(),
    clock,
  );
  assert.equal(c.getState().status, "EMPTY");
  await c.submit("buy keyboard");
  assert.deepEqual(
    states.map((s) => s.status),
    ["INTERPRETING", "VALID_DRAFT"],
  );
  assert.equal(c.getState().review.authority, "NOT_YET_AUTHORIZED");
});
for (const status of [
  "NEEDS_CLARIFICATION",
  "REJECTED",
  "SAFE_PROVIDER_FAILURE",
])
  test(`${status} is displayed without a confirmation action or draft`, async () => {
    const c = createReviewController(
      () => {},
      async () => view(status),
      clock,
    );
    await c.submit("buy keyboard");
    assert.equal(c.getState().status, status);
    assert.equal(c.getState().review.fingerprint, null);
    assert.deepEqual(c.getState().review.terms, []);
    assert.equal("confirm" in c, false);
  });
test("provider rejection becomes safe failure without raw error", async () => {
  const c = createReviewController(
    () => {},
    async () => {
      throw new Error("private-provider-error");
    },
    clock,
  );
  await c.submit("buy keyboard");
  assert.equal(c.getState().status, "SAFE_PROVIDER_FAILURE");
  assert.equal(c.getState().review, null);
});
test("editing invalidates review, including edit away and back while request is in flight", async () => {
  let finish;
  const c = createReviewController(
    () => {},
    () => new Promise((r) => (finish = r)),
    clock,
  );
  const task = c.submit("buy keyboard");
  c.edit("other");
  c.edit("buy keyboard");
  finish(view());
  await task;
  assert.equal(c.getState().status, "STALE");
  assert.equal(c.getState().review, null);
});
test("out-of-order responses cannot replace a newer source/review", async () => {
  const pending = [];
  const c = createReviewController(
    () => {},
    () => new Promise((r) => pending.push(r)),
    clock,
  );
  const a = c.submit("first");
  const b = c.submit("second");
  pending[1](view("VALID_DRAFT", "second"));
  await b;
  pending[0](view("VALID_DRAFT", "first"));
  await a;
  assert.equal(c.getState().review.source, "second");
});
test("expired display is removed and reload starts empty with no request", async () => {
  let now = clock(),
    calls = 0;
  const c = createReviewController(
    () => {},
    async () => {
      calls++;
      return view();
    },
    () => now,
  );
  await c.submit("buy keyboard");
  now += 300000;
  c.expire();
  assert.equal(c.getState().status, "EXPIRED");
  assert.equal(c.getState().review, null);
  const reload = createReviewController(
    () => {},
    async () => {
      calls++;
      return view();
    },
    clock,
  );
  assert.equal(reload.getState().status, "EMPTY");
  assert.equal(calls, 1);
});
test("already expired response cannot become a current review", async () => {
  const c = createReviewController(
    () => {},
    async () => view(),
    () => clock() + 300000,
  );
  await c.submit("buy keyboard");
  assert.equal(c.getState().status, "EXPIRED");
  assert.equal(c.getState().review, null);
});
for (const patch of [
  { authority: "AUTHORIZED" },
  { activationChallenge: "secret" },
  { source: "swapped" },
  { terms: [{ label: "x", value: "x".repeat(2001) }] },
  { status: "REJECTED", fingerprint: "b".repeat(64) },
  { reasonCodes: null },
])
  test(`unsafe response ${Object.keys(patch).join()} is discarded`, async () => {
    const c = createReviewController(
      () => {},
      async () => ({ ...view(), ...patch }),
      clock,
    );
    await c.submit("buy keyboard");
    assert.equal(c.getState().status, "SAFE_PROVIDER_FAILURE");
    assert.equal(c.getState().review, null);
  });
test("unmount cancels and suppresses late results", async () => {
  let finish;
  let publishes = 0;
  const c = createReviewController(
    () => publishes++,
    () => new Promise((r) => (finish = r)),
    clock,
  );
  const task = c.submit("buy keyboard");
  c.dispose();
  finish(view());
  await task;
  assert.equal(publishes, 1);
});
