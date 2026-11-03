import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  explainProof,
  matchesExpected,
  selectKey,
  verifyPortableProof,
  type PortableProof,
} from "../packages/verifier/src/index.js";
import { signedProof } from "../src/network/live-fault-injector.js";

const NOW = "2026-10-28T03:00:00.000Z";
const subject = {
  principalId: "p-1",
  agentId: "shopping-agent",
  capability: "CAPTURE_PAYMENT",
  amountMinor: 8400,
  currency: "USD",
  merchantId: "payflow.demo.merchant",
};
const fresh = (over: Record<string, unknown> = {}) =>
  signedProof({ observedAt: NOW, subject, ...over });

describe("M8 verification matrix (library)", () => {
  it("a valid proof verifies and carries its signed subject", () => {
    const { proof, jwk } = fresh();
    expect(verifyPortableProof(proof, jwk, NOW)).toMatchObject({
      valid: true,
      reason: "PROOF_VALID",
    });
  });

  it.each([
    ["amount", { subject: { ...subject, amountMinor: 1 } }],
    ["merchant", { subject: { ...subject, merchantId: "evil.merchant" } }],
    ["agent", { subject: { ...subject, agentId: "other-agent" } }],
    ["currency", { subject: { ...subject, currency: "EUR" } }],
    ["authority", { authorityId: "other-authority" }],
    ["action", { actionId: "other-action" }],
    ["evidence digest", { evidenceDigest: "c".repeat(64) }],
  ])("tampering with the %s is rejected", (_n, change) => {
    const { proof, jwk } = fresh();
    expect(
      verifyPortableProof({ ...proof, ...change }, jwk, NOW),
    ).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });
  });

  it("removing the subject from a signed proof is also detected", () => {
    const { proof, jwk } = fresh();
    const without: Record<string, unknown> = { ...proof };
    delete without.subject;
    expect(verifyPortableProof(without, jwk, NOW).valid).toBe(false);
  });

  it("a proof without a subject (older form) still verifies", () => {
    const { proof, jwk } = signedProof({ observedAt: NOW });
    expect(verifyPortableProof(proof, jwk, NOW).valid).toBe(true);
  });

  it("another key and malformed input are rejected", () => {
    const { proof } = fresh();
    const other = signedProof().jwk;
    expect(verifyPortableProof(proof, other, NOW).reason).toBe(
      "SIGNATURE_INVALID",
    );
    expect(verifyPortableProof({ nope: 1 }, other, NOW).reason).toBe(
      "MALFORMED_PROOF",
    );
    expect(verifyPortableProof(null, other, NOW).valid).toBe(false);
    expect(verifyPortableProof(proof, { kty: "bad" }, NOW).reason).toBe(
      "INVALID_PUBLIC_KEY",
    );
  });

  it("an unknown key id in a key document selects nothing", () => {
    const { jwk } = fresh();
    const doc = { keys: [{ keyId: "fault-key-1", jwk }] };
    expect(selectKey(doc, "fault-key-1")).toEqual(jwk);
    expect(selectKey(doc, "unknown")).toBeNull();
    expect(selectKey({}, "x")).toBeNull();
  });

  it("historical proofs verify by authenticity; freshness is opt-in; future-dated is refused", () => {
    const { proof, jwk } = fresh({ observedAt: "2025-01-01T00:00:00.000Z" });
    expect(verifyPortableProof(proof, jwk, NOW, null).valid).toBe(true);
    expect(verifyPortableProof(proof, jwk, NOW, 3600).reason).toBe(
      "STALE_PROOF",
    );
    const future = fresh({ observedAt: "2027-01-01T00:00:00.000Z" });
    expect(
      verifyPortableProof(future.proof, future.jwk, NOW, null).reason,
    ).toBe("PROOF_FROM_FUTURE");
  });

  it("expectations bind issuer, agent, authority, amount, currency and merchant", () => {
    const { proof } = fresh();
    const p = proof as unknown as PortableProof;
    expect(
      matchesExpected(p, {
        issuer: "fault-issuer",
        agentId: "shopping-agent",
        authorityId: "benchmark-authority",
        amountMinor: 8400,
        currency: "USD",
        merchantId: "payflow.demo.merchant",
      }),
    ).toEqual([]);
    expect(
      matchesExpected(p, {
        issuer: "someone-else",
        amountMinor: 100,
        merchantId: "x",
      }),
    ).toEqual(["issuer", "amountMinor", "merchantId"]);
    const legacy = signedProof({ observedAt: NOW })
      .proof as unknown as PortableProof;
    expect(matchesExpected(legacy, { amountMinor: 8400 })).toEqual([
      "subject_not_in_proof",
    ]);
  });

  it("human output leads with the verdict, hides raw crypto, and never calls UNKNOWN success", () => {
    const ok = fresh();
    const lines = explainProof(verifyPortableProof(ok.proof, ok.jwk, NOW));
    expect(lines.slice(0, 2)).toEqual(["PayFlow Proof", "Verified: YES"]);
    expect(lines.join("\n")).toContain("Amount: $84");
    expect(lines.join("\n")).toContain("Paid once");
    expect(lines.join("\n")).not.toMatch(/signature|evidenceDigest|keyId/i);

    const unknown = fresh({ outcome: "UNKNOWN", effectCount: null });
    const u = explainProof(
      verifyPortableProof(unknown.proof, unknown.jwk, NOW),
    ).join("\n");
    expect(u).toContain("confirming whether money moved");
    expect(u).not.toMatch(/Paid once|success|failed/i);

    const failed = fresh({ outcome: "FAILED", effectCount: 0 });
    expect(
      explainProof(verifyPortableProof(failed.proof, failed.jwk, NOW)).join(
        "\n",
      ),
    ).toContain("$0 moved");

    expect(explainProof({ valid: false, reason: "SIGNATURE_INVALID" })).toEqual(
      ["PayFlow Proof", "Verified: NO", "Reason: SIGNATURE_INVALID"],
    );
  });

  it("an inconsistent effect count is refused even with a valid signature", () => {
    const bad = fresh({ outcome: "UNKNOWN", effectCount: 0 });
    expect(verifyPortableProof(bad.proof, bad.jwk, NOW).reason).toBe(
      "INCONSISTENT_EFFECT_COUNT",
    );
  });
});

