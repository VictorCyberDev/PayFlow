import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import {
  appendTransparencyEntry,
  verifyTransparencyLog,
  type TransparencyEntry,
} from "./transparency.js";

/**
 * V3 M86 — operational key transparency, stored.
 *
 * `transparency.ts` had the chain arithmetic and no storage, so nothing ever recorded a key change. This writes every
 * one into a hash-chained, append-only table, **inside the same transaction as the key change itself**. That matters
 * more than it looks: a log appended afterwards, or on a best-effort basis, can silently fall behind the thing it is
 * supposed to attest, and a log that can fall behind attests nothing.
 *
 * What it does and does not promise: it cannot stop an issuer retiring a key or revoking one. It makes doing so
 * *undetectably* impossible, because every later entry carries the hash of this one. That is the property a
 * transparency log actually offers, and the reason the table has no UPDATE or DELETE path.
 *
 * Only the public key is digested. Private material is kept out of the database entirely by the `proof_signing_keys`
 * CHECK that rejects a JWK containing `d`.
 */
export type KeyEntryStatus = TransparencyEntry["status"];

/** Stable digest of a public JWK: key order must not change the digest, or the chain would be unverifiable. */
export function publicKeyDigest(publicJwk: unknown): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(stable(publicJwk), "utf8").digest("hex");
}

const toEntry = (r: Record<string, unknown>): TransparencyEntry => ({
  sequence: Number(r.sequence),
  issuer: String(r.issuer),
  keyId: String(r.key_id),
  status: String(r.status) as KeyEntryStatus,
  publicKeyDigest: String(r.public_key_digest),
  recordedAt: new Date(r.recorded_at as string).toISOString(),
  previousHash: (r.previous_hash as string | null) ?? null,
  entryHash: String(r.entry_hash),
});

/**
 * Appends one entry **within the caller's transaction**. The caller must already hold the issuer's advisory lock (as
 * `SigningKeyRegistry` does), so two concurrent key changes cannot both read the same tail and write the same sequence.
 */
export async function appendKeyEntry(
  tx: TransactionSql,
  input: {
    issuer: string;
    keyId: string;
    status: KeyEntryStatus;
    publicJwk: unknown;
    now: string;
  },
): Promise<TransparencyEntry> {
  // ONE chain across all issuers, each entry naming its issuer. That is how migration 017 built the table and what
  // the contiguous `sequence` in verifyTransparencyLog requires; it is also how transparency logs are normally built,
  // because a per-issuer chain lets an issuer be the only witness to its own history.
  const [tail] =
    await tx`select * from key_transparency_log order by sequence desc limit 1`;
  const entry = appendTransparencyEntry(tail ? toEntry(tail) : null, {
    issuer: input.issuer,
    keyId: input.keyId,
    status: input.status,
    publicKeyDigest: publicKeyDigest(input.publicJwk),
    recordedAt: input.now,
  });
  // `sequence` is GENERATED ALWAYS, but it is inside the entry hash, so the stored value must be the hashed one.
  // Safe because every caller holds the issuer's advisory lock and appends are serialised by it.
  await tx`insert into key_transparency_log
    (sequence, issuer, key_id, status, public_key_digest, recorded_at, previous_hash, entry_hash)
    overriding system value
    values (${entry.sequence}, ${entry.issuer}, ${entry.keyId}, ${entry.status}, ${entry.publicKeyDigest},
      ${entry.recordedAt}, ${entry.previousHash}, ${entry.entryHash})`;
  return entry;
}

export interface LogVerdict {
  readonly entries: readonly TransparencyEntry[];
  readonly intact: boolean;
  readonly notice: string;
}

/** The log as published, with the chain checked on the way out rather than taken on trust. */
export async function readKeyTransparencyLog(sql: Sql): Promise<LogVerdict> {
  const rows = await sql`select * from key_transparency_log order by sequence`;
  const entries = rows.map(toEntry);
  const intact = verifyTransparencyLog(entries);
  return {
    entries,
    intact,
    notice: intact
      ? "Every signing key change PayFlow has made, each entry carrying the hash of the one before it. Check it yourself: the chain is the evidence, not our word for it."
      : "This log does not verify. An entry has been changed or removed. Treat proofs as unverified and say so.",
  };
}
