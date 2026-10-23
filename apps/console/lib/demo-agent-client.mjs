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

export async function runDemoScenario(
  mandateId,
  scenario,
  transport = transportDefault,
) {
  if (!SCENARIOS.includes(scenario) || typeof mandateId !== "string")
    throw new Error("invalid");
  const session = await transport("/api/activation/session");
  if (session?.authenticated !== true || typeof session.csrfToken !== "string")
    throw new Error("session");
  const r = await transport("/api/demo-agent/attempt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayFlow-CSRF": session.csrfToken,
    },
    body: JSON.stringify({ scenario, mandateId }),
  });
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
    const session = await transport("/api/activation/session");
    if (
      session?.authenticated !== true ||
      typeof session.csrfToken !== "string"
    )
      return false;
    const r = await transport("/api/demo-agent/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PayFlow-CSRF": session.csrfToken,
      },
      body: "{}",
    });
    return r?.version === "payflow.demo-agent-reconcile.v1";
  } catch {
    return false;
  }
}
