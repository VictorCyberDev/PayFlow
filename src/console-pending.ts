import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Sql } from "postgres";

export interface PendingRequest {
  action: "CONFIRM_EXACT_TERMS";
  reviewId: string;
  agentId: string;
  draftFingerprint: string;
  reviewedHash: string;
  challenge: string;
}
export interface PendingRecord {
  reviewId: string;
  ownerRef: string;
  displayHash: string;
  expiresAt: string;
  request: PendingRequest;
}
/** Server-only pending exact-confirmation material for ConsoleActivation. The browser only ever
 * holds reviewId and displayHash. */
export interface PendingStore {
  /** Count live (unexpired, unconsumed) entries; may prune expired ones. */
  count(now: Date): Promise<number>;
  put(record: PendingRecord, now: Date): Promise<void>;
  /** Return the request iff reviewId, owner and displayHash all match. Durable stores consume
   * the entry atomically so at most one caller can ever obtain it. */
  claim(
    query: { reviewId: string; ownerRef: string; displayHash: string },
    now: Date,
  ): Promise<PendingRequest | null>;
}

/** Process-local store: the accepted local-demo behavior (restart fails closed). */
export class MemoryPendingStore implements PendingStore {
  readonly #entries = new Map<string, PendingRecord>();
  count(now: Date) {
    for (const [id, p] of this.#entries)
      if (Date.parse(p.expiresAt) <= now.getTime()) this.#entries.delete(id);
    return Promise.resolve(this.#entries.size);
  }
  put(record: PendingRecord) {
    this.#entries.set(record.reviewId, record);
    return Promise.resolve();
  }
  claim(q: { reviewId: string; ownerRef: string; displayHash: string }) {
    const p = this.#entries.get(q.reviewId);
    return Promise.resolve(
      p && p.ownerRef === q.ownerRef && p.displayHash === q.displayHash
        ? p.request
        : null,
    );
  }
}

/** Authenticated encryption for the raw activation challenge at rest. The reviewId is bound as
 * associated data so ciphertext cannot be moved between rows. */
export function protectChallenge(
  key: Buffer,
  reviewId: string,
  challenge: string,
): string {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(reviewId));
  const ct = Buffer.concat([c.update(challenge, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct]
    .map((v) => (typeof v === "string" ? v : v.toString("base64url")))
    .join(".");
}
export function unprotectChallenge(
  key: Buffer,
  reviewId: string,
  protectedValue: string,
): string {
  const [v, iv, tag, ct] = protectedValue.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("PENDING_UNREADABLE");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(reviewId));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    d.update(Buffer.from(ct, "base64url")),
    d.final(),
  ]).toString("utf8");
}

/** Durable store shared by every host instance. Isolated host-state table: no financial rows. */
export class PostgresPendingStore implements PendingStore {
  constructor(
    private readonly sql: Sql,
    private readonly key: Buffer,
  ) {}
  async count(now: Date) {
    await this
      .sql`delete from console_pending_actions where expires_at <= ${now}`;
    const [r] = await this
      .sql`select count(*) n from console_pending_actions where consumed_at is null and expires_at > ${now}`;
    return Number(r?.n ?? 0);
  }
  async put(record: PendingRecord, now: Date) {
    await this.sql`
      insert into console_pending_actions
        (review_id, owner_session_hash, display_hash, agent_id, draft_fingerprint,
         reviewed_hash, challenge_protected, created_at, expires_at)
      values (${record.reviewId}, ${record.ownerRef}, ${record.displayHash},
        ${record.request.agentId}, ${record.request.draftFingerprint},
        ${record.request.reviewedHash},
        ${protectChallenge(this.key, record.reviewId, record.request.challenge)},
        ${now}, ${new Date(record.expiresAt)})`;
  }
  async claim(
    q: { reviewId: string; ownerRef: string; displayHash: string },
    now: Date,
  ) {
    // Single conditional UPDATE: the row lock makes concurrent claims (any instance) serial, and
    // the loser re-evaluates consumed_at IS NULL against the committed winner.
    const [r] = await this.sql`
      update console_pending_actions set consumed_at=${now}
      where review_id=${q.reviewId} and owner_session_hash=${q.ownerRef}
        and display_hash=${q.displayHash} and consumed_at is null and expires_at > ${now}
      returning agent_id, draft_fingerprint, reviewed_hash, challenge_protected`;
    if (!r) return null;
    return {
      action: "CONFIRM_EXACT_TERMS" as const,
      reviewId: q.reviewId,
      agentId: String(r.agent_id),
      draftFingerprint: String(r.draft_fingerprint),
      reviewedHash: String(r.reviewed_hash),
      challenge: unprotectChallenge(
        this.key,
        q.reviewId,
        String(r.challenge_protected),
      ),
    };
  }
}
