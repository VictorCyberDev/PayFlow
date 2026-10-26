/** Browser client for the NON-PRODUCTION demo Shopping Agent. The browser names a scenario and an
 * Authority; the server decides everything else. Responses are validated and never trusted. */
const transportDefault = async (path, options = {}) => {
  const r = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
    ...options,
  });
  if (!r.ok) throw new Error("unavailable");
  return r.json();
};
const STATUSES = [
  "COMPLETED",
  "DENIED",
  "NEEDS_HUMAN",
  "REFUSED",
  "UNRESOLVED",
];
const EFFECTS = ["NONE", "CAPTURED", "UNKNOWN"];
export const SCENARIOS = ["VALID_PURCHASE", "PRICE_DRIFT"];

async function mutation(path, body, transport = transportDefault) {
  const session = await transport("/api/activation/session");
  if (session?.authenticated !== true || typeof session.csrfToken !== "string")
    throw new Error("session");
  return transport(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayFlow-CSRF": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

/** Null when the host does not offer the demo agent (for example the accepted M5 host). */
export async function fetchDemoAgentStatus(transport = transportDefault) {
  try {
    const s = await transport("/api/demo-agent/status");
    if (
      s?.version !== "payflow.demo-agent-status.v1" ||
      s.mode !== "NON_PRODUCTION_DEMO" ||
      !["SANDBOX_CONNECTED", "NOT_CONNECTED"].includes(s.payment)
    )
      return null;
    return { payment: s.payment };
  } catch {
    return null;
  }
}

export async function fetchPayPalVaultStatus(transport = transportDefault) {
  try {
    const s = await transport("/api/paypal-vault/status");
    if (
      s?.version !== "payflow.paypal-vault-status.v1" ||
      typeof s.connected !== "boolean"
    )
      return null;
    return s.connected;
  } catch {
    return null;
  }
}

/** Starts the one-time payer-present bootstrap. The PayPal setup token remains server-side; the
 * browser receives only the provider approval URL. */
export async function startPayPalVaultConnection(transport = transportDefault) {
  const r = await mutation("/api/paypal-vault/start", {}, transport);
  if (
    r?.version !== "payflow.paypal-vault-start.v2" ||
    typeof r.approvalUrl !== "string" ||
    "setupTokenId" in r
  )
    throw new Error("invalid");
  const u = new URL(r.approvalUrl);
  if (u.protocol !== "https:" || u.hostname !== "www.sandbox.paypal.com")
    throw new Error("invalid");
  window.location.assign(r.approvalUrl);
}

/** Called after PayPal returns to the static console. Only the random callback state is echoed
 * back; the setup token is never present in browser storage or request bodies. */
export async function completePayPalVaultConnection(
  state,
  transport = transportDefault,
) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
    return false;
  const r = await mutation("/api/paypal-vault/complete", { state }, transport);
  return (
    r?.version === "payflow.paypal-vault-complete.v2" && r.connected === true
  );
}

export async function runDemoScenario(
  mandateId,
  scenario,
  transport = transportDefault,
) {
  if (!SCENARIOS.includes(scenario) || typeof mandateId !== "string")
    throw new Error("invalid");
  const r = await mutation(
    "/api/demo-agent/attempt",
    { scenario, mandateId },
    transport,
  );
  if (
    r?.version !== "payflow.demo-agent-outcome.v1" ||
    !STATUSES.includes(r.status) ||
    !EFFECTS.includes(r.providerEffect) ||
    !(r.operationId === null || typeof r.operationId === "string") ||
    (r.status === "COMPLETED" && r.providerEffect !== "CAPTURED") ||
    (["DENIED", "REFUSED", "NEEDS_HUMAN"].includes(r.status) &&
      r.providerEffect !== "NONE")
  )
    throw new Error("invalid");
  return { status: r.status, operationId: r.operationId, code: r.code ?? null };
}

/** Asks the system to resolve uncertain payments. Returns false on any failure; never throws. */
export async function reconcileDemo(transport = transportDefault) {
  try {
    const r = await mutation("/api/demo-agent/reconcile", {}, transport);
    return r?.version === "payflow.demo-agent-reconcile.v1";
  } catch {
    return false;
  }
}
