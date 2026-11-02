import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { generateKeyPairSync } from "node:crypto";
import { verifyProof, present } from "../lib/verify-proof";
import sample from "../lib/sample-proof.json";
import { ProofVerifier } from "../app/ui/proof-verifier";
import { verifyPortableProof } from "../../../packages/verifier/src/index";
import { signedProof } from "../../../src/network/live-fault-injector";

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
  ];
}

test("browser verifier and Node verifier agree on every case", async () => {
  for (const [name, proof, key] of cases()) {
    const browser = await verifyProof(proof, key, NOW);
    const keyId = (proof as { keyId?: string } | null)?.keyId;
    const jwk = (key as { keys?: { keyId: string; jwk: unknown }[] })?.keys
      ? ((key as { keys: { keyId: string; jwk: unknown }[] }).keys.find(
          (k) => k.keyId === keyId,
        )?.jwk ?? null)
      : key;
    const node = jwk
      ? verifyPortableProof(proof, jwk as never, NOW.toISOString(), null)
      : { valid: false, reason: "UNKNOWN_KEY" };
    assert.equal(browser.valid, node.valid, `${name}: validity`);
    if (!node.valid)
      assert.equal(browser.reason, node.reason, `${name}: reason`);
  }
});

test("a private key is never accepted as a verification key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { signature: _s, ...rest } = base().proof as Record<string, unknown>;
  void rest;
  const ok = base();
  const priv = privateKey.export({ format: "jwk" });
  void publicKey;
  assert.equal(
    (await verifyProof(ok.proof, priv, NOW)).reason,
    "INVALID_PUBLIC_KEY",
  );
});

test("presentation leads with the verdict and never calls UNKNOWN success or failure", async () => {
  const ok = base();
  const view = present(await verifyProof(ok.proof, ok.jwk, NOW));
  assert.equal(view.headline, "Verified");
  assert.equal(view.outcome, "Paid once");
  assert.ok(view.facts.some((f) => f.label === "Amount" && f.value === "$84"));
  const unk = base({ outcome: "UNKNOWN", effectCount: null });
  const u = present(await verifyProof(unk.proof, unk.jwk, NOW));
  assert.match(u.outcome ?? "", /confirming whether money moved/);
  assert.doesNotMatch(u.outcome ?? "", /Paid|success|fail/i);
  const bad = present(
    await verifyProof(
      { ...(ok.proof as object), subject: { ...subject, amountMinor: 2 } },
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
