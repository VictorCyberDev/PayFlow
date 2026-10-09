import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionGrantIssuer } from "../src/execution-grant.js";
import type { PostgresTrustRepository } from "../src/persistence.js";

// These constructor checks must run before the repository can be used.
const unusedRepository = {} as PostgresTrustRepository;
describe("2E cryptographic configuration fails closed", () => {
  it("rejects an algorithm downgrade from Ed25519 to RSA", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      () => new ExecutionGrantIssuer(unusedRepository, "key", privateKey),
    ).toThrow("ED25519_SIGNING_KEY_REQUIRED");
  });
  it.each([NaN, Infinity, 0.5])(
    "rejects invalid grant lifetime %s before issuance",
    (ttl) => {
      const { privateKey } = generateKeyPairSync("ed25519");
      expect(
        () =>
          new ExecutionGrantIssuer(
            unusedRepository,
            "key",
            privateKey,
            "audience",
            ttl,
          ),
      ).toThrow("INVALID_GRANT_TTL");
    },
  );
});
