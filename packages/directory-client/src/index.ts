import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  holderJwk,
  verifyStatusListSignature,
  type StatusList,
  type VerifierEnvironment,
} from "../../verifier/src/authority.js";

/**
 * Issuer directory: how a verifier learns an issuer's keys without trusting whoever answers the request.
 *
 * Threat model: an attacker who can answer HTTPS for the issuer's URL at some moment (a compromised host, a DNS or CDN
 * incident, a stale mirror) tries to (a) substitute their own keys, (b) roll the verifier back to an older key set where a
 * since-revoked key was still good, (c) make the verifier fetch an internal URL, or (d) keep a revoked key alive.
 *
 * Defences, all in this file:
 *   - the verifier is configured with the issuers it fetches and a PIN (thumbprint) for each issuer's first root key;
 *     it never fetches a URL it was handed by a credential or a caller;
 *   - a directory must be SIGNED by a key the verifier already trusts: a pinned key the first time, afterwards a key from
 *     the previously accepted directory (so rotation is a chain, not a leap of faith);
 *   - `sequence` only moves forward; the same sequence with different content is refused as equivocation;
 *   - a key id never changes key; a revoked key stays listed as revoked and can never return;
 *   - cache lifetime is bounded; once expired the directory is not used (fail closed), a fetch failure only extends nothing;
 *   - HTTPS only, no redirects, no private/loopback/link-local addresses, bounded size and time.
 */
export const DIRECTORY_VERSION = "payflow-issuer-directory/v1" as const;
export const MAX_DIRECTORY_BYTES = 64 * 1024;
export const MAX_CACHE_SECONDS = 24 * 3600;
const SKEW_MS = 60_000;

