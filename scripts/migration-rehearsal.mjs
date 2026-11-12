#!/usr/bin/env node
// Migration commissioning rehearsal. Runs entirely on a LOCAL PostgreSQL; it never touches a
// deployed database and reads no credential beyond the local URL you pass it.
//
//   PGBASE=postgres://user:pass@localhost:5432 node --import tsx scripts/migration-rehearsal.mjs
//
// It answers the three questions the owner approval depends on:
//   1. Does a FRESH install of every migration succeed?
//   2. Does an UPGRADE from the deployed public baseline (001-023) succeed with the exact set the
//      owner would apply (024-latest, skipping the merchant-only one)?
//   3. Does that upgrade reach the same schema as a fresh install? Anything the upgrade path has
//      that a fresh install does not is drift and must be explained before approval.
// It then applies db/roles/least-privilege.sql to the upgraded database and asserts the grant
// invariants the runtime depends on.
//
// Exit code 0 only when every migration applied, there is no upgrade-only object, and every grant
// invariant holds. The expected fresh-only objects are the merchant-only migration's tables.
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { assertDisposableDatabase, assertScratchName } from "./lib/disposable-db.mjs";

/** The public application baseline that is actually deployed today. */
const BASELINE_MAX = 23;
/** Scoped to the separate merchant environment, deliberately not applied to the application database. */
const MERCHANT_ONLY = 28;

const base = process.env.PGBASE;
if (!base) {
  console.error("Set PGBASE, e.g. postgres://payflow:pw@localhost:5432");
  process.exit(2);
}
const FRESH_DB = process.env.FRESH_DB ?? "pf_rehearse_fresh";
const UPGRADE_DB = process.env.UPGRADE_DB ?? "pf_rehearse_upgrade";

/*
 * The rehearsal DROP/CREATE calls MUST NEVER touch the deployed Neon database.
 * Require an explicit destructive-test opt-in, verified loopback host, and
 * exactly the project's owned disposable database names before connecting.
 */
