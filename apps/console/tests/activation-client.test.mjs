import test from "node:test";
import assert from "node:assert/strict";
import { createActivationController } from "../lib/activation-client.mjs";
const now = Date.parse("2026-10-23T10:00:00.000Z");
const session = {
  authenticated: true,
  mode: "NON_PRODUCTION_DEMO",
  csrfToken: "csrf-nonce-not-auth-cookie",
  expiresAt: "2026-10-23T10:15:00.000Z",
};
const pending = {
  status: "PENDING_REVIEW",
  authority: "NOT_YET_AUTHORIZED",
  mode: "NON_PRODUCTION_DEMO",
  source: "buy keyboard",
  reviewId: "review-1",
  displayHash: "a".repeat(64),
  agentName: "Shopping Agent",
  expiresAt: "2026-10-23T10:05:00.000Z",
  terms: [{ label: "Budget", value: "$100" }],
};
const active = {
  version: "payflow.authority-view.v1",
  mandateId: "mandate-1",
  state: "ACTIVE",
  agent: { id: "a", displayName: "Shopping Agent", status: "ACTIVE" },
  purpose: "Keyboard",
  currency: "USD",
  singleMaximumMinor: 10000,
  remainingMinor: 10000,
  quantityRemaining: 1,
  allowedConditions: ["NEW"],
  merchantScopeSummary: "Only Amazon",
  expiresAt: "2026-10-24T10:00:00.000Z",
};
function harness(read = async () => active) {
  let time = now;
  const calls = [],
    states = [];
  const transport = async (path, opt) => {
    calls.push([path, opt]);
    if (path === "/api/activation/session") return session;
    if (path === "/api/activation/reviews") return pending;
    if (path === "/api/activation/confirm")
      return { status: "ACTIVATED", mandateId: "mandate-1" };
    if (path.startsWith("/api/activation/authority")) return read();
    if (path === "/api/activation/logout") return { authenticated: false };
    throw new Error("no-route");
  };
  const c = createActivationController(
    (s) => states.push(s),
    transport,
    () => {},
    () => time,
  );
  return { c, calls, states, advance: (ms) => (time += ms) };
}
test("an activation response cannot become ACTIVE before a successful fresh GET", async () => {
  let finish;
  const h = harness(() => new Promise((r) => (finish = r)));
  await h.c.restore();
  await h.c.prepare("buy keyboard");
  assert.equal(h.c.getState().status, "PENDING");
  const task = h.c.confirm();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.c.getState().status, "VERIFYING");
  assert.equal(h.c.getState().authority, null);
  finish(active);
  await task;
  assert.equal(h.c.getState().status, "ACTIVE");
  assert.ok(h.states.find((s) => s.status === "CONFIRMING"));
  assert.equal(
    h.calls.filter(([p]) => p === "/api/activation/confirm").length,
    1,
  );
  assert.deepEqual(
    JSON.parse(h.calls.find(([p]) => p === "/api/activation/confirm")[1].body),
    {
      action: "CONFIRM_EXACT_TERMS",
      reviewId: "review-1",
      displayHash: "a".repeat(64),
    },
  );
});
for (const view of [
  null,
  { ...active, state: "REVOKED" },
  { ...active, mandateId: "other" },
  { ...active, agent: { ...active.agent, status: "SUSPENDED" } },
  { ...active, expiresAt: "2026-10-22T00:00:00.000Z" },
])
  test("forged/unavailable/non-active fresh state prevents active display", async () => {
    const h = harness(async () => view);
    await h.c.restore();
    await h.c.prepare("buy keyboard");
    await h.c.confirm();
    assert.equal(h.c.getState().status, "ERROR");
    assert.equal(h.c.getState().authority, null);
  });
test("reload/restore only GETs session and durable Authority, never confirms", async () => {
  const h = harness();
  await h.c.restore("mandate-1");
  assert.equal(h.c.getState().status, "ACTIVE");
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(([, opt]) => !opt?.method));
  assert.equal(
    JSON.stringify(h.c.getState()).includes(session.csrfToken),
    false,
  );
});
test("source edit invalidates pending confirmation and causes no automatic activation", async () => {
  const h = harness();
  await h.c.restore();
  await h.c.prepare("buy keyboard");
  h.c.invalidate();
  await h.c.confirm();
  assert.equal(h.c.getState().pending, null);
  assert.equal(
    h.calls.filter(([p]) => p === "/api/activation/confirm").length,
    0,
  );
});
test("expired pending review and session both clear non-authoritative client state", async () => {
  const h = harness();
  await h.c.restore();
  await h.c.prepare("buy keyboard");
  h.advance(300000);
  h.c.expire();
  assert.equal(h.c.getState().status, "ERROR");
  h.advance(600000);
  h.c.expire();
  assert.equal(h.c.getState().status, "SIGNED_OUT");
});
test("logout clears visible Authority and confirmation eligibility", async () => {
  const h = harness();
  await h.c.restore("mandate-1");
  await h.c.logout();
  assert.equal(h.c.getState().status, "SIGNED_OUT");
  assert.equal(h.c.getState().authority, null);
});
test("late successful response after unmount is not shown as active", async () => {
  let finish;
  const h = harness(() => new Promise((r) => (finish = r)));
  await h.c.restore();
  await h.c.prepare("buy keyboard");
  const task = h.c.confirm();
  await new Promise((r) => setImmediate(r));
  h.c.dispose();
  finish(active);
  await task;
  assert.equal(
    h.states.some((s) => s.status === "ACTIVE"),
    false,
  );
});
