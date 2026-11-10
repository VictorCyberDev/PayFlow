import { readdirSync } from "node:fs";

/**
 * Which migrations a target database still needs. The public sandbox database holds exactly 001-023 (determined 2026-11-10 by comparing each file's
 * CREATE TABLE names with the tables that exist). Migration 028 (merchant verify stores) belongs to the separately intended merchant environment and
 * is not applied to the PayFlow application database; nothing in src/ reads its tables.
 */
export const PUBLIC_APPLIED_THROUGH = 23;
export const SKIP_FOR_APPLICATION_DB: readonly number[] = [28];
export function pendingMigrations(
  files: readonly string[],
  appliedThrough = PUBLIC_APPLIED_THROUGH,
  skip: readonly number[] = SKIP_FOR_APPLICATION_DB,
): string[] {
  return files
    .filter((f) => /^\d{3}_.*\.sql$/u.test(f))
    .sort()
    .filter((f) => {
      const n = Number(f.slice(0, 3));
      return n > appliedThrough && !skip.includes(n);
    });
}
export const listMigrationFiles = (dir = "db/migrations") => readdirSync(dir);
