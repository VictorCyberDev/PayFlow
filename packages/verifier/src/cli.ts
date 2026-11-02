#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { JsonWebKey } from "node:crypto";
import {
  explainProof,
  matchesExpected,
  selectKey,
  verifyPortableProof,
} from "./index.js";

const USAGE = `usage: payflow verify <proof.json> --key <public-jwk.json | keys.json> [options]
  --json                 machine-readable output
  --max-age <seconds>    also require freshness (historical proofs verify by authenticity)
  --expect-issuer <id>   --expect-agent <id>   --expect-authority <id>
  --expect-amount <minor units>   --expect-currency <ISO>   --expect-merchant <id>
Exit: 0 verified and matches expectations, 1 not verified or mismatch, 2 usage.`;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const FLAGS_WITH_VALUE = new Set([
  "--key",
  "--keys",
  "--max-age",
  "--expect-issuer",
  "--expect-agent",
  "--expect-authority",
  "--expect-amount",
  "--expect-currency",
  "--expect-merchant",
]);

async function main() {
  let args = process.argv.slice(2);
  if (args[0] === "verify") args = args.slice(1);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.has(args[i - 1] ?? ""),
  );
  const proofPath = positional[0];
  // Legacy form: payflow-verify <proof.json> <public-jwk.json>
  const keyPath = flag("--key") ?? flag("--keys") ?? positional[1];
  const asJson = args.includes("--json");
  const maxAgeRaw = flag("--max-age");
  const maxAge = maxAgeRaw === undefined ? null : Number(maxAgeRaw);
  const amountRaw = flag("--expect-amount");
  if (
    !proofPath ||
    !keyPath ||
    (maxAge !== null && !(maxAge > 0)) ||
    (amountRaw !== undefined && !Number.isSafeInteger(Number(amountRaw)))
  ) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const [proof, keyDoc] = await Promise.all([
    readJson(proofPath),
    readJson(keyPath),
  ]);
  // Accept either a single public JWK or the GET /v1/keys document.
  const keyId = (proof as { keyId?: string }).keyId;
  const jwk = (
    (keyDoc as { keys?: unknown }).keys
      ? keyId
        ? selectKey(keyDoc, keyId)
        : null
      : keyDoc
  ) as JsonWebKey | null;
  const result = jwk
    ? verifyPortableProof(proof, jwk, new Date().toISOString(), maxAge)
    : { valid: false, reason: "UNKNOWN_KEY" };
  const mismatches =
    result.valid && "proof" in result && result.proof
      ? matchesExpected(result.proof, {
          ...(flag("--expect-issuer")
            ? { issuer: flag("--expect-issuer")! }
            : {}),
          ...(flag("--expect-agent")
            ? { agentId: flag("--expect-agent")! }
            : {}),
          ...(flag("--expect-authority")
            ? { authorityId: flag("--expect-authority")! }
            : {}),
          ...(amountRaw !== undefined
            ? { amountMinor: Number(amountRaw) }
            : {}),
          ...(flag("--expect-currency")
            ? { currency: flag("--expect-currency")! }
            : {}),
          ...(flag("--expect-merchant")
            ? { merchantId: flag("--expect-merchant")! }
            : {}),
        })
      : [];
  const ok = result.valid && mismatches.length === 0;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ...result, mismatches })}\n`);
  } else {
    const lines = explainProof(result);
    if (mismatches.length) {
      lines[1] = "Verified: NO";
      lines.push(`Does not match what you expected: ${mismatches.join(", ")}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (!ok) process.exitCode = 1;
}

void main();
