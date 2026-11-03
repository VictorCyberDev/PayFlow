#!/usr/bin/env node
// Gate A acceptance runner: the stranger's first safe action, end to end, against ANY base URL.
//   node --import tsx scripts/stranger-journey.mjs https://<public host>
// start sandbox -> ALLOW ($84) -> DENY ($184, $0 moved) -> fetch portable Proof -> verify OFFLINE -> tamper rejected.
// Uses only the public HTTP API and the standalone verifier. Prints timings. The token is never printed.
// A run by the person who built PayFlow is NOT the "stranger under five minutes" measurement; that needs someone else.
import { verifyPortableProof } from "../packages/verifier/src/index.ts";

const base = (process.argv[2] ?? "").replace(/\/+$/u, "");
if (!/^https?:\/\//u.test(base)) {
  console.error(
    "usage: node --import tsx scripts/stranger-journey.mjs <base-url>",
  );
  process.exit(2);
}
const t0 = Date.now();
const steps = [];
const step = (name, ok, detail = {}) => {
  steps.push({ name, ok, ms: Date.now() - t0, ...detail });
  if (!ok) throw new Error(`STEP_FAILED:${name}`);
};
const json = async (path, init) => {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  return { status: r.status, body };
};
let verdict = "FAILED";
try {
  const started = await json("/v1/sandbox/start", { method: "POST" });
  step(
    "start sandbox",
    started.status === 201 && started.body.sandbox?.rail === "SIMULATED",
    { status: started.status, rail: started.body.sandbox?.rail },
  );
  const { token, authority } = started.body;
  const auth = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  // The wire format documented in openapi/payflow-v1.yaml (the SDKs build exactly this).
  const buy = (over = {}) => ({
    authority: authority.id,
    agentId: authority.agentId,
    action: "purchase",
    query: { text: authority.item, quantity: 1 },
    amount: { minor: authority.priceMinor, currency: authority.currency },
    merchant: { id: authority.merchant },
    nonce: `journey-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  });

  const allow = await json("/v1/actions/execute", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(buy({})),
  });
  step(
    "ALLOW: paid once",
    allow.body.status === "COMPLETED" && allow.body.effectCount === 1,
    {
      status: allow.body.status,
      effectCount: allow.body.effectCount,
      rail: allow.body.rail,
      reason: allow.body.reason,
      httpStatus: allow.status,
      next: allow.body.nextAction,
    },
  );

  const deny = await json("/v1/actions/execute", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(
      buy({ amount: { minor: 18400, currency: authority.currency } }),
    ),
  });
  step(
    "DENY: $0 moved",
    deny.body.effectCount === 0 && deny.body.status !== "COMPLETED",
    { status: deny.body.status, effectCount: deny.body.effectCount },
  );

  const id = allow.body.proof?.proposalId;
  const portable = await json(`/v1/proofs/${id}/portable`, { headers: auth });
  step(
    "portable Proof issued",
    portable.status === 200 && !!portable.body.proof,
    { status: portable.status },
  );
  const keys = await json("/v1/keys");
  const jwk = keys.body.keys?.find(
    (k) => k.keyId === portable.body.proof.keyId,
  )?.jwk;
  step("public key published", !!jwk);
  const ok = verifyPortableProof(
    portable.body.proof,
    jwk,
    new Date().toISOString(),
    null,
  );
  step("Proof verified OFFLINE", ok.valid === true, { reason: ok.reason });
  const forged = { ...portable.body.proof, effectCount: 2 };
  const bad = verifyPortableProof(forged, jwk, new Date().toISOString(), null);
  step("tampered Proof rejected", bad.valid === false, { reason: bad.reason });
  verdict = "PASSED";
} catch (e) {
  steps.push({
    name: "stopped",
    ok: false,
    error: String(e.message).slice(0, 120),
  });
}
console.log(
  JSON.stringify({ base, verdict, totalMs: Date.now() - t0, steps }, null, 2),
);
process.exit(verdict === "PASSED" ? 0 : 1);
