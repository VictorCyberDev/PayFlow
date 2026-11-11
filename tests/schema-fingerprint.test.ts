/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  compactComparisonSql,
  comparisonSql,
  type Fingerprint,
} from "../src/ops/schema-fingerprint.js";

/** The committed snapshot must be what migrations 001-023 really produce, and every kind of drift must be reported. */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("schema fingerprint", () => {
  const fp = JSON.parse(
    readFileSync("docs/ops/schema-fingerprint-023.json", "utf8"),
  ) as Fingerprint;
  it("matches a database built from migrations 001-023, and detects each kind of drift", async () => {
    const base = url!.replace(/\/[^/]*$/u, "");
    const db = "fp_test_" + Math.random().toString(36).slice(2, 8);
    execFileSync("psql", [url!, "-qc", `create database ${db}`], {
      stdio: "pipe",
    });
    const sql = postgres(`${base}/${db}`, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      for (const f of readdirSync("db/migrations")
        .filter((x) => /^\d{3}_.*\.sql$/u.test(x))
        .sort()
        .filter((x) => Number(x.slice(0, 3)) <= 23))
        await sql.unsafe(readFileSync(`db/migrations/${f}`, "utf8"));
      const both = async () => ({
        full: await sql.unsafe(comparisonSql(fp)),
        compact: await sql.unsafe(compactComparisonSql(fp)),
      });
      const clean = await both();
      expect(clean.full).toHaveLength(0);
      expect(clean.compact).toHaveLength(0);

      // an index is gone
      const idx = (
        await sql`select indexname from pg_indexes where schemaname = 'public' and indexname not in (select conname from pg_constraint) limit 1`
      )[0]!.indexname as string;
      await sql.unsafe(`drop index "${idx}"`);
      let d = await both();
      expect(d.full.map((r) => [r.k, r.status])).toEqual([
        [expect.stringContaining(`index:${idx}@`), "MISSING"],
      ]);
      expect(d.compact).toHaveLength(1);

      // a column changed type
      const col = (
        await sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'text' and table_name = 'organizations' limit 1`
      )[0]!;
      await sql.unsafe(
        `alter table "${col.table_name}" alter column "${col.column_name}" type varchar(500)`,
      );
      d = await both();
      expect(d.full.some((r) => r.status === "DIFFERENT")).toBe(true);

      // an object that should not be there
      await sql.unsafe(`create table not_in_any_migration (x int)`);
      d = await both();
      expect(
        d.full.some(
          (r) =>
            r.k === "table:not_in_any_migration" && r.status === "UNEXPECTED",
        ),
      ).toBe(true);
      expect(d.compact.some((r) => r.k === "not_in_any_migration")).toBe(true);

      // a trigger is gone
      const trg = (
        await sql`select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal limit 1`
      )[0]!;
      await sql.unsafe(`drop trigger "${trg.tgname}" on "${trg.relname}"`);
      d = await both();
      expect(
        d.full.some(
          (r) =>
            r.k.startsWith(`trigger:${trg.tgname}@`) && r.status === "MISSING",
        ),
      ).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
      execFileSync(
        "psql",
        [url!, "-qc", `drop database if exists ${db} with (force)`],
        {
          stdio: "pipe",
        },
      );
    }
  }, 120_000);
});
