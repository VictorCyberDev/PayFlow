import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionBoundary,
  ExecutionGrantIssuer,
  StaticPublicKeyRing,
} from "../src/execution-grant.js";
import type { PostgresTrustRepository } from "../src/persistence.js";

// These constructor checks must run before the repository can be used.
const unusedRepository = {} as PostgresTrustRepository;
describe("2E cryptographic configuration fails closed", () => {
  it("M3F rejects oversized caller grants before decoding or dispatch", async () => {
    const appendEvidence = vi.fn().mockResolvedValue(undefined);
    const repo = { appendEvidence } as unknown as PostgresTrustRepository;
    const sink = { execute: vi.fn() };
    const boundary = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map()),
      sink,
    );
    await expect(
      boundary.execute("x".repeat(8193), "2026-10-09T12:00:00.000Z"),
    ).rejects.toThrow("EXECUTION_GRANT_TOO_LARGE");
    expect(sink.execute).not.toHaveBeenCalled();
    expect(appendEvidence).toHaveBeenCalledWith(
      "EXECUTION_GRANT_VERIFICATION_FAILED",
      { reason: "EXECUTION_GRANT_TOO_LARGE", tokenCharacters: 8193 },
      "2026-10-09T12:00:00.000Z",
    );
  });
  it("M3F exact grant-size boundary still performs ordinary validation", async () => {
    const repo = {
      appendEvidence: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostgresTrustRepository;
    const sink = { execute: vi.fn() };
    await expect(
      new ExecutionBoundary(
        repo,
        new StaticPublicKeyRing(new Map()),
        sink,
      ).execute("x".repeat(8192), "2026-10-09T12:00:00.000Z"),
    ).rejects.toThrow("MALFORMED_EXECUTION_GRANT");
    expect(sink.execute).not.toHaveBeenCalled();
  });
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
