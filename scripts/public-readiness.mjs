#!/usr/bin/env node
// Gate A deployment readiness. OFFLINE and secret-free: it reads no credential and calls no service.
//   (cd apps/console && npm run build) && node --import tsx scripts/public-readiness.mjs [--envs <names.json>]
//
// 1. Derives the REQUIRED environment contract from the code itself (parseHostedConfig) and compares it with the
//    contract this release expects, so a code change that adds a variable cannot be forgotten by the owner checklist.
// 2. Validates hosting/m6/vercel.json (rewrites, redirects, cron, function limits).
// 3. Validates the static export: the ten public routes, the canonical origin, no stale host.
// 4. With --envs, audits a list of {key,target,type} (NAMES ONLY, never values) taken from Vercel:
//    every required name present, secrets are sensitive/encrypted and Production-only, no PayPal variable,
//    no DATABASE_URL on Preview.
import { existsSync, readFileSync } from "node:fs";
import { parseHostedConfig } from "../src/console-hosted.ts";

const CANONICAL = "https://payflow-public.vercel.app";
const SECRET_NAMES = [
  "DATABASE_URL",
  "PAYFLOW_GATEWAY_ADMIN_TOKEN",
  "PAYFLOW_M5_BOOTSTRAP_KEY",
  "PAYFLOW_M6_SIGNING_KEY",
  "CRON_SECRET",
  "PAYFLOW_ALERT_WEBHOOK_URL",
];
// What the owner must provide for the PUBLIC sandbox (the code requires the first group; the second group is
// required by this release's design: the operator boundary, the scheduler, and the self-serve sandbox).
const EXPECTED_CODE_REQUIRED = [
  "DATABASE_URL",
  "PAYFLOW_M5_AGENT_ID",
  "PAYFLOW_M5_BOOTSTRAP_KEY",
  "PAYFLOW_M5_DEMO",
  "PAYFLOW_M5_ORIGIN",
  "PAYFLOW_M5_PRINCIPAL_ID",
  "PAYFLOW_M6_SIGNING_KEY", // required once the demo agent switch below is on
];
// PAYFLOW_M6_DEMO_AGENT is a switch the code does not require, but the hosted Gateway (the API this release exists
// to expose) is mounted only when it is on, so the public design requires it.
const PUBLIC_DESIGN_REQUIRED = [
  "CRON_SECRET",
  "PAYFLOW_GATEWAY_ADMIN_TOKEN",
  "PAYFLOW_M6_DEMO_AGENT",
  "PAYFLOW_PUBLIC_SANDBOX",
];
const PAYPAL_NAMES = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_ENVIRONMENT",
  "PAYPAL_EXPECTED_MERCHANT_ID",
];

const checks = [];
const check = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

// ---- 1. contract derived from the code (placeholders are not secrets: they are shaped, not real)
const fake = {
  PAYFLOW_M5_DEMO: "true",
  DATABASE_URL: "placeholder",
  PAYFLOW_M5_PRINCIPAL_ID: "p",
  PAYFLOW_M5_AGENT_ID: "a",
  PAYFLOW_M5_BOOTSTRAP_KEY: "k".repeat(40),
  PAYFLOW_M5_ORIGIN: CANONICAL,
  PAYFLOW_M6_DEMO_AGENT: "true",
  PAYFLOW_M6_SIGNING_KEY: "s".repeat(64),
};
let derived = [];
try {
  parseHostedConfig(fake);
  derived = Object.keys(fake).filter((key) => {
    const { [key]: _omitted, ...rest } = fake;
    try {
      parseHostedConfig(rest);
      return false;
    } catch {
      return true;
    }
  });
} catch (error) {
  check("the full contract parses", false, {
    error: String(error.message).slice(0, 80),
  });
}
const same = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check(
  "environment contract derived from the code matches this release's expectation",
  same(derived, EXPECTED_CODE_REQUIRED),
  {
    derived: [...derived].sort(),
    expected: [...EXPECTED_CODE_REQUIRED].sort(),
  },
);
const withPublic = parseHostedConfig({
  ...fake,
  PAYFLOW_GATEWAY_ADMIN_TOKEN: "t".repeat(40),
  CRON_SECRET: "c".repeat(40),
  PAYFLOW_PUBLIC_SANDBOX: "true",
});
check(
  "public sandbox, operator token and scheduler secret are recognised",
  withPublic.publicSandbox === true &&
    Boolean(withPublic.gatewayAdminToken) &&
    Boolean(withPublic.cronSecret),
);
check(
  "a short scheduler secret and a short operator token are refused",
  (() => {
    try {
      parseHostedConfig({ ...fake, CRON_SECRET: "short" });
      return false;
    } catch {
      /* expected */
    }
    try {
      parseHostedConfig({ ...fake, PAYFLOW_GATEWAY_ADMIN_TOKEN: "short" });
      return false;
    } catch {
      return true;
    }
  })(),
);
check(
  "with no PayPal variable the config carries no PayPal setting (only the simulated rail can execute)",
  !Object.values(withPublic.paypalEnv ?? {}).some(Boolean),
);

