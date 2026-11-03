#!/usr/bin/env node
// M14 restore rehearsal. NEVER touches the source destructively: it only READS the source, restores
// a copy into a throw-away database, verifies it, and drops the copy.
//
//   SOURCE_URL=postgres://...  ADMIN_URL=postgres://.../postgres  node scripts/restore-rehearsal.mjs
//
// Checks: every public table's row count matches; every constraint is validated; the append-only
// audit triggers survived the restore; the restored audit log still refuses UPDATE. Prints a JSON
// report with NO connection strings or credentials.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const source = process.env.SOURCE_URL;
const admin = process.env.ADMIN_URL;
if (!source || !admin) {
  console.error("SOURCE_URL and ADMIN_URL are required");
  process.exit(2);
}
const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = "/" + db;
  return u.toString();
};
const target = `rehearsal_${Date.now()}`;
const dir = mkdtempSync(join(tmpdir(), "restore-"));
const dump = join(dir, "backup.dump");
const report = { startedAt: new Date().toISOString(), steps: [], ok: false };
const step = (name, detail = {}) => report.steps.push({ name, ...detail });

const counts = async (sql) => {
  const tables =
    await sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`;
  const out = {};
  for (const t of tables)
    out[t.table_name] = Number(
      (
        await sql.unsafe(`select count(*)::int n from public."${t.table_name}"`)
      )[0].n,
    );
  return out;
};
const src = postgres(source, { max: 1, onnotice: () => {} });
const adm = postgres(admin, { max: 1, onnotice: () => {} });
let dst;
try {
  const before = await counts(src);
  step("source counted", {
    tables: Object.keys(before).length,
    rows: Object.values(before).reduce((a, b) => a + b, 0),
  });

  execFileSync(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${dump}`,
      source,
    ],
    { stdio: "pipe" },
  );
  step("dumped");

  await adm.unsafe(`create database ${target}`);
  const targetUrl = withDb(admin, target);
  execFileSync(
    "pg_restore",
    [
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      `--dbname=${targetUrl}`,
      dump,
    ],
    { stdio: "pipe" },
  );
  step("restored into an isolated database");

  dst = postgres(targetUrl, { max: 1, onnotice: () => {} });
  const after = await counts(dst);
  const mismatched = Object.keys(before).filter((t) => before[t] !== after[t]);
  const missing = Object.keys(before).filter((t) => !(t in after));
  step("row counts compared", {
    tablesCompared: Object.keys(before).length,
    mismatched,
    missing,
  });

  const unvalidated =
    await dst`select conrelid::regclass::text t, conname from pg_constraint where not convalidated`;
  step("constraints validated", { unvalidated: unvalidated.length });

  const triggers =
    await dst`select tgname from pg_trigger where tgname in ('organization_audit_events_no_update','organization_audit_events_no_truncate') and not tgisinternal`;
  step("append-only audit triggers present", {
    found: triggers.map((t) => t.tgname).sort(),
  });

  let auditStillImmutable = null;
  const auditRows = after["organization_audit_events"] ?? 0;
  if (auditRows > 0) {
    try {
      await dst`update organization_audit_events set actor_id = actor_id`;
      auditStillImmutable = false;
    } catch {
      auditStillImmutable = true;
    }
  }
  step("restored audit log still refuses UPDATE", {
    auditRows,
    immutable: auditStillImmutable,
  });

  report.ok =
    mismatched.length === 0 &&
    missing.length === 0 &&
    unvalidated.length === 0 &&
    triggers.length === 2 &&
    (auditStillImmutable === null || auditStillImmutable === true);
} catch (e) {
  step("failed", {
    error: String(e.message)
      .replace(/postgres(ql)?:\/\/\S+/giu, "[redacted-url]")
      .slice(0, 200),
  });
} finally {
  try {
    await dst?.end();
  } catch {}
  try {
    await adm.unsafe(`drop database if exists ${target}`);
    step("rehearsal database dropped");
  } catch {}
  await adm.end();
  await src.end();
  rmSync(dir, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
