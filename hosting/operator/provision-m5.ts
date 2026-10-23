/**
 * OPERATOR-ONLY provisioning for the isolated NON-PRODUCTION M5 demo database.
 *
 * Run locally by a trusted operator with the target DATABASE_URL in the environment:
 *   DATABASE_URL=... PAYFLOW_M5_PRINCIPAL_ID=... PAYFLOW_M5_AGENT_ID=... \
 *     node --import tsx hosting/operator/provision-m5.ts
 * It is never deployed, never exposed over HTTP, and prints no secret value.
 *
 * It applies migrations 001-010 to an empty database (or only 010 to a database that already has
 * 001-009 but no host-state tables), then provisions exactly one principal, one AgentPassport and
 * one activation policy. It REFUSES to run against a database that holds any payment, grant,
 * reservation or provider-observation history, so historical M4 evidence is never reused.
 */
import { readdir, readFile } from "node:fs/promises";
import { PostgresTrustRepository } from "../../src/persistence.js";
import {
  HumanConfirmationBoundary,
  IntentActivationService,
} from "../../src/intent-activation.js";

const url = process.env.DATABASE_URL;
const principalId = process.env.PAYFLOW_M5_PRINCIPAL_ID;
const agentId = process.env.PAYFLOW_M5_AGENT_ID;
if (!url || !principalId || !agentId) {
  console.error(
    "DATABASE_URL, PAYFLOW_M5_PRINCIPAL_ID and PAYFLOW_M5_AGENT_ID are required",
  );
  process.exit(2);
}
const repo = PostgresTrustRepository.connect(url);
try {
  const migrations = (await readdir("db/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const has = async (table: string) =>
    (
      await repo.sql`select to_regclass(${"public." + table}) is not null as present`
    )[0]!.present as boolean;
  if (!(await has("principals"))) {
    for (const name of migrations)
      await repo.migrate(await readFile("db/migrations/" + name, "utf8"));
    console.log(`applied migrations: ${migrations.length}`);
  } else {
    // Isolation guard: any financial history means this is not an isolated M5 database.
    for (const table of [
      "payment_attempts",
      "authorization_reservations",
      "execution_grants",
      "transaction_proposals",
      "paypal_provider_observations",
    ]) {
      const [r] = await repo.sql.unsafe(`select count(*) n from ${table}`);
      if (Number(r!.n) > 0) {
        console.error(
          `REFUSED: ${table} is not empty; use a separate isolated database for M5`,
        );
        process.exit(3);
      }
    }
    if (!(await has("console_demo_sessions"))) {
      const host = migrations.find((n) => n.startsWith("010_"));
      if (!host) throw new Error("MIGRATION_010_MISSING");
      await repo.migrate(await readFile("db/migrations/" + host, "utf8"));
      console.log("applied migration: 010");
    }
  }
  const now = new Date();
  await repo.savePrincipal({ id: principalId, displayName: "M5 demo owner" });
  if (!(await repo.getAgent(agentId, undefined, false)))
    await repo.saveAgent({
      id: agentId,
      principalId,
      displayName: "Shopping Agent",
      issuedAt: new Date(now.getTime() - 86400000).toISOString(),
      expiresAt: new Date(now.getTime() + 90 * 86400000).toISOString(),
      status: "ACTIVE",
      capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
    });
  await new IntentActivationService(
    repo,
    new HumanConfirmationBoundary({
      verify: () => Promise.reject(new Error("NO_PROVISIONING_AUTH_BYPASS")),
    }),
  ).provisionPolicy(principalId, {
    version: "payflow.activation-policy.v1",
    maximumMinor: 10000,
    maximumQuantity: 1,
    currencies: ["USD"],
    capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
    merchantIds: ["DemoMerchant"],
    merchantRiskCeiling: "LOW",
    maximumLifetimeSeconds: 86400 * 30,
  });
  console.log(
    "provisioned: 1 principal, 1 agent passport, 1 activation policy",
  );
} finally {
  await repo.close();
}
