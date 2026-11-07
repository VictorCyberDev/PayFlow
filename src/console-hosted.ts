import { createPrivateKey, createPublicKey } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import {
  DurableConsoleSessions,
  deriveHostKeys,
} from "./console-session-durable.js";
import { PostgresPendingStore } from "./console-pending.js";
import { ConsoleActivation } from "./console-activation.js";
import { ConsoleControls } from "./console-controls.js";
import { ConsoleActivity } from "./activity-postgres.js";
import { StaticPublicKeyRing } from "./execution-grant.js";
import { activationHttpHandler } from "./console-activation-host.js";
import { IntentReviewService } from "./intent-review.js";
import {
  demoIntentSource,
  demoReviewBounds,
  recordedInterpretation,
} from "./intent-review-demo.js";
import {
  FakeIntentModelProvider,
  type IntentModelProvider,
} from "./intent-model.js";
import { PostgresTrustRepository } from "./persistence.js";
import { ConsoleDemoAgent } from "./console-demo-agent.js";
import { DemoShoppingAgent } from "./delegated-demo.js";
import { createHostedGatewayHandler } from "./network/hosted-gateway.js";
import { SimulatedPaymentProvider } from "./simulated-rail.js";
import type { JWTVerifyGetKey } from "jose";
import { remoteKeys } from "./protocols/oauth-resource.js";
import { PayPalOAuthClient, type PaymentProvider } from "./paypal.js";
import {
  PayPalVaultStore,
  StoredPayPalPaymentProvider,
} from "./paypal-vault-bootstrap.js";

/**
 * `POST /v1/mcp` is the same Gateway behind a protocol adapter. It needs a TLS (or loopback) resource URL, so on any
 * other origin it is left disabled rather than failing the whole host.
 */
function mcpResourceFor(origin: string): { mcpResource?: string } {
  const url = new URL("/v1/mcp", origin);
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  return url.protocol === "https:" || loopback ? { mcpResource: url.href } : {};
}

/** The credential issuer id is the host's own origin, and only when it is https or loopback (a verifier needs TLS). */
function credentialIssuerFor(origin: string): { credentialIssuer?: string } {
  const url = new URL(origin);
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  return url.protocol === "https:" || loopback
    ? { credentialIssuer: url.origin }
    : {};
}

/** Hosted NON-PRODUCTION demo configuration. Every value is operator-supplied privately; none
 * is ever logged, rendered or returned. */
const HostedConfigSchema = z.object({
  PAYFLOW_M5_DEMO: z.literal("true"),
  DATABASE_URL: z.string().min(1),
  PAYFLOW_M5_PRINCIPAL_ID: z.string().min(1).max(128),
  PAYFLOW_M5_AGENT_ID: z.string().min(1).max(128),
  PAYFLOW_M5_BOOTSTRAP_KEY: z.string().min(32).max(256),
  /** Human-entered demo login only. When absent, M5 keeps its historical bootstrap-key login. */
  PAYFLOW_DEMO_ACCESS_CODE: z.string().min(16).max(256).optional(),
  PAYFLOW_M5_ORIGIN: z.string().url(),
});
/** M6 (optional): the demo Shopping Agent. Fails closed: when enabled, a persistent grant signing
 * key is mandatory so historical Activity can be verified by any later instance. Payment is
 * connected only when complete Sandbox credentials exist and this owner has an encrypted,
 * server-stored PayPal instrument created by the one-time payer-present bootstrap. */
