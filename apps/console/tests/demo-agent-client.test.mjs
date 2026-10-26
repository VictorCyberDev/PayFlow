import test from "node:test";
import assert from "node:assert/strict";
import {
  completePayPalVaultConnection,
  fetchDemoAgentStatus,
  fetchPayPalVaultStatus,
  runDemoScenario,
} from "../lib/demo-agent-client.mjs";

const session = {
  authenticated: true,
  csrfToken: "csrf-token",
  mode: "NON_PRODUCTION_DEMO",
};
const outcome = (o) => ({
  version: "payflow.demo-agent-outcome.v1",
  providerEffect: "NONE",
  operationId: "op",
  code: null,
  ...o,
});
const transportFor =
  (reply, seen = []) =>
  async (path, options) => {
    seen.push({ path, options });
    if (path === "/api/activation/session") return session;
    return reply;
  };

test("status is null when the host does not offer the demo agent", async () => {
  assert.equal(
    await fetchDemoAgentStatus(async () => {
      throw new Error("404");
    }),
    null,
  );
  assert.equal(
    await fetchDemoAgentStatus(async () => ({ version: "other" })),
    null,
  );
});
test("status reports whether a Sandbox payment rail is connected", async () => {
  const ok = (payment) => async () => ({
    version: "payflow.demo-agent-status.v1",
    mode: "NON_PRODUCTION_DEMO",
    payment,
  });
  assert.deepEqual(await fetchDemoAgentStatus(ok("NOT_CONNECTED")), {
    payment: "NOT_CONNECTED",
  });
  assert.deepEqual(await fetchDemoAgentStatus(ok("SANDBOX_CONNECTED")), {
    payment: "SANDBOX_CONNECTED",
  });
  assert.equal(await fetchDemoAgentStatus(ok("PRODUCTION")), null);
});
test("vault status is accepted only from the exact server contract", async () => {
  assert.equal(
    await fetchPayPalVaultStatus(async () => ({
      version: "payflow.paypal-vault-status.v1",
      connected: true,
    })),
    true,
  );
  assert.equal(
    await fetchPayPalVaultStatus(async () => ({
      version: "payflow.paypal-vault-status.v1",
      connected: false,
    })),
    false,
  );
  assert.equal(
    await fetchPayPalVaultStatus(async () => ({
      version: "payflow.paypal-vault-status.v1",
      connected: "yes",
    })),
    null,
  );
});
test("PayPal completion echoes only callback state; no setup token or provider credential enters browser POST", async () => {
  const seen = [];
  const state = "A".repeat(43);
  const ok = await completePayPalVaultConnection(
    state,
    async (path, options) => {
      seen.push({ path, options });
      if (path === "/api/activation/session") return session;
      return { version: "payflow.paypal-vault-complete.v2", connected: true };
    },
  );
  assert.equal(ok, true);
  const post = seen.find((s) => s.path === "/api/paypal-vault/complete");
  assert.equal(post.options.headers["X-PayFlow-CSRF"], "csrf-token");
  assert.deepEqual(JSON.parse(post.options.body), { state });
  assert.doesNotMatch(post.options.body, /setup|token|vault|secret/i);
  assert.equal(
    await completePayPalVaultConnection("bad", async () => {
      throw new Error("must not call transport");
    }),
    false,
  );
});
test("the browser sends only a scenario and an Authority selector, with the session CSRF value", async () => {
  const seen = [];
  const r = await runDemoScenario(
    "m1",
    "PRICE_DRIFT",
    transportFor(
      outcome({ status: "REFUSED", code: "AMOUNT_EXCEEDS_LIMIT" }),
      seen,
    ),
  );
  assert.deepEqual(r, {
    status: "REFUSED",
    operationId: "op",
    code: "AMOUNT_EXCEEDS_LIMIT",
  });
  const post = seen.find((s) => s.path === "/api/demo-agent/attempt");
  assert.equal(post.options.headers["X-PayFlow-CSRF"], "csrf-token");
  assert.deepEqual(JSON.parse(post.options.body), {
    scenario: "PRICE_DRIFT",
    mandateId: "m1",
  });
});
test("unknown scenarios are refused client-side", async () => {
  await assert.rejects(runDemoScenario("m1", "TRANSFER_ALL", transportFor({})));
});
test("a response that overstates what happened is rejected, never displayed", async () => {
  for (const bad of [
    outcome({ status: "COMPLETED", providerEffect: "NONE" }),
    outcome({ status: "DENIED", providerEffect: "CAPTURED" }),
    outcome({ status: "WORKED" }),
    { version: "x" },
  ])
    await assert.rejects(
      runDemoScenario("m1", "VALID_PURCHASE", transportFor(bad)),
    );
});
test("signed-out sessions never POST", async () => {
  const seen = [];
  await assert.rejects(
    runDemoScenario("m1", "PRICE_DRIFT", async (path, o) => {
      seen.push(path);
      return { authenticated: false };
    }),
  );
  assert.deepEqual(seen, ["/api/activation/session"]);
});

import { reconcileDemo } from "../lib/demo-agent-client.mjs";
test("reconcile is a body-less, CSRF-protected nudge that never throws", async () => {
  const seen = [];
  const ok = await reconcileDemo(async (path, options) => {
    seen.push({ path, options });
    return path === "/api/activation/session"
      ? session
      : { version: "payflow.demo-agent-reconcile.v1", checked: 0 };
  });
  assert.equal(ok, true);
  const post = seen.find((s) => s.path === "/api/demo-agent/reconcile");
  assert.equal(post.options.headers["X-PayFlow-CSRF"], "csrf-token");
  assert.equal(post.options.body, "{}");
  assert.equal(
    await reconcileDemo(async () => {
      throw new Error("down");
    }),
    false,
  );
  assert.equal(
    await reconcileDemo(async () => ({ authenticated: false })),
    false,
  );
});
