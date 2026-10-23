import test from "node:test";
import assert from "node:assert/strict";
import { createManagementController } from "../lib/management-client.mjs";
const now = Date.parse("2026-10-23T10:00:00.000Z");
const session = {
  authenticated: true,
  mode: "NON_PRODUCTION_DEMO",
  csrfToken: "csrf-only",
  expiresAt: "2026-10-23T10:15:00.000Z",
};
const active = {
  version: "payflow.authority-view.v1",
  mandateId: "m",
  state: "ACTIVE",
  agent: { id: "a", displayName: "Agent", status: "ACTIVE" },
  expiresAt: "2026-10-24T00:00:00.000Z",
  freshDispatchBlocked: null,
};
const revoked = { ...active, state: "REVOKED", freshDispatchBlocked: true };
function harness() {
  let authority = active,
    time = now,
    fail = false,
    hold = null;
  const calls = [],
    states = [];
  const transport = async (path, opt) => {
    calls.push([path, opt]);
    if (path === "/api/activation/session") return session;
    if (path === "/api/activation/revoke") {
      if (fail) throw new Error("secret");
      authority = revoked;
      return { status: "REVOKE_RECORDED", mandateId: "m" };
    }
    if (path === "/api/activation/authorities")
      return hold
        ? hold()
        : { version: "payflow.authorities.v1", items: [authority] };
    if (path === "/api/activation/activity")
      return { version: "payflow.activity.v1", items: [] };
    throw new Error("route");
  };
  const c = createManagementController(
    (s) => states.push(s),
    transport,
    () => time,
  );
  return {
    c,
    calls,
    states,
    setAuthority: (a) => (authority = a),
    setHold: (f) => (hold = f),
    fail: () => (fail = true),
    advance: (ms) => (time += ms),
  };
}
test("revoke acknowledgement waits for fresh durable read before REVOKED display", async () => {
  const h = harness();
  await h.c.refresh();
  h.c.requestRevoke("m");
  let resolve;
  h.setHold(() => new Promise((r) => (resolve = r)));
  const task = h.c.revoke();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.c.getState().status, "VERIFYING");
  assert.equal(h.c.getState().authorities[0].state, "ACTIVE");
  resolve({ version: "payflow.authorities.v1", items: [revoked] });
  await task;
  assert.equal(h.c.getState().authorities[0].state, "REVOKED");
  const post = h.calls.find(([p]) => p === "/api/activation/revoke")[1];
  assert.deepEqual(JSON.parse(post.body), {
    action: "REVOKE_AUTHORITY",
    mandateId: "m",
  });
  assert.equal(post.headers["X-PayFlow-CSRF"], "csrf-only");
  assert.equal(JSON.stringify(h.c.getState()).includes("csrf-only"), false);
});
test("failed revoke retains prior state and safe error", async () => {
  const h = harness();
  await h.c.refresh();
  h.fail();
  h.c.requestRevoke("m");
  await h.c.revoke();
  assert.equal(h.c.getState().authorities[0].state, "ACTIVE");
  assert.match(h.c.getState().error, /could not be confirmed/);
  assert.doesNotMatch(h.c.getState().error, /secret/);
});
test("failed fresh verification cannot become optimistic revocation", async () => {
  const h = harness();
  await h.c.refresh();
  h.c.requestRevoke("m");
  h.setHold(async () => ({
    version: "payflow.authorities.v1",
    items: [active],
  }));
  await h.c.revoke();
  assert.equal(h.c.getState().authorities[0].state, "ACTIVE");
  assert.match(h.c.getState().error, /could not be confirmed/);
});
test("read-only refresh and reload correct stale ACTIVE to durable REVOKED", async () => {
  const h = harness();
  await h.c.refresh();
  h.setAuthority(revoked);
  await h.c.refresh();
  assert.equal(h.c.getState().authorities[0].state, "REVOKED");
  assert.ok(h.calls.every(([, o]) => !o?.method));
  const n = harness();
  n.setAuthority(revoked);
  await n.c.refresh();
  assert.equal(n.c.getState().authorities[0].state, "REVOKED");
});
test("duplicate click cannot dispatch second revoke", async () => {
  const h = harness();
  await h.c.refresh();
  h.c.requestRevoke("m");
  await Promise.all([h.c.revoke(), h.c.revoke()]);
  assert.equal(
    h.calls.filter(([p]) => p === "/api/activation/revoke").length,
    1,
  );
});
test("focused confirmation is explicit; cancel and unknown selector never mutate", async () => {
  const h = harness();
  await h.c.refresh();
  h.c.requestRevoke("other");
  assert.equal(h.c.getState().status, "READY");
  h.c.requestRevoke("m");
  assert.equal(h.c.getState().status, "CONFIRM_REVOKE");
  h.c.cancelRevoke();
  await h.c.revoke();
  assert.ok(h.calls.every(([, o]) => !o?.method));
});
test("session expiry clears owner projections", async () => {
  const h = harness();
  await h.c.refresh();
  h.advance(900001);
  h.c.expire();
  assert.equal(h.c.getState().status, "SIGNED_OUT");
  assert.deepEqual(h.c.getState().authorities, []);
});
test("failed refresh clears stale success", async () => {
  const h = harness();
  await h.c.refresh();
  h.setHold(async () => {
    throw new Error("secret");
  });
  await h.c.refresh();
  assert.equal(h.c.getState().status, "UNAVAILABLE");
  assert.deepEqual(h.c.getState().authorities, []);
});
test("unmount suppresses late reads", async () => {
  const h = harness();
  let resolve;
  h.setHold(() => new Promise((r) => (resolve = r)));
  const task = h.c.refresh();
  await new Promise((r) => setImmediate(r));
  h.c.dispose();
  const count = h.states.length;
  resolve({ version: "payflow.authorities.v1", items: [active] });
  await task;
  assert.equal(h.states.length, count);
});
test("paused and expired server state remain blocked", async () => {
  for (const a of [
    {
      ...active,
      state: "UNAVAILABLE",
      agent: { ...active.agent, status: "SUSPENDED" },
      freshDispatchBlocked: true,
    },
    {
      ...active,
      state: "EXPIRED",
      expiresAt: "2026-10-22T00:00:00.000Z",
      freshDispatchBlocked: true,
    },
  ]) {
    const h = harness();
    h.setAuthority(a);
    await h.c.refresh();
    assert.equal(h.c.getState().authorities[0].state, a.state);
  }
});
test("inconsistent blocked server projection fails closed", async () => {
  const h = harness();
  h.setAuthority({ ...revoked, freshDispatchBlocked: false });
  await h.c.refresh();
  assert.equal(h.c.getState().status, "UNAVAILABLE");
});
test("local authority expiry hides stale active view until a fresh server read", async () => {
  const h = harness();
  h.setAuthority({ ...active, expiresAt: "2026-10-23T10:01:00.000Z" });
  await h.c.refresh();
  h.advance(60001);
  h.c.expire();
  assert.equal(h.c.getState().status, "UNAVAILABLE");
  assert.deepEqual(h.c.getState().authorities, []);
});
