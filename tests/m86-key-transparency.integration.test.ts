/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { describe, expect, it, beforeEach } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { SigningKeyRegistry } from "../src/network/signing-keys.js";
import { readKeyTransparencyLog } from "../src/network/key-transparency.js";
import { verifyTransparencyLog } from "../src/network/transparency.js";

/**
 * V3 M86 — operational key transparency against PostgreSQL.
 *
 * PayFlow's claim is that anyone can verify a Proof offline against the issuer's published key. That rests entirely on
 * knowing which key was valid when. Before this, `proof_signing_keys` held only each key's CURRENT state: a key
 * quietly swapped, or a revocation quietly undone, left nothing a verifier could find.
 *
 * So the tests that matter are the ones that try to get away with something. A log that only proves the happy path
 * records history; a log that detects tampering attests it.
 */
const url = process.env.TEST_DATABASE_URL;
const NOW = "2026-11-11T10:00:00.000Z";
const ISSUER = "payflow-test-issuer";
const jwk = (x: string) => ({ kty: "OKP", crv: "Ed25519", x });

(url ? describe : describe.skip)("M86 key transparency (PostgreSQL)", () => {
  // The harness applies every migration, so key_transparency_log exists whichever tests ran before this one.
  const h = hostHarness({ extraTruncate: "key_transparency_log" });
  let registry: SigningKeyRegistry;

  beforeEach(() => {
    // No DELETE here: the log is append-only and the trigger would refuse it, which is the behaviour under test.
    // The harness TRUNCATEs both tables between files, and TRUNCATE does not fire row-level delete triggers.
    registry = new SigningKeyRegistry(h.repo.sql);
  });

  it("every key change is recorded, in order, with each entry chained to the one before", async () => {
    await registry.announce(ISSUER, "k-next", jwk("AAA"), NOW);
    await registry.activate(ISSUER, "k-one", jwk("BBB"), NOW);
    // Activating a second key retires the first: BOTH are key changes, and a log that recorded only
    // arrivals would let a key disappear without trace.
    await registry.activate(ISSUER, "k-two", jwk("CCC"), NOW);
    await registry.revoke("k-two", NOW);

    const log = await readKeyTransparencyLog(h.repo.sql);
    expect(log.intact).toBe(true);
    expect(log.entries.map((e) => `${e.keyId}:${e.status}`)).toEqual([
      "k-next:NEXT",
      "k-one:ACTIVE",
      "k-one:RETIRED",
      "k-two:ACTIVE",
      "k-two:REVOKED",
    ]);
    // Sequence starts at 1, never skips, and only the first entry has no predecessor.
    expect(log.entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(log.entries[0]!.previousHash).toBeNull();
    for (let i = 1; i < log.entries.length; i++)
      expect(log.entries[i]!.previousHash).toBe(log.entries[i - 1]!.entryHash);
    expect(log.notice).toMatch(/the chain is the evidence/u);
  });

  it("the log is append-only: an entry cannot be edited or removed", async () => {
    await registry.activate(ISSUER, "k-one", jwk("BBB"), NOW);
    await expect(
      h.repo
        .sql`update key_transparency_log set status = 'REVOKED' where issuer = ${ISSUER}`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      h.repo.sql`delete from key_transparency_log where issuer = ${ISSUER}`,
    ).rejects.toThrow(/append-only/u);
  });

  it("a tampered entry is detected, and so is a removed one", async () => {
    await registry.activate(ISSUER, "k-one", jwk("BBB"), NOW);
    await registry.activate(ISSUER, "k-two", jwk("CCC"), NOW);
    const good = await readKeyTransparencyLog(h.repo.sql);
    expect(good.intact).toBe(true);
    // Stated, not assumed: two activations produce THREE entries (ACTIVE, the first key's RETIRED, ACTIVE).
    // The removal check below only bites on a middle entry, so if that ever stopped being true this test would
    // quietly stop testing removal. A mutation run found exactly that, which is why the premise is asserted here.
    expect(good.entries).toHaveLength(3);

    // The database will not let anyone do this, so the detection is checked against the verifier directly:
    // this is what a reader would compute if a stored entry had been changed by any route at all.
    const edited = good.entries.map((e, i) =>
      i === 1 ? { ...e, status: "REVOKED" as const } : e,
    );
    expect(verifyTransparencyLog(edited)).toBe(false);

    // Removing an entry breaks the chain at the join, not only at the end.
    const removed = good.entries.filter((_, i) => i !== 1);
    expect(verifyTransparencyLog(removed)).toBe(false);

    // Re-ordering is caught too: the sequence and the hashes disagree.
    const reordered = [
      good.entries[1]!,
      good.entries[0]!,
      ...good.entries.slice(2),
    ];
    expect(verifyTransparencyLog(reordered)).toBe(false);
  });

  it("one chain carries every issuer, and an issuer cannot be the only witness to its own history", async () => {
    const other = "payflow-other-issuer";
    await registry.activate(ISSUER, "mine-1", jwk("BBB"), NOW);
    await registry.activate(other, "theirs-1", jwk("DDD"), NOW);

    const log = await readKeyTransparencyLog(h.repo.sql);
    expect(log.intact).toBe(true);
    // Both issuers are in ONE chain, interleaved in the order the changes actually happened. This is the point:
    // a per-issuer chain would let an issuer rewrite its own history in isolation, with nothing else to contradict it.
    expect(log.entries.map((e) => `${e.issuer}:${e.keyId}`)).toEqual([
      `${ISSUER}:mine-1`,
      `${other}:theirs-1`,
    ]);
    expect(log.entries.map((e) => e.sequence)).toEqual([1, 2]);
    expect(log.entries[1]!.previousHash).toBe(log.entries[0]!.entryHash);
    // Each entry still names its own issuer, so a reader can filter without trusting the filter.
    expect(log.entries.filter((e) => e.issuer === other)).toHaveLength(1);
  });

  it("the log is public: anyone can fetch it, unauthenticated, and check the chain themselves", async () => {
    await registry.activate(ISSUER, "k-one", jwk("BBB"), NOW);
    await registry.activate(ISSUER, "k-two", jwk("CCC"), NOW);

    // No credential, no cookie, no header: exactly what an outside verifier has.
    const r = await fetch(h.origin + "/v1/transparency/keys");
    expect(r.status, await r.clone().text()).toBe(200);
    const doc = await r.json();

    // The chain arrives whole and verifies on the reader's side, not merely on ours.
    expect(doc.intact).toBe(true);
    expect(verifyTransparencyLog(doc.entries)).toBe(true);
    expect(doc.entries.map((e: any) => `${e.keyId}:${e.status}`)).toEqual([
      "k-one:ACTIVE",
      "k-one:RETIRED",
      "k-two:ACTIVE",
    ]);
    expect(doc.notice).toMatch(/the chain is the evidence/u);

    // What a public document must NOT contain: any key material, and any private JWK field.
    const body = JSON.stringify(doc);
    expect(body).not.toMatch(/"d"\s*:/u);
    expect(body).not.toMatch(/BBB|CCC/u);
    // Only digests identify the keys.
    for (const e of doc.entries)
      expect(e.publicKeyDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("private key material never reaches the log", async () => {
    // The registry refuses it outright; the digest is of the public key, and the log stores only that digest.
    await expect(
      registry.activate(
        ISSUER,
        "k-bad",
        { ...jwk("BBB"), d: "secret" } as any,
        NOW,
      ),
    ).rejects.toThrow(/PRIVATE_KEY_MATERIAL/u);
    await registry.activate(ISSUER, "k-one", jwk("BBB"), NOW);
    const rows = await h.repo
      .sql`select * from key_transparency_log where issuer = ${ISSUER}`;
    expect(JSON.stringify(rows)).not.toMatch(/secret/u);
    // What is stored is a digest, not the key.
    for (const r of rows)
      expect(String(r.public_key_digest)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
