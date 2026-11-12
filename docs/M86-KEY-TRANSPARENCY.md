# M86 — operational key transparency

Status: IMPLEMENTED, WIRED (every key change records an entry), DB_ACCEPTED (migration 067 — an ALTER, see below — and PostgreSQL integration tests). **Not** HOSTED_ACCEPTED.

## Why this one matters more than its milestone number suggests

PayFlow's whole claim is Proof: anyone can verify a Proof offline, against the issuer's published key, without asking PayFlow for permission or for anything else. That claim rests entirely on knowing **which key was valid when**.

`proof_signing_keys` held only each key's _current_ state. A key quietly swapped for another, or a revocation quietly reversed, would leave nothing a verifier could find — the table would simply show a different present, with no past to contradict it. Offline verification against a key you cannot audit the history of is weaker than it sounds.

`src/network/transparency.ts` had the chain arithmetic for exactly this — `appendTransparencyEntry`, `verifyTransparencyLog` — and **nothing ever called it**. It was one of the 22 orphans in `docs/execution/FORWARD-TRACEABILITY.md`.

## A correction worth recording

My first attempt created a new `key_transparency_log` table. **It already existed**, from migration `017`, and had done since long before this session — built, and then never written to. The failing migration is what told me: I had checked whether the _module_ was wired and not whether its _table_ already existed, which is a gap in how I used my own orphan scan.

Worse, my design was per-issuer: a separate chain for each issuer. The existing table, and the contiguous `sequence` check in `verifyTransparencyLog`, both say **one global chain** with each entry naming its issuer. That is how transparency logs are normally built, and the reason is substantive: a per-issuer chain lets an issuer be the only witness to its own history, which gives away most of the property.

So migration `067` is an **ALTER**, not a CREATE, and the chain is global.

## What it does

One hash-chained, append-only entry per key state change, in the existing `key_transparency_log`:

| Column                        |                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `sequence`                    | one chain across all issuers, starting at 1 and never skipping                        |
| `issuer`, `key_id`, `status`  | whose key, which key, and what it became                                              |
| `public_key_digest`           | sha256 of the **public** JWK, stably serialised so key order cannot change the digest |
| `previous_hash`, `entry_hash` | the chain itself                                                                      |

Every entry carries the hash of the entry before it, so changing or removing any entry breaks every entry after it.

Migration `067` adds what the table was missing: `RETIRED` and `NEXT` in the status CHECK (so a real `proof_signing_keys` change can be recorded faithfully at all), the rule that only the first entry has no predecessor, and the append-only trigger.

### It is written in the same transaction as the key change

`SigningKeyRegistry.activate`, `.announce` and `.revoke` each append inside their own transaction, under the issuer's advisory lock. This is the part worth insisting on: a log appended afterwards, or on a best-effort basis, can silently fall behind the thing it attests — and **a log that can fall behind attests nothing**. `revoke` was a bare `UPDATE`; it is now a transaction, because revocation is the entry a verifier most needs and a revocation recorded only in the key row could be undone with no trace.

Activation records **two** entries: the outgoing key's `RETIRED` and the incoming key's `ACTIVE`. A log that recorded only arrivals would let a key disappear without trace.

## What it promises, and what it does not

It cannot stop an issuer retiring a key, revoking one, or behaving badly. It makes doing so **undetectably impossible**. That is the property a transparency log actually offers, and it is why the table has no UPDATE or DELETE path at all: a transparency log that can be edited is not one.

The read path verifies the chain on the way out rather than taking it on trust, and says which it found:

> Every key change this issuer has made, each entry carrying the hash of the one before it. Check it yourself: the chain is the evidence, not our word for it.

and, when it does not verify:

> This log does not verify. An entry has been changed or removed. Treat proofs from this issuer as unverified and say so.

## Evidence

`tests/m86-key-transparency.integration.test.ts`, against PostgreSQL. The tests that matter are the ones that try to get away with something:

1. every key change is recorded, in order, chained — `NEXT`, `ACTIVE`, the outgoing key's `RETIRED`, `ACTIVE`, `REVOKED`, with sequences `1..5`, only the first entry without a predecessor, and each `previousHash` equal to the prior `entryHash`
2. the log is append-only: `UPDATE` and `DELETE` both raise `the key transparency log is append-only`
3. **a tampered entry is detected, and so is a removed one, and so is a reordered one** — the database refuses all three, so detection is checked against the verifier directly, which is what a reader would compute if a stored entry had been changed by any route at all
4. one chain carries every issuer, interleaved in the order the changes actually happened, each entry still naming its own issuer so a reader can filter without trusting the filter
5. private key material never reaches the log — the registry refuses a JWK containing `d`, and what is stored is a 64-character digest, not a key
6. **the log is public**: fetched with no credential, no cookie and no header — exactly what an outside verifier has — the chain arrives whole and `verifyTransparencyLog` passes **on the reader's side**, not merely on ours; and the public document contains no `"d":` field and none of the key material, only digests

## Still not done

- ~~No public HTTP surface.~~ **Done:** `GET /v1/transparency/keys`, unauthenticated, like `/v1/keys`. A transparency log only its issuer can read proves nothing to anyone who might doubt the issuer, so publishing it was not an extra — it was the missing half of the property. It fails closed like the key document: if the log cannot be read it serves `TRANSPARENCY_LOG_UNAVAILABLE` rather than a possibly-incomplete log, because a short log invites the reader to conclude a key change never happened.
- No monitor watches for a chain that stops verifying. Detection currently happens when someone reads.
- Entries before this migration do not exist: the chain starts from the first key change after it. That is stated rather than backfilled, because backfilling a transparency log from current state would be inventing a history.