describe("M8 CLI in a separate process", () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "packages/verifier/src/cli.ts", ...args],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    );
  const files = (proof: unknown, key: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "m8v-"));
    writeFileSync(join(dir, "proof.json"), JSON.stringify(proof));
    writeFileSync(join(dir, "key.json"), JSON.stringify(key));
    return [join(dir, "proof.json"), join(dir, "key.json")] as const;
  };

  it("prints a human summary by default and exits 0", () => {
    const { proof, jwk } = signedProof({ subject });
    const [p, k] = files(proof, jwk);
    const r = run(["verify", p, "--key", k, "--max-age", "999999999"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Verified: YES");
    expect(r.stdout).toContain("Agent: shopping-agent");
  }, 60_000);

  it("accepts the GET /v1/keys document and exits 1 with a reason for an unknown key", () => {
    const { proof, jwk } = signedProof({
      subject,
      observedAt: new Date().toISOString(),
    });
    const [p, k] = files(proof, {
      issuer: "x",
      keys: [{ keyId: "fault-key-1", jwk }],
    });
    expect(run([p, "--keys", k]).status).toBe(0);
    const [p2, k2] = files(proof, {
      issuer: "x",
      keys: [{ keyId: "another", jwk }],
    });
    const r = run([p2, "--keys", k2, "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      valid: false,
      reason: "UNKNOWN_KEY",
    });
  }, 60_000);

  it("a merchant can require the expected amount and merchant; a mismatch exits 1", () => {
    const { proof, jwk } = signedProof({
      subject,
      observedAt: new Date().toISOString(),
    });
    const [p, k] = files(proof, jwk);
    expect(
      run([
        p,
        k,
        "--expect-amount",
        "8400",
        "--expect-merchant",
        "payflow.demo.merchant",
      ]).status,
    ).toBe(0);
    const bad = run([p, k, "--expect-amount", "100", "--json"]);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({
      mismatches: ["amountMinor"],
    });
  }, 60_000);

  it("bad usage exits 2", () => {
    expect(run([]).status).toBe(2);
    expect(run(["x.json"]).status).toBe(2);
  }, 60_000);
});

describe("M8 read-only boundary", () => {
  it("the verifier package imports no payment, database, network, grant or server code", () => {
    for (const f of readdirSync("packages/verifier/src")) {
      const code = readFileSync(join("packages/verifier/src", f), "utf8");
      const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports)
        expect(
          ["node:crypto", "node:fs/promises", "zod", "./index.js"],
          `${f}: ${i}`,
        ).toContain(i);
      // Data labels such as the rail name "PayPal Sandbox" are allowed. Payment capability is not:
      // no fetch, no provider types, no order/capture calls, no payment or database imports.
      expect(code).not.toMatch(
        /\bfetch\(|XMLHttpRequest|from\s+"[^"]*(paypal|postgres)|PayPalExecutionRail|PaymentProvider|createOrder|captureOrder|issuer\.issue/i,
      );
    }
  });
});
