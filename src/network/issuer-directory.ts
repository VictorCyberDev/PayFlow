import { createHash, type JsonWebKey, type KeyObject } from "node:crypto";
import type { Sql } from "postgres";
import {
  DIRECTORY_VERSION,
  signDirectory,
  type DirectoryDocument,
  type DirectoryKey,
  type SignedDirectory,
} from "../../packages/directory-client/src/index.js";
import type { SigningKeyRegistry } from "./signing-keys.js";

/**
 * PayFlow's published issuer directory (`GET /v1/issuer/directory`).
 *
 * Three rules make it safe to trust through the M24 client:
 *  1. A published document is immutable. It is stored and re-served byte for byte; a new SEQUENCE is cut only when the key
 *     set changes or the document nears expiry, under a database lock, so concurrent requests, other instances and restarts
 *     cannot produce two different documents for one sequence (equivocation).
 *  2. Revoked keys stay listed as REVOKED, and retired keys carry an explicit end of grace, so a verifier can learn of both.
 *  3. It is signed by this process's signing key, which must be known to the registry and not revoked. Rotation is a chain:
 *     announce the new key while the old one still signs, then switch the signing secret; the second document is signed by
 *     a key the first one already trusted.
 */
export const DIRECTORY_VALID_SECONDS = 3600;
const REFRESH_BEFORE_EXPIRY_MS = 15 * 60 * 1000;
/** Credentials live at most 24 h, so a retired key must keep verifying that long. */
const RETIRED_GRACE_MS = 24 * 3600 * 1000;

export type PublishFailure =
  "SIGNING_KEY_UNKNOWN" | "SIGNING_KEY_REVOKED" | "NO_KEYS";

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");

export class IssuerDirectoryPublisher {
  constructor(
    private readonly deps: {
      sql: Sql;
      registry: SigningKeyRegistry;
      /** The registry issuer name the keys are filed under (the organization id). */
      registryIssuer: string;
      /** The issuer id verifiers use: an origin. */
      issuer: string;
      signer: { kid: string; privateKey: KeyObject };
      statusListUrl: string;
      now: () => string;
    },
  ) {}

  private async keyView(): Promise<readonly DirectoryKey[]> {
    const records = await this.deps.registry.listAll(this.deps.registryIssuer);
    return records.map((r) => ({
      kid: r.keyId,
      alg: "Ed25519" as const,
      jwk: r.jwk,
      // An announced key is trusted to sign the NEXT directory, so the directory lists it as ACTIVE.
      status: r.status === "NEXT" ? ("ACTIVE" as const) : r.status,
      notBefore: r.activatedAt ?? r.createdAt,
      ...(r.status === "RETIRED" && r.retiredAt
        ? {
            notAfter: new Date(
              Date.parse(r.retiredAt) + RETIRED_GRACE_MS,
            ).toISOString(),
          }
        : {}),
    }));
  }

  /** The current signed directory, cutting a new sequence only when it must. Throws PublishFailure-coded errors. */
  async current(): Promise<SignedDirectory> {
    const keys = await this.keyView();
    const signing = keys.find((k) => k.kid === this.deps.signer.kid);
    if (!signing)
      throw new Error("SIGNING_KEY_UNKNOWN" satisfies PublishFailure);
    if (signing.status === "REVOKED")
      throw new Error("SIGNING_KEY_REVOKED" satisfies PublishFailure);
    if (!keys.some((k) => k.status === "ACTIVE"))
      throw new Error("NO_KEYS" satisfies PublishFailure);
    const keysDigest = digest(
      keys.map((k) => ({
        kid: k.kid,
        x: (k.jwk as { x?: string }).x,
        status: k.status,
        notBefore: k.notBefore,
        notAfter: k.notAfter,
      })),
    );
    return this.deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"directory:" + this.deps.issuer}, 7))`;
      const now = this.deps.now();
      const [latest] = await tx`
        select sequence, keys_digest, document_text, valid_until, signed_by
        from issuer_directory_publications
        where issuer = ${this.deps.issuer} order by sequence desc limit 1`;
      const fresh =
        latest &&
        latest.keys_digest === keysDigest &&
        latest.signed_by === this.deps.signer.kid &&
        Date.parse(now) <
          new Date(latest.valid_until as string).getTime() -
            REFRESH_BEFORE_EXPIRY_MS;
      if (fresh)
        return JSON.parse(String(latest.document_text)) as SignedDirectory;
      const sequence = latest ? Number(latest.sequence) + 1 : 1;
      const doc: DirectoryDocument = {
        v: DIRECTORY_VERSION,
        issuer: this.deps.issuer,
        sequence,
        issuedAt: now,
        validUntil: new Date(
          Date.parse(now) + DIRECTORY_VALID_SECONDS * 1000,
        ).toISOString(),
        keys,
        statusListUrl: this.deps.statusListUrl,
      };
      const signed = signDirectory(doc, [
        { kid: this.deps.signer.kid, privateKey: this.deps.signer.privateKey },
      ]);
      await tx`
        insert into issuer_directory_publications
          (issuer, sequence, keys_digest, document, document_text, issued_at, valid_until, signed_by)
        values (${this.deps.issuer}, ${sequence}, ${keysDigest},
          ${tx.json(JSON.parse(JSON.stringify(signed)) as never)}, ${JSON.stringify(signed)}, ${doc.issuedAt}, ${doc.validUntil},
          ${this.deps.signer.kid})`;
      return signed;
    });
  }
}

export type { JsonWebKey };
