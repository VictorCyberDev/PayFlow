/**
 * The environment contract of the hosted customer application (hosting/m6), derived from src/console-hosted.ts and src/network/hosted-gateway.ts.
 * Names and rules only: this module never reads, prints or stores a value. A test checks the HOST-START set against the real parser so this list
 * cannot drift from the code.
 */
export type Need = "HOST_START" | "CUSTOMER_APP" | "FEATURE" | "OPTIONAL";
export interface Var {
  readonly name: string;
  readonly need: Need;
  readonly secret: boolean;
  readonly rule: string;
  readonly why: string;
}
export const ENV_CONTRACT: readonly Var[] = [
  {
    name: "PAYFLOW_M5_DEMO",
    need: "HOST_START",
    secret: false,
    rule: 'must be exactly "true"',
    why: "the host refuses to start without it (sandbox-only marker)",
  },
  {
    name: "DATABASE_URL",
    need: "HOST_START",
    secret: true,
    rule: "PostgreSQL URL for the least-privileged runtime role (svc_public_rt), never an owner or neon_superuser role",
    why: "all durable state",
  },
  {
    name: "PAYFLOW_M5_PRINCIPAL_ID",
    need: "HOST_START",
    secret: false,
    rule: "1-128 characters",
    why: "the sandbox principal",
  },
  {
    name: "PAYFLOW_M5_AGENT_ID",
    need: "HOST_START",
    secret: false,
    rule: "1-128 characters",
    why: "the sandbox agent",
  },
  {
    name: "PAYFLOW_M5_BOOTSTRAP_KEY",
    need: "HOST_START",
    secret: true,
    rule: "32-256 characters, random",
    why: "bootstrap login for the sandbox",
  },
  {
    name: "PAYFLOW_M5_ORIGIN",
    need: "HOST_START",
    secret: false,
    rule: "https URL of the deployed origin",
    why: "canonical origin, callbacks, credential issuer",
  },
  {
    name: "PAYFLOW_M6_DEMO_AGENT",
    need: "OPTIONAL",
    secret: false,
    rule: 'if set it must be "true", and then PAYFLOW_M6_SIGNING_KEY becomes REQUIRED',
    why: "enables the M6 demo shopping agent; it is currently set on payflow-public, so the signing key is needed unless this variable is removed",
  },
  {
    name: "PAYFLOW_M6_SIGNING_KEY",
    need: "FEATURE",
    secret: true,
    rule: "40-4096 characters; a NEW key for this environment, never the historical acceptance key",
    why: "signs grants when the M6 demo agent is on",
  },
  {
    name: "PAYFLOW_M6_SIGNING_KID",
    need: "OPTIONAL",
    secret: false,
    rule: "[A-Za-z0-9._-]{1,64}",
    why: "key id (currently set)",
  },
  {
    name: "PAYFLOW_APP_ORIGINS",
    need: "OPTIONAL",
    secret: false,
    rule: "comma-separated exact origins (no path, no trailing slash); DEFAULTS to PAYFLOW_M5_ORIGIN (console-hosted.ts), so it is only needed for an extra origin such as a custom domain",
    why: "browser Origin allow-list for signup, login and state changes; the first entry is also the base of links in account emails",
  },
  {
    name: "PAYFLOW_GATEWAY_ADMIN_TOKEN",
    need: "FEATURE",
    secret: true,
    rule: "at least 32 characters, random",
    why: "operator routes only (automation run, reconcile tick, alerts, provisioning). Without it operator access is disabled and the customer app's member routes still work. Needed in practice for booking-expiry jobs and email sending unless CRON_SECRET is used",
  },
  {
    name: "CRON_SECRET",
    need: "FEATURE",
    secret: true,
    rule: "at least 32 characters",
    why: "lets the scheduler call only GET /v1/admin/ops/reconcile/tick and GET /v1/admin/ops/automation/run; needed for the crons in hosting/m6/vercel.json to work",
  },
  {
    name: "PAYFLOW_ALERT_WEBHOOK_URL",
    need: "FEATURE",
    secret: true,
    rule: "https URL",
    why: "without it alerts are stored but not delivered",
  },
  {
    name: "PAYFLOW_TRUSTED_PROXY_HOPS",
    need: "OPTIONAL",
    secret: false,
    rule: "integer 0-5; 1 behind Vercel's proxy",
    why: "which X-Forwarded-For entry is the client address (rate limits)",
  },
  {
    name: "PAYFLOW_IP_RATE_LIMIT_PER_MINUTE",
    need: "OPTIONAL",
    secret: false,
    rule: "integer 10-100000 (default 600)",
    why: "per-address request cap",
  },
  {
    name: "PAYFLOW_PUBLIC_SANDBOX",
    need: "OPTIONAL",
    secret: false,
    rule: 'must be "true" to enable self-serve /v1/sandbox/start (simulated rail)',
    why: "currently set",
  },
  {
    name: "PAYPAL_ENVIRONMENT",
    need: "FEATURE",
    secret: false,
    rule: "sandbox",
    why: "only with the M6 demo agent",
  },
  {
    name: "PAYPAL_CLIENT_ID",
    need: "FEATURE",
    secret: true,
    rule: "PayPal Sandbox client id",
    why: "only with the M6 demo agent and real Sandbox payments",
  },
  {
    name: "PAYPAL_CLIENT_SECRET",
    need: "FEATURE",
    secret: true,
    rule: "PayPal Sandbox client secret",
    why: "only with the M6 demo agent and real Sandbox payments",
  },
  {
    name: "PAYPAL_EXPECTED_MERCHANT_ID",
    need: "OPTIONAL",
    secret: false,
    rule: "13 characters or DEMOACCOUNT01 (default)",
    why: "merchant binding",
  },
  {
    name: "PAYFLOW_OAUTH_ISSUER",
    need: "OPTIONAL",
    secret: false,
    rule: "https URL; must be set together with PAYFLOW_OAUTH_JWKS_URL",
    why: "external OAuth for MCP/ChatGPT",
  },
  {
    name: "PAYFLOW_OAUTH_JWKS_URL",
    need: "OPTIONAL",
    secret: false,
    rule: "https URL; together with PAYFLOW_OAUTH_ISSUER",
    why: "external OAuth for MCP/ChatGPT",
  },
  {
    name: "PAYFLOW_MCP_PROFILE",
    need: "OPTIONAL",
    secret: false,
    rule: '"full" or "verify-only"',
    why: "MCP tool profile",
  },
  {
    name: "PAYFLOW_DEMO_ACCESS_CODE",
    need: "OPTIONAL",
    secret: true,
    rule: "16-256 characters",
    why: "human-entered demo login",
  },
];

