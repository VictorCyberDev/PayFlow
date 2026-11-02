/** Browser client for the NON-PRODUCTION demo Shopping Agent. The browser names a scenario and an
 * Authority; the server decides everything else. Responses are validated and never trusted. */
const transportDefault = async (path, options = {}) => {
  const r = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
    ...options,
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const code =
      typeof body?.code === "string" && /^[A-Z0-9_]{3,96}$/.test(body.code)
        ? body.code
        : "UNAVAILABLE";
    throw new Error(code);
  }
  return body;
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
    throw new Error("SESSION_UNAVAILABLE");
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

/** Starts the one-time payer-present bootstrap. The wallet is owner-scoped, not Authority-scoped.
 * Passing an Authority id only controls which detail page PayPal returns to. */
export async function startPayPalVaultConnection(
  authorityId = null,
  transport = transportDefault,
) {
  if (
    authorityId !== null &&
    (typeof authorityId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        authorityId,
      ))
  )
    throw new Error("INVALID_AUTHORITY");
  const r = await mutation(
    "/api/paypal-vault/start",
    authorityId ? { authorityId } : {},
    transport,
  );
  if (
    r?.version !== "payflow.paypal-vault-start.v2" ||
    typeof r.approvalUrl !== "string" ||
    "setupTokenId" in r
  )
    throw new Error("INVALID_RESPONSE");
  const u = new URL(r.approvalUrl);
  if (u.protocol !== "https:" || u.hostname !== "www.sandbox.paypal.com")
    throw new Error("INVALID_RESPONSE");
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
    throw new Error("INVALID_SCENARIO");
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
    throw new Error("INVALID_RESPONSE");
  return {
    status: r.status,
    operationId: r.operationId,
    code: typeof r.code === "string" ? r.code : null,
  };
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