export interface DirectoryKey {
  readonly kid: string;
  readonly alg: "Ed25519";
  readonly jwk: JsonWebKey;
  readonly status: "ACTIVE" | "RETIRED" | "REVOKED";
  readonly notBefore: string;
  /** For RETIRED keys: the last moment credentials signed by it are still honoured. */
  readonly notAfter?: string;
}
export interface DirectoryDocument {
  readonly v: typeof DIRECTORY_VERSION;
  /** The issuer origin, for example https://issuer.example. It must equal the origin the verifier fetched from. */
  readonly issuer: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly keys: readonly DirectoryKey[];
  /** Where the issuer's signed status list lives; must be on the issuer's origin. */
  readonly statusListUrl?: string;
}
export interface SignedDirectory {
  readonly doc: DirectoryDocument;
  readonly signatures: readonly {
    readonly kid: string;
    readonly sig: string;
  }[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const bytes = (doc: DirectoryDocument) =>
  Buffer.from(
    `${DIRECTORY_VERSION}/document\n${JSON.stringify(canonical(doc))}`,
    "utf8",
  );
const digestOf = (doc: DirectoryDocument) =>
  createHash("sha256").update(bytes(doc)).digest("hex");

/** RFC 7638-style thumbprint of an Ed25519 public key: what an operator pins out of band. */
export const thumbprint = (jwk: JsonWebKey): string =>
  createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");

export function signDirectory(
  doc: DirectoryDocument,
  signers: readonly { kid: string; privateKey: KeyObject }[],
): SignedDirectory {
  return {
    doc,
    signatures: signers.map((s) => ({
      kid: s.kid,
      sig: cryptoSign(null, bytes(doc), s.privateKey).toString("base64url"),
    })),
  };
}
export { holderJwk };

function verifies(
  doc: DirectoryDocument,
  sig: string,
  jwk: JsonWebKey,
): boolean {
  try {
    return cryptoVerify(
      null,
      bytes(doc),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return false;
  }
}
const isEd25519 = (k: JsonWebKey | undefined): k is JsonWebKey =>
  !!k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string";

export type RefreshOutcome =
  | "ACCEPTED"
  | "UNCHANGED"
  | "UNKNOWN_ISSUER"
  | "FETCH_REFUSED"
  | "FETCH_FAILED"
  | "TOO_LARGE"
  | "MALFORMED"
  | "ISSUER_MISMATCH"
  | "NOT_CURRENT"
  | "UNTRUSTED_SIGNATURE"
  | "ROLLBACK"
  | "EQUIVOCATION"
  | "KEY_ID_REUSED"
  | "REVOCATION_DROPPED"
  | "REVOCATION_REVERSED"
  | "CACHE_TOO_LONG";

export interface IssuerConfig {
  /** Where the directory lives. Must be on the issuer's own origin. */
  readonly directoryUrl: string;
  /** Thumbprints of the issuer's initial root key(s), obtained out of band. */
  readonly pins: readonly string[];
  /** Tests and local development only. */
  readonly allowInsecureLoopback?: boolean;
}
export interface DirectoryClientOptions {
  readonly issuers: Readonly<Record<string, IssuerConfig>>;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  /** Test seam: resolves a host to addresses. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
}

export const isPrivateAddress = (address: string): boolean => {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return (
      x === "::" ||
      x === "::1" ||
      x.startsWith("fc") ||
      x.startsWith("fd") ||
      /^fe[89ab]/u.test(x) ||
      x.startsWith("ff")
    );
  }
  return true; // not an address we can reason about: refuse
};

interface Accepted {
  readonly doc: DirectoryDocument;
  readonly digest: string;
}

export class IssuerDirectoryClient {
  private readonly accepted = new Map<string, Accepted>();
  private readonly statuses = new Map<string, StatusList>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;

  constructor(private readonly options: DirectoryClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------- safe fetching
  private async fetchJson(
    issuer: string,
    url: string,
    config: IssuerConfig,
  ): Promise<
    { ok: true; body: unknown } | { ok: false; outcome: RefreshOutcome }
  > {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { ok: false, outcome: "FETCH_REFUSED" };
    }
    const loopback =
      config.allowInsecureLoopback &&
      ["127.0.0.1", "localhost"].includes(target.hostname);
    if (
      target.origin !== new URL(issuer).origin ||
      (target.protocol !== "https:" && !loopback) ||
      target.username ||
      target.password
    )
      return { ok: false, outcome: "FETCH_REFUSED" };
    if (!loopback) {
      try {
        const addresses = isIP(target.hostname)
          ? [target.hostname]
          : await (this.options.resolve?.(target.hostname) ??
              lookup(target.hostname, { all: true }).then((r) =>
                r.map((a) => a.address),
              ));
        if (addresses.length === 0 || addresses.some(isPrivateAddress))
          return { ok: false, outcome: "FETCH_REFUSED" };
      } catch {
        return { ok: false, outcome: "FETCH_FAILED" };
      }
    }
    try {
      const response = await this.fetcher(target, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      if (!response.ok) return { ok: false, outcome: "FETCH_FAILED" };
      if (
        !(response.headers.get("content-type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      )
        return { ok: false, outcome: "MALFORMED" };
      if (
        Number(response.headers.get("content-length") ?? 0) >
        MAX_DIRECTORY_BYTES
      )
        return { ok: false, outcome: "TOO_LARGE" };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_DIRECTORY_BYTES)
        return { ok: false, outcome: "TOO_LARGE" };
      return { ok: true, body: JSON.parse(buffer.toString("utf8")) as unknown };
    } catch {
      return { ok: false, outcome: "FETCH_FAILED" };
    }
  }

  // -------------------------------------------------------------------- directory
  async refresh(issuer: string): Promise<RefreshOutcome> {
    const config = this.options.issuers[issuer];
    if (!config) return "UNKNOWN_ISSUER";
    const got = await this.fetchJson(issuer, config.directoryUrl, config);
    if (!got.ok) return got.outcome;
    return this.accept(issuer, config, got.body);
  }

  /** Exposed so the acceptance rules can be tested and so a caller with its own transport can use them. */
  accept(
    issuer: string,
    config: Pick<IssuerConfig, "pins">,
    raw: unknown,
  ): RefreshOutcome {
    const signed = raw as SignedDirectory | null;
    const doc = signed?.doc;
    if (
      !doc ||
      doc.v !== DIRECTORY_VERSION ||
      !Array.isArray(doc.keys) ||
      !Array.isArray(signed.signatures) ||
      !Number.isSafeInteger(doc.sequence) ||
      doc.sequence < 0 ||
      !(doc.keys as readonly DirectoryKey[]).every(
        (k) =>
          k &&
          typeof k.kid === "string" &&
          k.alg === "Ed25519" &&
          isEd25519(k.jwk) &&
          ["ACTIVE", "RETIRED", "REVOKED"].includes(k.status) &&
          Number.isFinite(Date.parse(k.notBefore)),
      ) ||
      new Set((doc.keys as readonly DirectoryKey[]).map((k) => k.kid)).size !==
        doc.keys.length
    )
      return "MALFORMED";
    if (doc.issuer !== issuer) return "ISSUER_MISMATCH";
    const keys: readonly DirectoryKey[] = doc.keys;
    const now = Date.parse(this.now());
    const issuedAt = Date.parse(doc.issuedAt);
    const validUntil = Date.parse(doc.validUntil);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(validUntil) ||
      validUntil <= issuedAt
    )
      return "MALFORMED";
    if (validUntil - issuedAt > MAX_CACHE_SECONDS * 1000)
      return "CACHE_TOO_LONG";
    if (issuedAt > now + SKEW_MS || now >= validUntil) return "NOT_CURRENT";

    // Who may vouch for this document: a pinned key the first time; the last accepted directory's active keys after that.
    const prior = this.accepted.get(issuer);
    const anchors = new Map<string, JsonWebKey>();
    for (const k of keys)
      if (k.status === "ACTIVE" && config.pins.includes(thumbprint(k.jwk)))
        anchors.set(k.kid, k.jwk);
    if (prior)
      for (const k of prior.doc.keys)
        if (k.status === "ACTIVE") anchors.set(k.kid, k.jwk);
    const signatures: SignedDirectory["signatures"] = signed.signatures;
    const trusted = signatures.some((s) => {
      const anchor = anchors.get(s.kid);
      const inNew = keys.find((k) => k.kid === s.kid);
      // The signer must not be revoked by this very document.
      return (
        !!anchor &&
        inNew?.status !== "REVOKED" &&
        typeof s.sig === "string" &&
        verifies(doc, s.sig, anchor)
      );
    });
    if (!trusted) return "UNTRUSTED_SIGNATURE";

    const digest = digestOf(doc);
    if (prior) {
      if (doc.sequence < prior.doc.sequence) return "ROLLBACK";
      if (doc.sequence === prior.doc.sequence)
        return digest === prior.digest ? "UNCHANGED" : "EQUIVOCATION";
      for (const old of prior.doc.keys) {
        const now2 = keys.find((k) => k.kid === old.kid);
        if (now2 && thumbprint(now2.jwk) !== thumbprint(old.jwk))
          return "KEY_ID_REUSED";
        if (old.status === "REVOKED") {
          if (!now2) return "REVOCATION_DROPPED";
          if (now2.status !== "REVOKED") return "REVOCATION_REVERSED";
        }
        if (old.status === "RETIRED" && now2?.status === "ACTIVE")
          return "REVOCATION_REVERSED";
      }
    }
    this.accepted.set(issuer, { doc, digest });
    return "ACCEPTED";
  }

  /** Current key for this issuer and key id, or null. Never returns a revoked, not-yet-valid or expired-cache key. */
  issuerKey(issuer: string, kid: string, nowIso: string): JsonWebKey | null {
    const entry = this.accepted.get(issuer);
    if (!entry) return null;
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now) || now >= Date.parse(entry.doc.validUntil))
      return null; // fail closed once stale
    const key = entry.doc.keys.find((k) => k.kid === kid);
    if (
      !key ||
      key.status === "REVOKED" ||
      now + SKEW_MS < Date.parse(key.notBefore)
    )
      return null;
    if (
      key.status === "RETIRED" &&
      (!key.notAfter || now >= Date.parse(key.notAfter))
    )
      return null;
    return key.jwk;
  }

