#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { verifyPortableProof } from "./index.js";

async function main() {
  const [proofPath, jwkPath] = process.argv.slice(2);
  if (!proofPath || !jwkPath) {
    console.error("usage: payflow-verify <proof.json> <public-jwk.json>");
    process.exitCode = 2;
    return;
  }
  const [proof, jwk] = await Promise.all([
    readFile(proofPath, "utf8").then(JSON.parse),
    readFile(jwkPath, "utf8").then(JSON.parse),
  ]);
  const result = verifyPortableProof(proof, jwk, new Date().toISOString());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}

void main();
