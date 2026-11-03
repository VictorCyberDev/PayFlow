import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { verifyProof, present } from "../lib/verify-proof";
import sample from "../lib/sample-proof.json";
import { ProofVerifier } from "../app/ui/proof-verifier";

// Self-contained: the console CI job installs only the console's own dependencies, so nothing here
// may import repo-root code. Cross-implementation parity is tested in the root suite
// (tests/m8-browser-verifier-parity.test.ts).
const NOW = new Date("2026-10-28T03:00:00.000Z");
const subject = {
  principalId: "p",
  agentId: "shopping-agent",
  capability: "CAPTURE_PAYMENT",
  amountMinor: 8400,
  currency: "USD",
  merchantId: "m.example",
};
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
function signed(over: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    version: "payflow-proof/v1",
    issuer: "i",
    keyId: "k1",
    authorityId: "auth",
    actionId: "act",
    outcome: "SUCCEEDED",
    effectCount: 1,
    observedAt: NOW.toISOString(),
    evidenceDigest: "a".repeat(64),
    subject,
    ...over,
  };
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(canon(payload))),
    privateKey,
  ).toString("base64url");
  return {
    proof: { ...payload, signature } as Record<string, unknown>,
    jwk: publicKey.export({ format: "jwk" }) as JsonWebKey,
    privateJwk: privateKey.export({ format: "jwk" }) as JsonWebKey,
  };
}

test("a valid proof verifies", async () => {
  const s = signed();
  assert.deepEqual(await verifyProof(s.proof, s.jwk, NOW), {
    valid: true,
    reason: "PROOF_VALID",
    proof: s.proof,
  });
});

test("changing any signed fact invalidates the proof", async () => {
  const s = signed();
  for (const change of [
    { subject: { ...subject, amountMinor: 1 } },
    { subject: { ...subject, merchantId: "evil" } },
    { subject: { ...subject, agentId: "x" } },
    { authorityId: "other" },
    { outcome: "FAILED", effectCount: 0 },
  ]) {
    const r = await verifyProof({ ...s.proof, ...change }, s.jwk, NOW);
    assert.equal(r.valid, false);
    assert.equal(r.reason, "SIGNATURE_INVALID");
  }
});

test("a wrong key, unknown key id, malformed input and a private key are all refused", async () => {
  const s = signed();
  const other = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  assert.equal(
    (await verifyProof(s.proof, other, NOW)).reason,
    "SIGNATURE_INVALID",
  );
  assert.equal(
    (await verifyProof(s.proof, { keys: [{ keyId: "nope", jwk: s.jwk }] }, NOW))
      .reason,
    "UNKNOWN_KEY",
  );
  assert.equal(
    (await verifyProof({ nope: 1 }, s.jwk, NOW)).reason,
    "MALFORMED_PROOF",
  );
  assert.equal(
    (await verifyProof(s.proof, s.privateJwk, NOW)).reason,
    "INVALID_PUBLIC_KEY",
  );
});

test("UNKNOWN verifies as UNKNOWN and an inconsistent effect count is refused", async () => {
  const u = signed({ outcome: "UNKNOWN", effectCount: null });
  assert.equal((await verifyProof(u.proof, u.jwk, NOW)).valid, true);
  const bad = signed({ outcome: "UNKNOWN", effectCount: 0 });
  assert.equal(
    (await verifyProof(bad.proof, bad.jwk, NOW)).reason,
    "INCONSISTENT_EFFECT_COUNT",
  );
});

test("a simulated-rail proof verifies and says so in plain words; a forged or unknown rail does not", async () => {
  const s = signed({ subject: { ...subject, rail: "SIMULATED" } });
  const r = await verifyProof(s.proof, s.jwk, NOW);
  assert.equal(r.valid, true);
  assert.ok(
    present(r).facts.some(
      (f) => f.label === "Rail" && /Simulated \(no real money\)/.test(f.value),
    ),
  );
  assert.equal(
    (
      await verifyProof(
        { ...s.proof, subject: { ...subject, rail: "PAYPAL_SANDBOX" } },
        s.jwk,
        NOW,
      )
    ).valid,
    false,
  );
  assert.equal(
    (
      await verifyProof(
        { ...s.proof, subject: { ...subject, rail: "PRODUCTION" } },
        s.jwk,
        NOW,
      )
    ).reason,
    "MALFORMED_PROOF",
  );
});

test("presentation leads with the verdict and never calls UNKNOWN success or failure", async () => {
  const ok = signed();
  const view = present(await verifyProof(ok.proof, ok.jwk, NOW));
  assert.equal(view.headline, "Verified");
  assert.equal(view.outcome, "Paid once");
  assert.ok(view.facts.some((f) => f.label === "Amount" && f.value === "$84"));
  const u = signed({ outcome: "UNKNOWN", effectCount: null });
  const uv = present(await verifyProof(u.proof, u.jwk, NOW));
  assert.match(uv.outcome ?? "", /confirming whether money moved/);
  assert.doesNotMatch(uv.outcome ?? "", /Paid|success|fail/i);
  const bad = present(
    await verifyProof(
      { ...ok.proof, subject: { ...subject, amountMinor: 2 } },
      ok.jwk,
      NOW,
    ),
  );
  assert.equal(bad.headline, "Not verified");
  assert.deepEqual(bad.facts, []);
});

test("the bundled sample really verifies and is labelled illustrative", async () => {
  const r = await verifyProof(
    sample.proof,
    sample.keys,
    new Date("2026-11-03T00:00:00Z"),
  );
  assert.equal(r.valid, true);
  assert.match(sample._notice, /ILLUSTRATIVE SAMPLE/);
});

test("the verifier UI has labelled inputs, a live result region and no network call", () => {
  const html = renderToStaticMarkup(<ProofVerifier />);
  assert.match(html, /<label[^>]*>Proof \(JSON\)<\/label>/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Nothing is sent anywhere/);
  assert.doesNotMatch(html, /fetch\(/);
});
