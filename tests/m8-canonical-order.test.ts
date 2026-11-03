import { describe, expect, it } from "vitest";

/**
 * The portable proof and the Authority presentation moved from a locale-dependent key sort to a
 * code-point sort so that independent verifiers in any locale or language agree on the signed
 * bytes. Existing signatures stay valid only if both comparators order these exact key sets
 * identically. This test pins that. Grant, evidence and fingerprint canonicalizers protect
 * historical signed and hash-chained material and are intentionally NOT changed.
 */
const portableProofKeys = [
  "version",
  "issuer",
  "keyId",
  "authorityId",
  "actionId",
  "outcome",
  "effectCount",
  "observedAt",
  "evidenceDigest",
];
const presentationKeys = [
  "version",
  "issuer",
  "keyId",
  "authorityId",
  "authorityFingerprint",
  "principalId",
  "agentId",
  "audience",
  "challenge",
  "nonce",
  "issuedAt",
  "expiresAt",
];
const byLocale = (keys: string[]) =>
  [...keys].sort((a, b) => a.localeCompare(b));
const byCodePoint = (keys: string[]) =>
  [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("M8 canonical key order", () => {
  it.each([
    ["portable proof", portableProofKeys],
    ["authority presentation", presentationKeys],
  ])("%s keys sort identically by locale and by code point", (_n, keys) => {
    expect(byCodePoint(keys)).toEqual(byLocale(keys));
  });

  it("code-point order is locale independent for mixed case (the hazard being removed)", () => {
    expect(byCodePoint(["b", "B", "a", "A"])).toEqual(["A", "B", "a", "b"]);
  });
});
