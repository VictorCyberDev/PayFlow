/**
 * A catalog fingerprint of the application database: one hash per table (column names, types, nullability), index, trigger, function, constraint and
 * enum in the public schema. Function bodies are compared with comments and whitespace removed: the public database was built by a tool that collapsed lines and
 * stripped comments, which does not change what a function does. It is the authoritative check that a database really is at migration N, because the project has no migrations table:
 * the committed snapshot is produced by actually applying migrations 001..N to a scratch database, and `comparisonSql` compares any database to it
 * with one read-only query that returns only the differences.
 *
 * It reads the catalog and nothing else. It never reads application rows, and it needs no write access.
 */
export const FINGERPRINT_SELECT = `
select 'table:' || c.relname as k, md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attname)) as h
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'public' and c.relkind in ('r','p') group by c.relname
union all
select 'index:' || indexname || '@' || tablename, md5(regexp_replace(indexdef, '\\s+', ' ', 'g')) from pg_indexes where schemaname = 'public'
union all
select 'trigger:' || t.tgname || '@' || c.relname, md5(pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
union all
select 'function:' || p.proname, md5(string_agg(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g')), '|' order by btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g'))))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' group by p.proname
union all
select 'constraint:' || con.conname || '@' || c.relname, md5(pg_get_constraintdef(con.oid))
  from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and con.contype <> 'n'
union all
select 'enum:' || t.typname, md5(string_agg(e.enumlabel, ',' order by e.enumsortorder))
  from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' group by t.typname`;

import { createHash } from "node:crypto";

/** Which relation an object belongs to, so many objects can be compared as one (tables carry their indexes, triggers and constraints). */
export const relationOf = (k: string): string =>
  k.startsWith("table:")
    ? k.slice(6)
    : /^(index|trigger|constraint):/u.test(k)
      ? (k.split("@")[1] ?? k)
      : k;

export interface Fingerprint {
  readonly through: number;
  readonly objects: Readonly<Record<string, string>>;
}

export type Difference = {
  k: string;
  status: "MISSING" | "DIFFERENT" | "UNEXPECTED";
};

/** One read-only statement: the objects that are missing, different or unexpected compared with the snapshot. An empty result means the database matches. */
export function comparisonSql(fp: Fingerprint): string {
  const rows = Object.entries(fp.objects)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, h]) => `('${k.replace(/'/gu, "''")}','${h}')`)
    .join(",");
  return `with live(k, h) as (${FINGERPRINT_SELECT}),
expected(k, h) as (values ${rows})
select coalesce(e.k, l.k) as k,
  case when l.k is null then 'MISSING' when e.k is null then 'UNEXPECTED' else 'DIFFERENT' end as status
from live l full join expected e on e.k = l.k
where l.h is distinct from e.h
order by 1`;
}

/**
 * The same comparison at the granularity of one hash per relation (about 90 rows instead of hundreds), small enough to run through any SQL console.
 * A difference names the table or function; run `comparisonSql` for the exact object.
 */
export function compactComparisonSql(fp: Fingerprint): string {
  const groups = new Map<string, string[]>();
  for (const [k, h] of Object.entries(fp.objects)) {
    const r = relationOf(k);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(k + h);
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([r, parts]) => {
      const h = createHash("md5").update(parts.sort().join(",")).digest("hex");
      return `('${r.replace(/'/gu, "''")}','${h}')`;
    })
    .join(",");
  return `with live0(k, h) as (${FINGERPRINT_SELECT}),
rel as (
  select case when k like 'table:%' then substr(k, 7)
              when k ~ '^(index|trigger|constraint):' then split_part(k, '@', 2)
              else k end as r, k || h as part from live0),
live(k, h) as (select r, md5(string_agg(part, ',' order by part)) from rel group by r),
expected(k, h) as (values ${rows})
select coalesce(e.k, l.k) as k,
  case when l.k is null then 'MISSING' when e.k is null then 'UNEXPECTED' else 'DIFFERENT' end as status
from live l full join expected e on e.k = l.k
where l.h is distinct from e.h
order by 1`;
}
