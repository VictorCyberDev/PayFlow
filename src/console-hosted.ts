import { createPrivateKey, createPublicKey } from "node:crypto";
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
import { PayPalOAuthClient, type PaymentProvider } from "./paypal.js";
import {
  PayPalVaultStore,
  StoredPayPalPaymentProvider,
} from "./paypal-vault-bootstrap.js";

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
  return {
    ...base,
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
    demo = new DemoShoppingAgent({
      repo,
      provider: payment,
      ...(paymentReady ? { paymentReady } : {}),
      signing: {
        kid: config.demoAgent.PAYFLOW_M6_SIGNING_KID,
        privateKey,
        publicKey: createPublicKey(privateKey),
      },
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
  return {
    handler,
    close: async () => {
      if (!deps.sql) await ownedSql.end();
    },
  };
}
