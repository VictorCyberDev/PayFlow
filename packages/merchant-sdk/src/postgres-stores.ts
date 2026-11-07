import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { ChallengeStore, ClaimResult, ProofLedger } from "./verifier.js";

/**
 * Shared, durable stores for the Merchant Verify SDK (migration 028). Several merchant instances pointed at one database
 * behave as ONE verifier: a challenge or a presentation nonce is spent once across all of them, and a payment pays one
 * order. State survives a restart. Every operation is a single atomic statement; none of them guesses.
 *
 * Failure semantics: if the database cannot answer, these THROW. `MerchantVerifier` turns that into `STORE_UNAVAILABLE`
 * (verification refused) or a HOLD (Proof association), never into "valid" and never into "no payment".
 *
 * `namespace` separates merchants that share a database (use the merchant's counterparty id).
 */
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const at = (ms: number) => new Date(ms).toISOString();

export class PostgresChallengeStore implements ChallengeStore {
  readonly async = true as const;
  constructor(
    private readonly sql: Sql,
    private readonly namespace: string,
  ) {}

  async put(
    challenge: string,
    record: { digest: string; expiresAt: number },
    now: number,
  ): Promise<void> {
    // Housekeeping: expired rows are useless. Consumed ones are kept until they expire so a replay stays refused.
    await this
      .sql`delete from merchant_challenges where namespace = ${this.namespace} and expires_at < ${at(now - 3_600_000)}`;
    await this
      .sql`insert into merchant_challenges (namespace, challenge_hash, order_digest, expires_at)
      values (${this.namespace}, ${sha(challenge)}, ${record.digest}, ${at(record.expiresAt)})`;
  }

  async peek(challenge: string, digest: string, now: number): Promise<boolean> {
    const rows = await this.sql`
      select 1 from merchant_challenges
      where namespace = ${this.namespace} and challenge_hash = ${sha(challenge)} and order_digest = ${digest}
        and consumed_at is null and expires_at > ${at(now)}`;
    return rows.length === 1;
  }

  /** One UPDATE: of any number of concurrent callers, exactly one gets a row back. */
  async consume(
    challenge: string,
    digest: string,
    now: number,
  ): Promise<boolean> {
    const rows = await this.sql`
      update merchant_challenges set consumed_at = ${at(now)}
      where namespace = ${this.namespace} and challenge_hash = ${sha(challenge)} and order_digest = ${digest}
        and consumed_at is null and expires_at > ${at(now)}
      returning 1 as ok`;
    return rows.length === 1;
  }
}

/** Atomic first-use claim of a presentation nonce, shared across instances. Pass it as `claimNonce`. */
export class PostgresNonceStore {
  constructor(
    private readonly sql: Sql,
    private readonly namespace: string,
    private readonly now: () => number = () => Date.now(),
    /** At least as long as a presentation can live (the credential format caps that at five minutes). */
    private readonly retainMs = 3_600_000,
  ) {}

  readonly claim = async (scope: string, nonce: string): Promise<boolean> => {
    const now = this.now();
    await this
      .sql`delete from merchant_nonces where namespace = ${this.namespace} and expires_at < ${at(now)}`;
    const rows = await this.sql`
      insert into merchant_nonces (namespace, scope, nonce, expires_at)
      values (${this.namespace}, ${scope.slice(0, 600)}, ${nonce.slice(0, 300)}, ${at(now + this.retainMs)})
      on conflict do nothing
      returning 1 as ok`;
    return rows.length === 1;
  };
}

/** One payment pays one order and one order is paid by one payment, across instances and restarts. */
export class PostgresProofLedger implements ProofLedger {
  constructor(
    private readonly sql: Sql,
    private readonly namespace: string,
  ) {}

  async claim(actionId: string, orderId: string): Promise<ClaimResult> {
    return this.sql.begin(async (tx) => {
      // Serialise claims that touch the same action OR the same order, so the two unique keys cannot race each other.
      await tx`select pg_advisory_xact_lock(hashtextextended(${"mpc:" + this.namespace + ":" + actionId}, 5))`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${"mpo:" + this.namespace + ":" + orderId}, 5))`;
      const [byAction] = await tx`
        select order_id from merchant_proof_claims where namespace = ${this.namespace} and action_id = ${actionId}`;
      if (byAction)
        return String(byAction.order_id) === orderId
          ? ("SAME_ORDER_AGAIN" as const)
          : ("ACTION_USED_FOR_ANOTHER_ORDER" as const);
      const [byOrder] = await tx`
        select action_id from merchant_proof_claims where namespace = ${this.namespace} and order_id = ${orderId}`;
      if (byOrder) return "ORDER_PAID_BY_ANOTHER_ACTION" as const;
      await tx`insert into merchant_proof_claims (namespace, action_id, order_id)
        values (${this.namespace}, ${actionId}, ${orderId})`;
      return "CLAIMED" as const;
    });
  }
}
