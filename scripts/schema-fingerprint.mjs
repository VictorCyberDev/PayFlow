#!/usr/bin/env node
// Catalog fingerprint of the application database (see src/ops/schema-fingerprint.ts).
//   node --import tsx scripts/schema-fingerprint.mjs snapshot <N> [adminUrl]   apply migrations 001..N (skipping 028) to a scratch database and write docs/ops/schema-fingerprint-<N>.json
//   node --import tsx scripts/schema-fingerprint.mjs sql <N> [compact]       print the read-only comparison statement for a database that should be at N
//   node --import tsx scripts/schema-fingerprint.mjs check <N> <databaseUrl>    run it (read-only) against a database and report the differences
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import {
  assertDisposableDatabase,
  assertScratchName,
} from "./lib/disposable-db.mjs";
import {
  FINGERPRINT_SELECT,
  comparisonSql,
  compactComparisonSql,
} from "../src/ops/schema-fingerprint.ts";

const [cmd, nRaw, target] = process.argv.slice(2);
const compact = target === "compact";
const through = Number(nRaw);
const file = `docs/ops/schema-fingerprint-${String(through).padStart(3, "0")}.json`;
if (!["snapshot", "sql", "check"].includes(cmd) || !Number.isInteger(through)) {
  console.error("usage: schema-fingerprint.mjs snapshot|sql|check <N> [url]");
  process.exit(2);
}
if (cmd === "snapshot") {
  const adminUrl =
    target ??
    process.env.ACCEPT_ADMIN_URL ??
    "postgres://payflow:payflow_test@localhost:5432/payflow_test";
  assertDisposableDatabase(adminUrl);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const db = assertScratchName(
    "fp_" + Math.random().toString(36).slice(2, 8).padEnd(6, "0"),
  );
  await admin.unsafe(`create database ${db}`);
  const u = new URL(
    target ??
      process.env.ACCEPT_ADMIN_URL ??
      "postgres://payflow:payflow_test@localhost:5432/payflow_test",
  );
  u.pathname = `/${db}`;
  const sql = postgres(u.toString(), { max: 1, onnotice: () => undefined });
  try {
    for (const f of readdirSync("db/migrations")
      .filter((x) => /^\d{3}_.*\.sql$/u.test(x))
      .sort()) {
      const n = Number(f.slice(0, 3));
      if (n > through || n === 28) continue;
      await sql.unsafe(readFileSync(`db/migrations/${f}`, "utf8"));
    }
    const rows = await sql.unsafe(FINGERPRINT_SELECT);
    const objects = Object.fromEntries(rows.map((r) => [r.k, r.h]));
    writeFileSync(
      file,
      JSON.stringify(
        {
          through,
          note: "produced by applying migrations 001..N (028 skipped) to a scratch PostgreSQL; compare with comparisonSql",
          objects,
        },
        null,
        1,
      ) + "\n",
    );
    console.log(`${file}: ${rows.length} objects`);
  } finally {
    await sql.end({ timeout: 1 });
    await admin.unsafe(`drop database if exists ${db} with (force)`);
    await admin.end({ timeout: 1 });
  }
} else {
  const fp = JSON.parse(readFileSync(file, "utf8"));
  const statement = compact ? compactComparisonSql(fp) : comparisonSql(fp);
  if (cmd === "sql") console.log(statement);
  else {
    const sql = postgres(target, { max: 1, onnotice: () => undefined });
    try {
      const diffs = await sql.unsafe(statement);
      console.log(
        JSON.stringify(
          { through, differences: diffs.length, first: diffs.slice(0, 25) },
          null,
          1,
        ),
      );
      process.exitCode = diffs.length ? 1 : 0;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