export interface Report {
  readonly missingHostStart: string[];
  readonly missingCustomerApp: string[];
  readonly missingForEnabledFeatures: string[];
  readonly presentSecretsNeedingReview: string[];
  readonly ready: boolean;
}
/** `present` is the set of variable NAMES that exist; values are never passed in. */
export function assess(present: ReadonlySet<string>): Report {
  const has = (n: string) => present.has(n);
  const missingHostStart = ENV_CONTRACT.filter(
    (v) => v.need === "HOST_START" && !has(v.name),
  ).map((v) => v.name);
  const missingCustomerApp = ENV_CONTRACT.filter(
    (v) => v.need === "CUSTOMER_APP" && !has(v.name),
  ).map((v) => v.name);
  const missingForEnabledFeatures: string[] = [];
  if (has("PAYFLOW_M6_DEMO_AGENT") && !has("PAYFLOW_M6_SIGNING_KEY"))
    missingForEnabledFeatures.push("PAYFLOW_M6_SIGNING_KEY");
  for (const n of ["CRON_SECRET"])
    if (!has(n)) missingForEnabledFeatures.push(n); // the crons in vercel.json need it
  return {
    missingHostStart,
    missingCustomerApp,
    missingForEnabledFeatures,
    presentSecretsNeedingReview: ["DATABASE_URL"].filter(has),
    ready:
      missingHostStart.length === 0 &&
      missingCustomerApp.length === 0 &&
      missingForEnabledFeatures.length === 0,
  };
}