const DemoAgentSchema = z.object({
  PAYFLOW_M6_DEMO_AGENT: z.literal("true"),
  PAYFLOW_M6_SIGNING_KEY: z.string().min(40).max(4096),
  PAYFLOW_M6_SIGNING_KID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default("m6-hosted"),
  PAYPAL_EXPECTED_MERCHANT_ID: z
    .string()
    .regex(/^[A-Z0-9]{13}$|^DEMOACCOUNT01$/)
    .default("DEMOACCOUNT01"),
});
export type HostedConfig = z.infer<typeof HostedConfigSchema> & {
  /** Optional Sandbox admin secret for credential issue/revoke and sample Authority. Never logged. */
  gatewayAdminToken?: string;
  /** Scheduler credential: may call only the observation-only reconcile tick. Never logged. */
  cronSecret?: string;
  /** One alert webhook (https). When absent, alerts are persisted but not delivered. Never logged. */
  alertWebhookUrl?: string;
  /** MCP tool profile: "full" (default) or "verify-only", which never offers a tool that can start a payment. */
  mcpProfile?: "full" | "verify-only";
  /** Verify-only profile only: serve the one public verification tool without a credential. */
  mcpAnonymousVerify?: boolean;
  trustedProxyHops?: number;
  ipRateLimitPerMinute?: number;
  /** External OAuth authorization server (PayFlow is only the resource server). Both are https. */
  oauthIssuer?: string;
  oauthJwksUrl?: string;
  /** Enables self-serve /v1/sandbox/start on a clearly labelled SIMULATED rail. Off by default. */
  publicSandbox?: boolean;
  demoAgent?: z.infer<typeof DemoAgentSchema>;
  /** Raw PayPal settings; consumed only by the isolated M6 composition. Never logged. */
  paypalEnv?: Record<string, string | undefined>;
};
export function parseHostedConfig(
  env: Record<string, string | undefined>,
): HostedConfig {
  const demoAgent =
    env.PAYFLOW_M6_DEMO_AGENT === undefined
      ? undefined
      : DemoAgentSchema.parse({
          PAYFLOW_M6_DEMO_AGENT: env.PAYFLOW_M6_DEMO_AGENT,
          PAYFLOW_M6_SIGNING_KEY: env.PAYFLOW_M6_SIGNING_KEY,
          ...(env.PAYFLOW_M6_SIGNING_KID
            ? { PAYFLOW_M6_SIGNING_KID: env.PAYFLOW_M6_SIGNING_KID }
            : {}),
          ...(env.PAYPAL_EXPECTED_MERCHANT_ID
            ? { PAYPAL_EXPECTED_MERCHANT_ID: env.PAYPAL_EXPECTED_MERCHANT_ID }
            : {}),
        });
  const base = HostedConfigSchema.parse({
    PAYFLOW_M5_DEMO: env.PAYFLOW_M5_DEMO,
    DATABASE_URL: env.DATABASE_URL,
    PAYFLOW_M5_PRINCIPAL_ID: env.PAYFLOW_M5_PRINCIPAL_ID,
    PAYFLOW_M5_AGENT_ID: env.PAYFLOW_M5_AGENT_ID,
    PAYFLOW_M5_BOOTSTRAP_KEY: env.PAYFLOW_M5_BOOTSTRAP_KEY,
    ...(env.PAYFLOW_DEMO_ACCESS_CODE
      ? { PAYFLOW_DEMO_ACCESS_CODE: env.PAYFLOW_DEMO_ACCESS_CODE }
      : {}),
    PAYFLOW_M5_ORIGIN: env.PAYFLOW_M5_ORIGIN,
  });
  const adminToken = env.PAYFLOW_GATEWAY_ADMIN_TOKEN;
  if (adminToken !== undefined && adminToken.length < 32)
    throw new Error("PAYFLOW_GATEWAY_ADMIN_TOKEN_TOO_SHORT");
  const cronSecret = env.CRON_SECRET;
  if (cronSecret !== undefined && cronSecret.length < 32)
    throw new Error("CRON_SECRET_TOO_SHORT");
  const alertWebhookUrl = env.PAYFLOW_ALERT_WEBHOOK_URL;
  if (
    alertWebhookUrl !== undefined &&
    !/^https:\/\/[^\s]+$/u.test(alertWebhookUrl)
  )
    throw new Error("PAYFLOW_ALERT_WEBHOOK_URL_MUST_BE_HTTPS");
  const profile = env.PAYFLOW_MCP_PROFILE;
  if (profile !== undefined && profile !== "full" && profile !== "verify-only")
    throw new Error("PAYFLOW_MCP_PROFILE_INVALID");
  const intEnv = (name: string, min: number, max: number) => {
    const v = env[name];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name}_INVALID`);
    return n;
  };
  const trustedProxyHops = intEnv("PAYFLOW_TRUSTED_PROXY_HOPS", 0, 5);
  const ipRateLimitPerMinute = intEnv(
    "PAYFLOW_IP_RATE_LIMIT_PER_MINUTE",
    10,
    100000,
  );
  const anonymous = env.PAYFLOW_MCP_ANONYMOUS_VERIFY;
  if (anonymous !== undefined && anonymous !== "true" && anonymous !== "false")
    throw new Error("PAYFLOW_MCP_ANONYMOUS_VERIFY_INVALID");
  if (anonymous === "true" && profile !== "verify-only")
    throw new Error("PAYFLOW_MCP_ANONYMOUS_VERIFY_REQUIRES_VERIFY_ONLY");
  const issuer = env.PAYFLOW_OAUTH_ISSUER;
  const jwks = env.PAYFLOW_OAUTH_JWKS_URL;
  if ((issuer === undefined) !== (jwks === undefined))
    throw new Error("PAYFLOW_OAUTH_ISSUER_AND_JWKS_URL_GO_TOGETHER");
  for (const v of [issuer, jwks])
    if (v !== undefined && !/^https:\/\/[^\s]+$/u.test(v))
      throw new Error("PAYFLOW_OAUTH_MUST_BE_HTTPS");
  return {
    ...base,
    ...(profile ? { mcpProfile: profile } : {}),
    ...(anonymous === "true" ? { mcpAnonymousVerify: true } : {}),
    ...(trustedProxyHops !== undefined ? { trustedProxyHops } : {}),
    ...(ipRateLimitPerMinute !== undefined ? { ipRateLimitPerMinute } : {}),
    ...(issuer && jwks ? { oauthIssuer: issuer, oauthJwksUrl: jwks } : {}),
    ...(adminToken ? { gatewayAdminToken: adminToken } : {}),
    ...(cronSecret ? { cronSecret } : {}),
    ...(alertWebhookUrl ? { alertWebhookUrl } : {}),
    ...(env.PAYFLOW_PUBLIC_SANDBOX === "true" ? { publicSandbox: true } : {}),
    ...(demoAgent
      ? {
          demoAgent,
          paypalEnv: {
            PAYPAL_ENVIRONMENT: env.PAYPAL_ENVIRONMENT,
            PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
            PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
          },
        }
      : {}),
  };
}

const BUCKET_MS = 3600000;
const bucketOf = (now: Date) => Math.floor(now.getTime() / BUCKET_MS);
/** The recorded sample must be identical on every host instance, so it is a pure function of the
 * hour bucket (not of process start time). Always at least two hours in the future. */
export function hostedSample(bucket: number) {
  const expiry = new Date((bucket + 3) * BUCKET_MS).toISOString();
  return { expiry, text: demoIntentSource(expiry) };
}
export function hostedProvider(clock: () => Date): IntentModelProvider {
  return {
    interpretIntent(source) {
      const bucket = bucketOf(clock());
      // Current and previous bucket, so a sample fetched just before the hour still works.
      for (const b of [bucket, bucket - 1]) {
        const sample = hostedSample(b);
        if (source.text === sample.text)
          return new FakeIntentModelProvider(
            recordedInterpretation(source, sample.expiry),
          ).interpretIntent();
      }
      return Promise.resolve({ status: "MODEL_UNAVAILABLE" });
    },
  };
}

/** Thin adapter: HTTP -> durable host security/session -> the existing M5 services. No review,
 * confirmation, authority, activity or revoke logic is duplicated here. */
export function createHostedConsole(
  config: HostedConfig,
  deps: {
    sql?: Sql;
    clock?: () => Date;
    /** Test seam: replaces the PayPal provider built from the environment. */
    paymentProvider?: PaymentProvider | null;
    /** Test seam for alert delivery. */
    sendAlert?: (url: string, init: RequestInit) => Promise<{ ok: boolean }>;
    /** Test seam: the OAuth issuer's signing keys instead of fetching its JWKS URL. */
    oauthKeys?: JWTVerifyGetKey;
  } = {},
) {
  const clock = deps.clock ?? (() => new Date());
  const ownedSql =
    deps.sql ??
    postgres(config.DATABASE_URL, {
      max: 3,
      connect_timeout: 5,
      idle_timeout: 20,
      prepare: false,
    });
  const repo = new PostgresTrustRepository(ownedSql);
  const keys = deriveHostKeys(config.PAYFLOW_M5_BOOTSTRAP_KEY);
  const sessions = new DurableConsoleSessions(
    ownedSql,
    {
      principalId: config.PAYFLOW_M5_PRINCIPAL_ID,
      origin: config.PAYFLOW_M5_ORIGIN,
      bootstrapKey: config.PAYFLOW_M5_BOOTSTRAP_KEY,
      ...(config.PAYFLOW_DEMO_ACCESS_CODE
        ? { accessCode: config.PAYFLOW_DEMO_ACCESS_CODE }
        : {}),
    },
    clock,
  );
  const provider = hostedProvider(clock);
  const app = new ConsoleActivation(
    repo,
    sessions,
    {
      agentId: config.PAYFLOW_M5_AGENT_ID,
      provider,
      bounds: demoReviewBounds,
      pending: new PostgresPendingStore(ownedSql, keys.pending),
    },
    clock,
  );
  let demo: DemoShoppingAgent | undefined;
  let simulated: DemoShoppingAgent | undefined;
  if (config.demoAgent) {
    const privateKey = createPrivateKey(
      config.demoAgent.PAYFLOW_M6_SIGNING_KEY,
    );
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("PAYFLOW_M6_SIGNING_KEY_INVALID");
    let payment: PaymentProvider | null = null;
    let paymentReady: (() => Promise<boolean>) | undefined;
    if (deps.paymentProvider !== undefined) payment = deps.paymentProvider;
    else if (
      config.paypalEnv?.PAYPAL_ENVIRONMENT === "sandbox" &&
      config.paypalEnv.PAYPAL_CLIENT_ID &&
      config.paypalEnv.PAYPAL_CLIENT_SECRET
    ) {
      const store = new PayPalVaultStore(
        ownedSql,
        keys.paymentInstrument,
        clock,
      );
      const stored = new StoredPayPalPaymentProvider(
        new PayPalOAuthClient(
          config.paypalEnv.PAYPAL_CLIENT_ID,
          config.paypalEnv.PAYPAL_CLIENT_SECRET,
        ),
        store,
        config.PAYFLOW_M5_PRINCIPAL_ID,
      );
      payment = stored;
      paymentReady = () => stored.connected();
    }
    const signing = {
      kid: config.demoAgent.PAYFLOW_M6_SIGNING_KID,
      privateKey,
      publicKey: createPublicKey(privateKey),
    };
    demo = new DemoShoppingAgent({
      repo,
      provider: payment,
      ...(paymentReady ? { paymentReady } : {}),
      signing,
      expectedPayPalMerchantId: config.demoAgent.PAYPAL_EXPECTED_MERCHANT_ID,
      clock,
    });
    // Same merchant binding as the real rail (so one binding revision serves both); only the
    // provider differs. Reached solely by `sbx_` organizations.
    if (config.publicSandbox)
      simulated = new DemoShoppingAgent({
        repo,
        provider: new SimulatedPaymentProvider(ownedSql),
        signing,
        expectedPayPalMerchantId: config.demoAgent.PAYPAL_EXPECTED_MERCHANT_ID,
        clock,
      });
  }
  const handler = activationHttpHandler(app, {
    sample: () => hostedSample(bucketOf(clock())).text,
    controls: new ConsoleControls(repo, sessions, clock),
    activity: new ConsoleActivity(
      repo,
      sessions,
      demo?.keys ?? new StaticPublicKeyRing(new Map()),
      clock,
    ),
    review: new IntentReviewService(provider, demoReviewBounds, clock),
    ...(demo ? { demoAgent: new ConsoleDemoAgent(repo, sessions, demo) } : {}),
  });
  const gateway = demo
    ? createHostedGatewayHandler({
        sql: ownedSql,
        repo,
        demo,
        principalId: config.PAYFLOW_M5_PRINCIPAL_ID,
        agentId: config.PAYFLOW_M5_AGENT_ID,
        ...(simulated ? { simulated } : {}),
        ...mcpResourceFor(config.PAYFLOW_M5_ORIGIN),
        ...credentialIssuerFor(config.PAYFLOW_M5_ORIGIN),
        ...(config.mcpProfile ? { mcpProfile: config.mcpProfile } : {}),
        ...(config.mcpAnonymousVerify ? { mcpAnonymousVerify: true } : {}),
        ...(config.trustedProxyHops !== undefined
          ? { trustedProxyHops: config.trustedProxyHops }
          : {}),
        ...(config.ipRateLimitPerMinute !== undefined
          ? { ipRateLimitPerMinute: config.ipRateLimitPerMinute }
          : {}),
        ...(config.oauthIssuer && config.oauthJwksUrl
          ? {
              oauth: {
                issuer: config.oauthIssuer,
                keys: deps.oauthKeys ?? remoteKeys(config.oauthJwksUrl),
              },
              mcpAuthorizationServers: [config.oauthIssuer],
            }
          : {}),
        organizationId: "payflow-sandbox",
        ...(config.gatewayAdminToken
          ? { adminToken: config.gatewayAdminToken }
          : {}),
        ...(config.cronSecret ? { cronSecret: config.cronSecret } : {}),
        ...(config.alertWebhookUrl
          ? { alertWebhookUrl: config.alertWebhookUrl }
          : {}),
        ...(deps.sendAlert ? { sendAlert: deps.sendAlert } : {}),
        clock,
      })
    : undefined;
  return {
    handler: gateway
      ? async (req: IncomingMessage, res: ServerResponse) => {
          if (await gateway(req, res)) return;
          await handler(req, res);
        }
      : handler,
    close: async () => {
      if (!deps.sql) await ownedSql.end();
    },
  };
}
