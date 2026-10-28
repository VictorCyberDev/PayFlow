#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { JsonWebKey } from "node:crypto";
import { verifyPortableProof } from "./index.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

async function main() {
  const [proofPath, jwkPath] = process.argv.slice(2);
  if (!proofPath || !jwkPath) {
    console.error("usage: payflow-verify <proof.json> <public-jwk.json>");
    process.exitCode = 2;
    return;
  }
  const [proof, jwk] = await Promise.all([
    readJson(proofPath),
    readJson(jwkPath) as Promise<JsonWebKey>,
  ]);
  const result = verifyPortableProof(proof, jwk, new Date().toISOString());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}

void main();