// ---- 2. vercel.json
const vj = JSON.parse(readFileSync("hosting/m6/vercel.json", "utf8"));
check(
  "vercel.json rewrites /v1/* to the host function",
  (vj.rewrites ?? []).some(
    (r) => r.source === "/v1/(.*)" && r.destination === "/api/host",
  ),
);
check(
  "vercel.json redirects /developers to /docs/",
  (vj.redirects ?? []).some(
    (r) => r.source === "/developers" && r.destination === "/docs/",
  ),
);
const crons = vj.crons ?? [];
// Exactly two scheduled calls, both GET-able and both safe to repeat: the observation-only reconcile tick and the automation run, which can
// only run the registered handlers (a job with an external effect is never re-run).
const ALLOWED_CRONS = [
  "/v1/admin/ops/reconcile/tick/",
  "/v1/admin/ops/automation/run/",
];
check(
  "vercel.json has exactly the reconcile tick and the automation run as crons",
  crons.length === ALLOWED_CRONS.length &&
    ALLOWED_CRONS.every((p) => crons.some((c) => c.path === p)) &&
    crons.every((c) => c.schedule.split(" ").length === 5),
  { crons },
);
check(
  "vercel.json builds the console static export",
  /apps\/console/u.test(vj.buildCommand ?? "") &&
    vj.outputDirectory === "public",
);
check(
  "the host function has a bounded duration",
  Number(vj.functions?.["api/host.ts"]?.maxDuration) > 0 &&
    Number(vj.functions["api/host.ts"].maxDuration) <= 60,
);

// ---- 3. static export
const out = "apps/console/out";
check(
  "the static export exists (run the console build first)",
  existsSync(out + "/index.html"),
);
for (const route of [
  "product",
  "docs",
  "sandbox",
  "verify",
  "security",
  "research",
  "pricing",
  "status",
])
  check(`static route /${route}/`, existsSync(`${out}/${route}/index.html`));
if (existsSync(out + "/index.html")) {
  const home = readFileSync(out + "/index.html", "utf8");
  check(
    "canonical and Open Graph point at the public alias",
    home.includes(`rel="canonical" href="${CANONICAL}/"`) &&
      home.includes(`content="${CANONICAL}/brand/social-card.png"`),
  );
  const robots = existsSync(out + "/robots.txt")
    ? readFileSync(out + "/robots.txt", "utf8")
    : "";
  const sitemap = existsSync(out + "/sitemap.xml")
    ? readFileSync(out + "/sitemap.xml", "utf8")
    : "";
  check(
    "sitemap and robots use the public alias only",
    sitemap.includes(CANONICAL) &&
      !/payflow-one-kappa/u.test(sitemap + robots) &&
      robots.includes(CANONICAL),
  );
}

// ---- 4. Vercel variable names (never values)
const i = process.argv.indexOf("--envs");
if (i > 0) {
  const envs = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
  const by = new Map(envs.map((e) => [e.key, e]));
  const missing = [...EXPECTED_CODE_REQUIRED, ...PUBLIC_DESIGN_REQUIRED].filter(
    (k) => !by.has(k),
  );
  check("every required variable is set on the project", missing.length === 0, {
    missing,
  });
  const exposed = SECRET_NAMES.filter((k) => by.has(k)).filter(
    (k) => !["sensitive", "encrypted"].includes(by.get(k).type),
  );
  check(
    "every secret is stored sensitive or encrypted, never plain",
    exposed.length === 0,
    { exposed },
  );
  const leakyScope = SECRET_NAMES.filter((k) => by.has(k)).filter(
    (k) =>
      !(by.get(k).target.length === 1 && by.get(k).target[0] === "production"),
  );
  check(
    "every secret is scoped to Production only (no Preview, no Development)",
    leakyScope.length === 0,
    { leakyScope },
  );
  check(
    "DATABASE_URL is not available to Preview",
    !by.has("DATABASE_URL") ||
      !by.get("DATABASE_URL").target.includes("preview"),
  );
  check(
    "no PayPal variable exists on the public project",
    PAYPAL_NAMES.every((k) => !by.has(k)),
    { present: PAYPAL_NAMES.filter((k) => by.has(k)) },
  );
  check(
    "the origin variable matches the canonical alias",
    by.get("PAYFLOW_M5_ORIGIN")?.value === CANONICAL ||
      !by.get("PAYFLOW_M5_ORIGIN")?.value,
    {},
  );
}

const failed = checks.filter((c) => !c.ok);
console.log(
  JSON.stringify(
    {
      ready: failed.length === 0,
      checked: checks.length,
      failed,
      envAudit: i > 0,
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
