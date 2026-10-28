import {
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDirectory } from "../src/network/directory.js";
import {
  digestVerificationBody,
  publicVerify,
  verifySignedVerifierRequest,
} from "../src/network/public-verify.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

describe("M21 public Verify", () => {
  it("enforces quotas before read-only verification", async () => {
    let allowed = true;
    const deps = {
      consumeQuota: async () => ({
        allowed,
        remaining: allowed ? 9 : 0,
        resetAt: "2026-10-28T04:00:00.000Z",
      }),
      verifyPresentation: async () => ({ verdict: "VALID" }),
    };
    const first = await publicVerify(
      { clientId: "merchant-1", presentation: {}, now: "2026-10-28T03:30:00.000Z" },
      deps,
    );
    expect(first.status).toBe(200);
    allowed = false;
    const limited = await publicVerify(
      { clientId: "merchant-1", presentation: {}, now: "2026-10-28T03:30:00.000Z" },
      deps,
    );
    expect(limited.status).toBe(429);
  });

  it("supports freshness-bound signed verifier requests", () => {
    const body = { authorityId: "a1" };
    const unsigned = {
      verifierId: "merchant-1",
      keyId: "k1",
      timestamp: "2026-10-28T03:30:00.000Z",
      nonce: "verifier-request-nonce-0001",
      bodyDigest: digestVerificationBody(body),
    };
    const canonical = [
      unsigned.verifierId,
      unsigned.keyId,
      unsigned.timestamp,
      unsigned.nonce,
      unsigned.bodyDigest,
    ].join("\n");
    const request = {
      ...unsigned,
      signature: cryptoSign(null, Buffer.from(canonical), privateKey).toString("base64url"),
    };
    expect(
      verifySignedVerifierRequest(request, body, publicKey, "2026-10-28T03:31:00.000Z"),
    ).toBe(true);
    expect(
      verifySignedVerifierRequest(request, body, publicKey, "2026-10-28T03:40:00.000Z"),
    ).toBe(false);
  });
});

describe("M24 issuer/verifier directory", () => {
  it("resolves only trusted non-revoked keys in their validity window", () => {
    const directory = new AuthorityDirectory();
    directory.register({
      version: "authority-directory/v1",
      issuer: "https://issuer.example",
      status: "TRUSTED",
      capabilities: ["ISSUE_AUTHORITY", "VERIFY_AUTHORITY"],
      endpoints: {
        verification: "https://issuer.example/verify",
        metadata: "https://issuer.example/.well-known/payflow-authority.json",
      },
      keys: [
        {
          kid: "k1",
          alg: "Ed25519",
          publicJwk: { kty: "OKP", crv: "Ed25519", x: "example" },
          status: "ACTIVE",
          validFrom: "2026-10-28T00:00:00.000Z",
        },
      ],
      cacheMaxAgeSeconds: 300,
      updatedAt: "2026-10-28T03:00:00.000Z",
    });
    expect(directory.resolveActiveKey("https://issuer.example", "k1", "2026-10-28T03:30:00.000Z")?.kid).toBe("k1");
    expect(directory.resolveActiveKey("https://issuer.example", "missing", "2026-10-28T03:30:00.000Z")).toBeNull();
  });
});
