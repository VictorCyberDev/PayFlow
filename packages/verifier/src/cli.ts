#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { JsonWebKey } from "node:crypto";
import { verifyPortableProof } from "./index.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

async function main() {
  const args = process.argv.slice(2);
  const ageFlag = args.indexOf("--max-age");
  // Historical evidence is verified by authenticity. Freshness is opt-in: --max-age <seconds>.
  const maxAge = ageFlag >= 0 ? Number(args[ageFlag + 1]) : null;
  const [proofPath, jwkPath] = args.filter(
    (a, i) => !a.startsWith("--") && args[i - 1] !== "--max-age",
  );
  if (!proofPath || !jwkPath || (maxAge !== null && !(maxAge > 0))) {
    console.error(
      "usage: payflow-verify <proof.json> <public-jwk.json> [--max-age <seconds>]",
    );
    process.exitCode = 2;
    return;
  }
  const [proof, jwk] = await Promise.all([
    readJson(proofPath),
    readJson(jwkPath) as Promise<JsonWebKey>,
  ]);
  const result = verifyPortableProof(
    proof,
    jwk,
    new Date().toISOString(),
    maxAge,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}

void main();
