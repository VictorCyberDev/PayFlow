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

/** Hosted NON-PRODUCTION demo configuration. Every value is operator-supplied privately; none
 * is ever logged, rendered or returned. */
const HostedConfigSchema = z.object({
  PAYFLOW_M5_DEMO: z.literal("true"),
  DATABASE_URL: z.string().min(1),
  PAYFLOW_M5_PRINCIPAL_ID: z.string().min(1).max(128),
  PAYFLOW_M5_AGENT_ID: z.string().min(1).max(128),
  PAYFLOW_M5_BOOTSTRAP_KEY: z.string().min(32).max(256),
  PAYFLOW_M5_ORIGIN: z.string().url(),
});
export type HostedConfig = z.infer<typeof HostedConfigSchema>;
export function parseHostedConfig(
  env: Record<string, string | undefined>,
): HostedConfig {
  return HostedConfigSchema.parse({
    PAYFLOW_M5_DEMO: env.PAYFLOW_M5_DEMO,
    DATABASE_URL: env.DATABASE_URL,
    PAYFLOW_M5_PRINCIPAL_ID: env.PAYFLOW_M5_PRINCIPAL_ID,
    PAYFLOW_M5_AGENT_ID: env.PAYFLOW_M5_AGENT_ID,
    PAYFLOW_M5_BOOTSTRAP_KEY: env.PAYFLOW_M5_BOOTSTRAP_KEY,
    PAYFLOW_M5_ORIGIN: env.PAYFLOW_M5_ORIGIN,
  });
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
  deps: { sql?: Sql; clock?: () => Date } = {},
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
  const handler = activationHttpHandler(app, {
    sample: () => hostedSample(bucketOf(clock())).text,
    controls: new ConsoleControls(repo, sessions, clock),
    activity: new ConsoleActivity(
      repo,
      sessions,
      new StaticPublicKeyRing(new Map()),
      clock,
    ),
    review: new IntentReviewService(provider, demoReviewBounds, clock),
  });
  return {
    handler,
    close: async () => {
      if (!deps.sql) await ownedSql.end();
    },
  };
}
