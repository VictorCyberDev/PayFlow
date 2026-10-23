/**
 * TEST-ONLY browser E2E host. Not product code and never deployed.
 *
 * Wires exactly the components of the opt-in activation host (same HTTP
 * handler, sessions, recorded model, owner-bound controls/activity) against an
 * isolated PostgreSQL database with an adjustable clock. A separate loopback
 * control port lets the browser spec advance time, revoke "from another
 * device" and count financial rows. The control port is never reachable from
 * the browser origin and exposes no product capability.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresTrustRepository } from "../src/persistence.js";
import { ConsoleSessions } from "../src/console-session.js";
import { ConsoleActivation } from "../src/console-activation.js";
import { ConsoleControls } from "../src/console-controls.js";
import { ConsoleActivity } from "../src/activity-postgres.js";
import { StaticPublicKeyRing } from "../src/execution-grant.js";
import { activationHttpHandler } from "../src/console-activation-host.js";
import { IntentReviewService } from "../src/intent-review.js";
import {
  demoIntentSource,
  demoReviewBounds,
  recordedInterpretation,
} from "../src/intent-review-demo.js";
import {
  FakeIntentModelProvider,
  type IntentModelProvider,
} from "../src/intent-model.js";
import {
  IntentActivationService,
  HumanConfirmationBoundary,
} from "../src/intent-activation.js";

const databaseUrl = process.env.E2E_DATABASE_URL;
const bootstrapKey = process.env.E2E_BOOTSTRAP_KEY;
if (!databaseUrl || !bootstrapKey || bootstrapKey.length < 32)
  throw new Error("E2E_CONFIGURATION_REQUIRED");
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const repo = PostgresTrustRepository.connect(databaseUrl);
await repo.sql`drop schema public cascade`;
await repo.sql`create schema public`;
for (const name of (await readdir("db/migrations"))
  .filter((n) => n.endsWith(".sql"))
  .sort())
  await repo.migrate(await readFile("db/migrations/" + name, "utf8"));
async function seed() {
  await repo.sql`truncate principals cascade`;
  await repo.sql`truncate evidence_events restart identity`;
  await repo.savePrincipal({ id: "e2e-owner", displayName: "Demo owner" });
  await repo.saveAgent({
    id: "e2e-agent",
    principalId: "e2e-owner",
    displayName: "Shopping Agent",
    issuedAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    status: "ACTIVE",
    capabilities,
  });
  await new IntentActivationService(
    repo,
    new HumanConfirmationBoundary(
      { verify: () => Promise.reject(new Error("NO_TEST_AUTH_BYPASS")) },
      clock,
    ),
    clock,
  ).provisionPolicy("e2e-owner", {
    version: "payflow.activation-policy.v1",
    maximumMinor: 10000,
    maximumQuantity: 1,
    currencies: ["USD"],
    capabilities,
    merchantIds: ["DemoMerchant"],
    merchantRiskCeiling: "LOW",
    maximumLifetimeSeconds: 86400 * 30,
  });
}
await seed();
const expiry = new Date(Date.now() + 3600000).toISOString();
const sample = demoIntentSource(expiry);
const provider: IntentModelProvider = {
  interpretIntent(source) {
    if (source.text !== sample)
      return Promise.resolve({ status: "MODEL_UNAVAILABLE" });
    return new FakeIntentModelProvider(
      recordedInterpretation(source, expiry),
    ).interpretIntent();
  },
};
const web = createServer((req, res) => {
  void handler(req, res);
});
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
const sessions = new ConsoleSessions(
  { principalId: "e2e-owner", origin, bootstrapKey },
  clock,
);
const handler = activationHttpHandler(
  new ConsoleActivation(
    repo,
    sessions,
    { agentId: "e2e-agent", provider, bounds: demoReviewBounds },
    clock,
  ),
  {
    sample,
    controls: new ConsoleControls(repo, sessions, clock),
    activity: new ConsoleActivity(
      repo,
      sessions,
      new StaticPublicKeyRing(new Map()),
      clock,
    ),
    review: new IntentReviewService(provider, demoReviewBounds, clock),
    outputDirectory: resolve("apps/console/out"),
  },
);
const TABLES = [
  "mandates",
  "payment_attempts",
  "authorization_reservations",
  "execution_grants",
  "transaction_proposals",
  "paypal_provider_observations",
];
const control = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://control");
    const reply = (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/advance") {
      offsetMs += Number(url.searchParams.get("seconds")) * 1000;
      return reply({ ok: true });
    }
    if (url.pathname === "/reset") {
      // Move past the accepted 60s login-guessing window instead of weakening it.
      offsetMs += 61000;
      await seed();
      return reply({ ok: true });
    }
    if (url.pathname === "/revoke") {
      await repo.revokeMandate(
        String(url.searchParams.get("mandateId")),
        clock().toISOString(),
      );
      return reply({ ok: true });
    }
    if (url.pathname === "/counts") {
      const out: Record<string, number> = {};
      for (const t of TABLES)
        out[t] = Number(
          (await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n,
        );
      const ev =
        await repo.sql`select type,count(*) n from evidence_events group by type`;
      out.MANDATE_REVOKED = Number(
        ev.find((e) => e.type === "MANDATE_REVOKED")?.n ?? 0,
      );
      out.events = ev.reduce((a, e) => a + Number(e.n), 0);
      return reply(out);
    }
    res.writeHead(404).end();
  })().catch(() => res.writeHead(500).end());
});
await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
console.log(
  "E2E_READY " +
    JSON.stringify({
      origin,
      control: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    }),
);
