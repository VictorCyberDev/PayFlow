#!/usr/bin/env node
// Verifies that a database login really is the least-privilege runtime identity.
//   DATABASE_URL=<the runtime connection string> node scripts/verify-runtime-role.mjs
// The owner runs this with their OWN environment variable. It prints pass/fail lines only: never the connection
// string, the password, or any query result containing data. Every probe that should fail is run inside a
// transaction that is rolled back, and every probe that should succeed is a read or a rolled-back write, so the
// database is left exactly as found.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is required (set it in your own shell; do not paste it anywhere)",
  );
  process.exit(2);
}
const expectedUser = process.env.EXPECTED_ROLE ?? "svc_public_rt";
const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
const results = [];
const record = (name, ok) => results.push({ name, ok });

/** Runs `fn` in a transaction that is always rolled back; resolves "ok" or the Postgres error text. */
const probe = async (fn) => {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Error("__rollback__");
    });
    return "ok";
  } catch (error) {
    return error.message === "__rollback__" ? "ok" : String(error.message);
  }
};
const refused = (text) =>
  /permission denied|must be owner|must have|cannot|not allowed|append-only/iu.test(
    text,
  );

try {
  const who = (await sql`select current_user as u, session_user as s`)[0];
  record(
    `connected as ${expectedUser}`,
    who.u === expectedUser && who.s === expectedUser,
  );

  const attrs = (
    await sql`
    select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
    from pg_roles where rolname = current_user`
  )[0];
  record("not superuser", attrs.rolsuper === false);
  record("cannot create roles", attrs.rolcreaterole === false);
  record("cannot create databases", attrs.rolcreatedb === false);
  record("does not bypass row security", attrs.rolbypassrls === false);
  record("cannot replicate", attrs.rolreplication === false);

  const memberships = (
    await sql`
    select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid
    join pg_roles r on r.oid = m.member where r.rolname = current_user order by 1`
  ).map((r) => r.rolname);
  record(
    "belongs to payflow_runtime and nothing privileged",
    memberships.includes("payflow_runtime") &&
      !memberships.some((m) => /superuser|migrator/u.test(m)),
  );

  // What the application must be able to do.
  record(
    "can read tenant data",
    (await probe((tx) => tx`select count(*) from principals`)) === "ok",
  );
  record(
    "can write tenant data (rolled back)",
    (await probe(
      (
        tx,
      ) => tx`insert into rate_limit_windows (bucket, key_hash, window_start, request_count)
      values ('verify-runtime-role', repeat('a', 64), now(), 1)`,
    )) === "ok",
  );

  // What it must NOT be able to do.
  const cannot = async (name, statement) =>
    record(
      `cannot ${name}`,
      refused(await probe((tx) => tx.unsafe(statement))),
    );
  await cannot("create a table", "create table evil_probe (x int)");
  await cannot(
    "alter a table",
    "alter table principals add column evil_probe int",
  );
  await cannot("drop a table", "drop table principals");
  await cannot(
    "truncate the append-only audit log",
    "truncate organization_audit_events",
  );
  await cannot(
    "rewrite the audit log",
    "update organization_audit_events set actor_id = actor_id",
  );
  await cannot("delete evidence", "delete from evidence_events");
  await cannot("create a role", "create role evil_probe_role");
  await cannot(
    "gain migration privileges",
    "grant payflow_migrator to current_user",
  );
  await cannot(
    "disable a trigger",
    "alter table organization_audit_events disable trigger all",
  );
} catch (error) {
  record("connected and ran the checks", false);
  console.error(
    "check run failed:",
    String(error.message)
      .replace(/postgres(ql)?:\/\/\S+/giu, "[redacted]")
      .slice(0, 160),
  );
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
const ok = results.length > 0 && results.every((r) => r.ok);
console.log(ok ? "RUNTIME ROLE VERIFIED" : "RUNTIME ROLE NOT VERIFIED");
process.exit(ok ? 0 : 1);
