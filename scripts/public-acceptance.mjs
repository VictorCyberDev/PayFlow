#!/usr/bin/env node
// Gate A public-deployment acceptance. Everything here is ANONYMOUS: no token, no cookie, no bypass header.
//   node --import tsx scripts/public-acceptance.mjs https://<public origin>
// 1. the ten public routes answer 200 (with and without a trailing slash, none a 404 or a login redirect);
// 2. an anonymous caller is refused on every administrative, credential, member, key-rotation and ops route;
// 3. public responses contain no secret-looking material and publish only PUBLIC keys;
// 4. the stranger journey passes against this origin.
// Writes docs/evidence/public/public-acceptance.json. No secret is read, printed or recorded.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const origin = (process.argv[2] ?? "").replace(/\/+$/u, "");
// http is accepted only for a loopback address, so the script itself can be tested.
if (
  !/^https:\/\//u.test(origin) &&
  !/^http:\/\/127\.0\.0\.1(:\d+)?$/u.test(origin)
) {
  console.error(
    "usage: node --import tsx scripts/public-acceptance.mjs https://<origin>",
  );
  process.exit(2);
}
const out = {
  origin: new URL(origin).hostname,
  at: new Date().toISOString(),
  checks: [],
  ok: false,
};
const check = (name, ok, detail = {}) =>
  out.checks.push({ name, ok, ...detail });
const get = async (path, init) => {
  const r = await fetch(origin + path, { redirect: "manual", ...init });
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("location"),
    text,
    type: r.headers.get("content-type") ?? "",
  };
};

// 1. routes
const ROUTES = [
  "/",
  "/product",
  "/developers",
  "/docs",
  "/sandbox",
  "/verify",
  "/security",
  "/research",
  "/pricing",
  "/status",
];
for (const route of ROUTES) {
  let ok = true;
  const seen = [];
  for (const path of [route, route === "/" ? "/" : route + "/"]) {
    let r = await get(path);
    let hops = 0;
    // Follow same-origin redirects only (a trailing-slash or section redirect is fine; a login wall is not).
    while ([301, 302, 307, 308].includes(r.status) && hops++ < 3) {
      const loc = new URL(r.location ?? "", origin);
      if (loc.hostname !== new URL(origin).hostname) break;
      r = await get(loc.pathname + loc.search);
    }
    seen.push(`${path}->${r.status}`);
    if (
      r.status !== 200 ||
      !/text\/html/u.test(r.type) ||
      /vercel\.com\/login|Authentication Required/iu.test(r.text)
    )
      ok = false;
  }
  check(`public route ${route}`, ok, { seen });
}

// 2. anonymous refusals
const ADMIN = [
  ["GET", "/v1/admin/org/audit/"],
  ["GET", "/v1/admin/org/finance/"],
  ["GET", "/v1/admin/members/"],
  ["POST", "/v1/admin/members/"],
  ["GET", "/v1/admin/credentials/"],
  ["POST", "/v1/admin/credentials/"],
  ["POST", "/v1/admin/org/pause/"],
  ["POST", "/v1/admin/sandbox/authority/"],
  ["GET", "/v1/admin/ops/reconciliation/"],
  ["GET", "/v1/admin/ops/alerts/"],
  ["POST", "/v1/admin/ops/alerts/test/"],
  ["POST", "/v1/admin/ops/reconcile/tick/"],
  ["GET", "/v1/admin/ops/reconcile/tick/"],
  ["POST", "/v1/actions/execute/"],
  ["GET", "/v1/proofs/anything/portable/"],
];
const leaked = [];
for (const [method, path] of ADMIN) {
  const r = await get(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const refused = r.status >= 400 && r.status < 500;
  check(`anonymous ${method} ${path} refused`, refused, { status: r.status });
  if (/secret_hash|pf_act_|BEGIN [A-Z ]*PRIVATE/u.test(r.text))
    leaked.push(path);
}

// 3. public key document: public keys only
const keys = await get("/v1/keys/");
let keyDoc = {};
try {
  keyDoc = JSON.parse(keys.text);
} catch {
  /* reported below */
}
check(
  "GET /v1/keys is public and lists public keys only",
  keys.status === 200 &&
    Array.isArray(keyDoc.keys) &&
    keyDoc.keys.length >= 1 &&
    keyDoc.keys.every((k) => k.jwk && !("d" in k.jwk)),
  {
    status: keys.status,
    keyCount: keyDoc.keys?.length ?? 0,
    statuses: (keyDoc.keys ?? []).map((k) => k.status),
  },
);
check(
  "no secret-looking material in any refused response",
  leaked.length === 0,
  { leaked },
);

// 4. the stranger journey
const journey = await new Promise((resolveRun) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/stranger-journey.mjs", origin],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.on("close", (code) => resolveRun({ code, stdout }));
});
let report = {};
try {
  report = JSON.parse(journey.stdout);
} catch {
  /* reported below */
}
check(
  "stranger journey (sandbox start, ALLOW, DENY, Proof, offline verify, tamper rejected)",
  journey.code === 0 && report.verdict === "PASSED",
  {
    verdict: report.verdict,
    totalMs: report.totalMs,
    steps: (report.steps ?? []).map((s) => ({
      name: s.name,
      ok: s.ok,
      ms: s.ms,
    })),
  },
);
check(
  "the journey output never printed a token",
  !/pf_sbx_/u.test(journey.stdout),
);

out.ok = out.checks.every((c) => c.ok);
const evidencePath =
  process.env.PUBLIC_ACCEPTANCE_OUT ??
  "docs/evidence/public/public-acceptance.json";
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    { ok: out.ok, failed: out.checks.filter((c) => !c.ok) },
    null,
    2,
  ),
);
process.exit(out.ok ? 0 : 1);