const baseUrl = new URL(base);
if (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  throw new Error("PGBASE_MUST_BE_SERVER_ONLY");
const guardUrl = new URL(base);
guardUrl.pathname = "/scratch_test";
assertDisposableDatabase(guardUrl.toString());
assertScratchName(FRESH_DB);
assertScratchName(UPGRADE_DB);
if (FRESH_DB === UPGRADE_DB)
  throw new Error("REHEARSAL_DATABASES_MUST_DIFFER");

const files = (await readdir("db/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const num = (f) => Number(f.split("_")[0]);
const baseline = files.filter((f) => num(f) <= BASELINE_MAX);
const pending = files.filter(
  (f) => num(f) > BASELINE_MAX && num(f) !== MERCHANT_ONLY,
);

const admin = postgres(`${base}/postgres`, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
for (const db of [FRESH_DB, UPGRADE_DB]) {
  await admin.unsafe(`drop database if exists ${db}`);
  await admin.unsafe(`create database ${db}`);
}
await admin.end();

async function apply(url, list, label) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const started = Date.now();
  for (const f of list) {
    try {
      await sql.unsafe(await readFile("db/migrations/" + f, "utf8"));
    } catch (error) {
      console.error(`FAILED ${label} at ${f}: ${String(error.message)}`);
      await sql.end();
      process.exit(1);
    }
  }
  await sql.end();
  return {
    label,
    files: list.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
}

/** Everything a reviewer would compare by hand: shape, rules, speed aids, behaviour, types. */
async function fingerprint(url) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const q = async (text) =>
    (await sql.unsafe(text)).map((r) => Object.values(r).join("|")).sort();
  const fp = {
    columns: await q(
      `select table_name,column_name,data_type,is_nullable,coalesce(column_default,'') from information_schema.columns where table_schema='public'`,
    ),
    constraints: await q(
      `select c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'`,
    ),
    indexes: await q(
      `select tablename,indexname,indexdef from pg_indexes where schemaname='public'`,
    ),
    triggers: await q(
      `select c.relname,t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal`,
    ),
    functions: await q(
      `select p.proname,pg_get_function_identity_arguments(p.oid),md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`,
    ),
    enums: await q(
      `select t.typname,e.enumlabel from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'`,
    ),
  };
  await sql.end();
  return fp;
}

async function grantInvariants(url) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(await readFile("db/roles/least-privilege.sql", "utf8"));
  } catch (error) {
    await sql.end();
    return { applied: false, reason: String(error.message), checks: [] };
  }
  const n = async (text) => Number((await sql.unsafe(text))[0].n);
  const checks = [];
  const add = (name, ok, detail) =>
    checks.push({ name, ok, ...(ok ? {} : { detail }) });
  add(
    "runtime holds no TRUNCATE/REFERENCES/TRIGGER",
    (await n(
      `select count(*)::int n from information_schema.role_table_grants where grantee='payflow_runtime' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')`,
    )) === 0,
    "runtime could reshape or empty a table",
  );
  add(
    "readonly is SELECT-only",
    (await n(
      `select count(*)::int n from information_schema.role_table_grants where grantee='payflow_readonly' and privilege_type <> 'SELECT'`,
    )) === 0,
    "readonly holds a write privilege",
  );
  // Secret-bearing tables must never be readable by the reporting role.
  for (const t of [
    "user_mfa",
    "user_recovery_codes",
    "user_mfa_challenges",
    "user_tokens",
    "user_sessions",
    "email_outbox",
    "organization_invitations",
  ])
    add(
      `readonly cannot read ${t}`,
      (await n(
        `select count(*)::int n from information_schema.role_table_grants where grantee='payflow_readonly' and table_name='${t}'`,
      )) === 0,
      "a secret-bearing table is readable by the reporting role",
    );
  // ...but the application must still be able to use them, or sign-in breaks.
  for (const t of ["user_mfa", "user_mfa_challenges"])
    add(
      `runtime can use ${t}`,
      (await n(
        `select count(*)::int n from information_schema.role_table_grants where grantee='payflow_runtime' and table_name='${t}' and privilege_type in ('SELECT','INSERT','UPDATE')`,
      )) >= 3,
      "the app cannot operate two-step sign-in",
    );
  add(
    "group roles are NOLOGIN",
    (await n(
      `select count(*)::int n from pg_roles where rolname in ('payflow_migrator','payflow_runtime','payflow_readonly') and rolcanlogin`,
    )) === 0,
    "a group role can log in directly",
  );
  await sql.end();
  return { applied: true, checks };
}

const runs = [
  await apply(
    `${base}/${FRESH_DB}`,
    files,
    `FRESH 001-${String(num(files.at(-1))).padStart(3, "0")}`,
  ),
  await apply(`${base}/${UPGRADE_DB}`, baseline, "BASELINE 001-023"),
  await apply(
    `${base}/${UPGRADE_DB}`,
    pending,
    `UPGRADE 024+ (skipping ${MERCHANT_ONLY})`,
  ),
];

const [fresh, upgraded] = [
  await fingerprint(`${base}/${FRESH_DB}`),
  await fingerprint(`${base}/${UPGRADE_DB}`),
];
const drift = {};
for (const k of Object.keys(fresh)) {
  const freshOnly = fresh[k].filter((x) => !upgraded[k].includes(x));
  const upgradeOnly = upgraded[k].filter((x) => !fresh[k].includes(x));
  if (freshOnly.length || upgradeOnly.length)
    drift[k] = {
      freshOnly: freshOnly.length,
      upgradeOnly: upgradeOnly.length,
      examples: upgradeOnly.slice(0, 5),
    };
}
// A fresh-only object is expected (the merchant migration is skipped). An upgrade-only object is not.
const upgradeOnlyTotal = Object.values(drift).reduce(
  (a, d) => a + d.upgradeOnly,
  0,
);
const freshOnlyTables = [
  ...new Set(
    fresh.columns
      .filter((x) => !upgraded.columns.includes(x))
      .map((x) => x.split("|")[0]),
  ),
].sort();

const grants = await grantInvariants(`${base}/${UPGRADE_DB}`);
const grantFailures = grants.checks.filter((c) => !c.ok);
const ok =
  upgradeOnlyTotal === 0 && grants.applied && grantFailures.length === 0;

console.log(
  JSON.stringify(
    {
      ok,
      migrations: {
        total: files.length,
        baseline: baseline.length,
        pending: pending.length,
        merchantOnlySkipped: MERCHANT_ONLY,
      },
      runs,
      schema: {
        counts: Object.fromEntries(
          Object.entries(fresh).map(([k, v]) => [k, v.length]),
        ),
        upgradeOnlyObjects: upgradeOnlyTotal,
        freshOnlyTables,
        drift,
      },
      grants: {
        applied: grants.applied,
        checks: grants.checks.length,
        failed: grantFailures,
      },
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
