import type { JsonWebKey } from "node:crypto";
import type { Sql } from "postgres";

/**
 * M14 proof-signing key lifecycle. The registry holds PUBLIC keys only; a private key is supplied
 * to the process by its environment and never reaches the database (the table refuses a JWK that
 * carries `d`).
 *
 *   activate(new)  -> new becomes ACTIVE, the previous ACTIVE becomes RETIRED (still verifies)
 *   rollback       -> activate(old) again: old ACTIVE, new RETIRED. A REVOKED key cannot return.
 *   revoke(key)    -> withdrawn after a compromise: removed from the verification document, so
 *                     proofs signed by it stop verifying. This is deliberate.
 */
export type KeyStatus = "ACTIVE" | "RETIRED" | "REVOKED" | "NEXT";

export interface PublishedKey {
  readonly keyId: string;
  readonly jwk: JsonWebKey;
  readonly status: Exclude<KeyStatus, "REVOKED" | "NEXT">;
}

export interface KeyRecord {
  readonly keyId: string;
  readonly jwk: JsonWebKey;
  readonly status: KeyStatus;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly retiredAt: string | null;
  readonly revokedAt: string | null;
}

export class SigningKeyRegistry {
  constructor(private readonly sql: Sql) {}

  async activate(
    issuer: string,
    keyId: string,
    publicJwk: JsonWebKey,
    now: string,
  ): Promise<"ACTIVATED" | "ALREADY_ACTIVE"> {
    if ("d" in (publicJwk as object)) throw new Error("PRIVATE_KEY_MATERIAL");
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"signing:" + issuer}, 4))`;
      const cur =
        await tx`select key_id, status, public_jwk from proof_signing_keys where key_id = ${keyId} for update`;
      // A key id names ONE public key for ever. Rotating the key without changing its id would
      // publish the old public key while signing with the new one: every new Proof would fail.
      if (
        cur[0] &&
        (cur[0].public_jwk as { x?: string }).x !==
          (publicJwk as { x?: string }).x
      )
        throw new Error("KEY_ID_REUSED_WITH_DIFFERENT_KEY");
      if (cur[0]?.status === "REVOKED") throw new Error("KEY_REVOKED");
      if (cur[0]?.status === "ACTIVE") return "ALREADY_ACTIVE";
      await tx`update proof_signing_keys set status = 'RETIRED', retired_at = ${now}
        where issuer = ${issuer} and status = 'ACTIVE'`;
      if (cur[0])
        await tx`update proof_signing_keys set status = 'ACTIVE', activated_at = ${now}, retired_at = null
          where key_id = ${keyId}`;
      else
        await tx`insert into proof_signing_keys (key_id, issuer, public_jwk, status, created_at, activated_at)
          values (${keyId}, ${issuer}, ${tx.json(publicJwk as never)}, 'ACTIVE', ${now}, ${now})`;
      return "ACTIVATED";
    });
  }

  /**
   * Announce a key that will sign LATER (status NEXT). It is not used to sign and not published for Proof verification
   * yet; the issuer directory lists it as trusted so that the directory signed by it after the switch is accepted by
   * verifiers by continuity (the previous directory already named it). Starting a process with this key then promotes it
   * with `activate`, which retires the previous ACTIVE key as before. Announcing never changes the ACTIVE key, so a cold
   * start of an old-key process in the meantime cannot undo anything.
   */
  async announce(
    issuer: string,
    keyId: string,
    publicJwk: JsonWebKey,
    now: string,
  ): Promise<"ANNOUNCED" | "ALREADY_KNOWN"> {
    if ("d" in (publicJwk as object)) throw new Error("PRIVATE_KEY_MATERIAL");
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"signing:" + issuer}, 4))`;
      const cur =
        await tx`select status, public_jwk from proof_signing_keys where key_id = ${keyId} for update`;
      if (cur[0]) {
        if (
          (cur[0].public_jwk as { x?: string }).x !==
          (publicJwk as { x?: string }).x
        )
          throw new Error("KEY_ID_REUSED_WITH_DIFFERENT_KEY");
        if (cur[0].status === "REVOKED") throw new Error("KEY_REVOKED");
        return "ALREADY_KNOWN";
      }
      await tx`insert into proof_signing_keys (key_id, issuer, public_jwk, status, created_at)
        values (${keyId}, ${issuer}, ${tx.json(publicJwk as never)}, 'NEXT', ${now})`;
      return "ANNOUNCED";
    });
  }

  async revoke(keyId: string, now: string): Promise<boolean> {
    const rows = await this.sql`
      update proof_signing_keys set status = 'REVOKED', revoked_at = ${now}
      where key_id = ${keyId} and status <> 'REVOKED' returning key_id`;
    return rows.length === 1;
  }

  /**
   * Every key the issuer has ever published, REVOKED ones included as tombstones, so a verifier that already trusted a key
   * can learn that it was withdrawn (a directory that simply dropped it would hide the revocation).
   */
  async listAll(issuer: string): Promise<readonly KeyRecord[]> {
    const rows = await this.sql`
      select key_id, public_jwk, status, created_at, activated_at, retired_at, revoked_at
      from proof_signing_keys where issuer = ${issuer}
      order by created_at, key_id`;
    return rows.map((r) => ({
      keyId: String(r.key_id),
      jwk: r.public_jwk as JsonWebKey,
      status: r.status as KeyStatus,
      createdAt: new Date(r.created_at as string).toISOString(),
      activatedAt: r.activated_at
        ? new Date(r.activated_at as string).toISOString()
        : null,
      retiredAt: r.retired_at
        ? new Date(r.retired_at as string).toISOString()
        : null,
      revokedAt: r.revoked_at
        ? new Date(r.revoked_at as string).toISOString()
        : null,
    }));
  }

  /** Every key a verifier may need: the ACTIVE one and RETIRED ones. Never REVOKED. */
  async published(issuer: string): Promise<readonly PublishedKey[]> {
    const rows = await this.sql`
      select key_id, public_jwk, status from proof_signing_keys
      where issuer = ${issuer} and status in ('ACTIVE','RETIRED')
      order by (status = 'ACTIVE') desc, created_at desc`;
    return rows.map((r) => ({
      keyId: String(r.key_id),
      jwk: r.public_jwk as JsonWebKey,
      status: r.status as PublishedKey["status"],
    }));
  }
}
