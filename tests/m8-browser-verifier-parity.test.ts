import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPortableProof } from "../packages/verifier/src/index.js";
import { verifyProof } from "../apps/console/lib/verify-proof.js";
import { signedProof } from "../src/network/live-fault-injector.js";

/**
 * The browser verifier (apps/console/lib/verify-proof.ts) must reach the same verdict as the Node
 * verifier on every case. They are separate implementations because the browser graph may not import
 * server code, so this test is what keeps them from drifting. It lives in the root suite because it
 * needs both; the console CI job installs only the console's own dependencies.
 */
const NOW = new Date("2026-10-28T03:00:00.000Z");
const subject = {
  principalId: "p",
  agentId: "shopping-agent",
  capability: "CAPTURE_PAYMENT",
  amountMinor: 8400,
  currency: "USD",
  merchantId: "m.example",
};
const base = (over: Record<string, unknown> = {}) =>
  signedProof({ observedAt: NOW.toISOString(), subject, ...over });

type Case = [string, unknown, unknown];
function cases(): Case[] {
  const ok = base();
  const other = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  const p = ok.proof as Record<string, unknown>;
  const withoutSubject: Record<string, unknown> = { ...p };
  delete withoutSubject.subject;
  const unknown = base({ outcome: "UNKNOWN", effectCount: null });
  const badCount = base({ outcome: "UNKNOWN", effectCount: 0 });
  const future = base({ observedAt: "2027-01-01T00:00:00.000Z" });
  const sim = base({ subject: { ...subject, rail: "SIMULATED" } });
  return [
    ["valid", p, ok.jwk],
    [
      "tamper amount",
      { ...p, subject: { ...subject, amountMinor: 1 } },
      ok.jwk,
    ],
    [
      "tamper merchant",
      { ...p, subject: { ...subject, merchantId: "evil" } },
      ok.jwk,
    ],
    ["tamper agent", { ...p, subject: { ...subject, agentId: "x" } }, ok.jwk],
    ["tamper authority", { ...p, authorityId: "other" }, ok.jwk],
    ["tamper outcome", { ...p, outcome: "FAILED", effectCount: 0 }, ok.jwk],
    ["subject removed", withoutSubject, ok.jwk],
    ["wrong key", p, other],
    ["malformed", { nope: 1 }, ok.jwk],
    ["null proof", null, ok.jwk],
    ["extra field", { ...p, extra: true }, ok.jwk],
    ["bad key object", p, { kty: "OKP" }],
    ["unknown outcome verifies", unknown.proof, unknown.jwk],
    ["inconsistent count", badCount.proof, badCount.jwk],
    ["future dated", future.proof, future.jwk],
    [
      "keys document, right id",
      p,
      { keys: [{ keyId: "fault-key-1", jwk: ok.jwk }] },
    ],
    [
      "keys document, unknown id",
      p,
      { keys: [{ keyId: "nope", jwk: ok.jwk }] },
    ],
    ["simulated rail verifies", sim.proof, sim.jwk],
    [
      "rail forged after signing",
      {
        ...(sim.proof as object),
        subject: { ...subject, rail: "PAYPAL_SANDBOX" },
      },
      sim.jwk,
    ],
    [
      "unknown rail value",
      { ...(sim.proof as object), subject: { ...subject, rail: "PRODUCTION" } },
      sim.jwk,
    ],
  ];
}

describe("browser verifier and Node verifier agree", () => {
  for (const [name, proof, key] of cases())
    it(name, async () => {
      const browser = await verifyProof(proof, key, NOW);
      const keyId = (proof as { keyId?: string } | null)?.keyId;
      const doc = key as { keys?: { keyId: string; jwk: unknown }[] };
      const jwk = doc?.keys
        ? (doc.keys.find((k) => k.keyId === keyId)?.jwk ?? null)
        : key;
      const node = jwk
        ? verifyPortableProof(proof, jwk as never, NOW.toISOString(), null)
        : { valid: false, reason: "UNKNOWN_KEY" };
      expect(browser.valid).toBe(node.valid);
      if (!node.valid) expect(browser.reason).toBe(node.reason);
    });
});
