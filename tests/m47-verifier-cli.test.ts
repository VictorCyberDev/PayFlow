import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signedProof } from "../src/network/live-fault-injector.js";

function run(proofFile: string, jwkFile: string) {
  return spawnSync(
    "npx",
    ["tsx", "packages/verifier/src/cli.ts", proofFile, jwkFile],
    {
      encoding: "utf8",
    },
  );
}

describe("M47 open verifier CLI", () => {
  it("verifies a proof offline with no money-moving API, and fails closed on tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "payflow-verify-"));
    const { proof, jwk } = signedProof({
      observedAt: new Date().toISOString(),
    });
    const proofPath = join(dir, "proof.json");
    const tamperedPath = join(dir, "tampered.json");
    const jwkPath = join(dir, "key.json");
    writeFileSync(proofPath, JSON.stringify(proof));
    writeFileSync(
      tamperedPath,
      JSON.stringify({ ...proof, actionId: "other-action" }),
    );
    writeFileSync(jwkPath, JSON.stringify(jwk));

    const ok = run(proofPath, jwkPath);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      valid: true,
      reason: "PROOF_VALID",
    });

    const bad = run(tamperedPath, jwkPath);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });

    expect(
      spawnSync("npx", ["tsx", "packages/verifier/src/cli.ts"], {
        encoding: "utf8",
      }).status,
    ).toBe(2);
  }, 60_000);
});