  // -------------------------------------------------------------------- status list
  async refreshStatus(issuer: string): Promise<RefreshOutcome> {
    const config = this.options.issuers[issuer];
    const entry = this.accepted.get(issuer);
    if (!config || !entry?.doc.statusListUrl) return "UNKNOWN_ISSUER";
    const got = await this.fetchJson(issuer, entry.doc.statusListUrl, config);
    if (!got.ok) return got.outcome;
    const list = got.body as StatusList | null;
    if (
      !list ||
      list.iss !== issuer ||
      !Array.isArray(list.revoked) ||
      typeof list.sig !== "string"
    )
      return "MALFORMED";
    const key = this.issuerKey(issuer, list.kid, this.now());
    // Authenticate BEFORE caching: an unauthenticated list must not be able to evict a good one or set its freshness.
    if (!key || !verifyStatusListSignature(list, key))
      return "UNTRUSTED_SIGNATURE";
    const prior = this.statuses.get(issuer);
    // Newer lists only: an older one could un-revoke something.
    if (prior && Date.parse(list.issuedAt) < Date.parse(prior.issuedAt))
      return "ROLLBACK";
    this.statuses.set(issuer, list);
    return "ACCEPTED";
  }

  statusList(issuer: string): StatusList | null {
    return this.statuses.get(issuer) ?? null;
  }

  /** The pieces of a M22 verifier environment this client can supply. Trust bounds stay the verifier's own decision. */
  environment(): Pick<VerifierEnvironment, "issuerKey" | "statusList"> {
    return {
      issuerKey: (iss, kid, now) => this.issuerKey(iss, kid, now),
      statusList: (iss) => this.statusList(iss),
    };
  }
}
