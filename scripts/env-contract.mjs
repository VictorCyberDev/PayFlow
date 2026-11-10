// Usage: node --import tsx scripts/env-contract.mjs [--from-env | names.txt]
// Prints which variable NAMES are missing for the hosted customer application. It never prints, logs or stores a value.
import { readFileSync } from "node:fs";
import { assess, ENV_CONTRACT } from "../src/ops/env-contract.ts";

const arg = process.argv[2];
const names = new Set(
  arg === "--from-env" || arg === undefined
    ? Object.keys(process.env)
    : readFileSync(arg, "utf8").split(/\s+/u).filter(Boolean),
);
const r = assess(names);
console.log(
  JSON.stringify(
    {
      ...r,
      secretNames: ENV_CONTRACT.filter((v) => v.secret).map((v) => v.name),
    },
    null,
    2,
  ),
);
process.exit(r.ready ? 0 : 1);
