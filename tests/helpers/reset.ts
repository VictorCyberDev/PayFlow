import type { Sql } from "postgres";

/**
 * Test cleanup only. `organization_audit_events` refuses UPDATE, DELETE and TRUNCATE in production
 * (migration 021), and `TRUNCATE organizations CASCADE` reaches it. Tests that reset tenant data
 * suspend the truncate guard for that one statement, then restore it. Never used outside tests.
 */
export async function truncateTenantData(
  sql: Sql,
  tables: string,
): Promise<void> {
  const guard = "organization_audit_events_no_truncate";
  await sql.unsafe(
    `alter table organization_audit_events disable trigger ${guard}`,
  );
  try {
    await sql.unsafe(`truncate ${tables} restart identity cascade`);
  } finally {
    await sql.unsafe(
      `alter table organization_audit_events enable trigger ${guard}`,
    );
  }
}
