// Prints the exact, ordered list of migrations the public sandbox database still needs. Reads only file names.
import {
  listMigrationFiles,
  pendingMigrations,
} from "../src/ops/migration-plan.ts";
const p = pendingMigrations(listMigrationFiles());
console.log(
  JSON.stringify(
    { count: p.length, first: p[0], last: p.at(-1), files: p },
    null,
    2,
  ),
);
