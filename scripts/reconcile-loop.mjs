#!/usr/bin/env node
// M14: a worker that calls the reconciliation tick on an interval. Observation only.
// Usage: PAYFLOW_BASE_URL=https://host PAYFLOW_OPERATOR_TOKEN=... node scripts/reconcile-loop.mjs [seconds]
// The operator token is read from the environment and is never printed.
const base = process.env.PAYFLOW_BASE_URL;
const token = process.env.PAYFLOW_OPERATOR_TOKEN;
const every = Math.max(30, Number(process.argv[2] ?? 300));
if (!base || !token) {
  console.error("PAYFLOW_BASE_URL and PAYFLOW_OPERATOR_TOKEN are required");
  process.exit(2);
}
const once = async () => {
  try {
    const r = await fetch(`${base}/v1/admin/ops/reconcile/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const b = await r.json().catch(() => ({}));
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        status: r.status,
        tick: b.tick,
        alerts: b.alerts,
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        error: e?.name ?? "ERROR",
      }),
    );
  }
};
await once();
if (process.argv.includes("--once")) process.exit(0);
setInterval(once, every * 1000);
