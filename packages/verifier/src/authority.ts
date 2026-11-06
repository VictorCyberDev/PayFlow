import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

/**
 * PayFlow Authority Credential v1: Authority a third party can verify OFFLINE.
 *
 * An issuer signs a root credential naming the agent's public key (the holder) and the bounds it may act within. The
 * holder may hand a narrower slice to another agent by signing a link with its own key; no issuer is contacted. To use
 * it, the last holder signs a short-lived presentation bound to ONE verifier (audience) and ONE challenge, which proves
 * it holds the key and defeats replay to a different verifier.
 *
 * A verifier needs only: the issuer's public key (from a directory it trusts), a fresh signed status list, and its own
 * audience and challenge. Verification never calls the issuer and never grants anything: it answers "is this agent
 * carrying authority from a trusted issuer that covers THIS action, right now?". Paying is still decided by the
 * Authority in the Gateway; a credential is evidence, not a payment instrument.
 */
export const CREDENTIAL_VERSION = "payflow-authority-credential/v1" as const;
export const MAX_CREDENTIAL_DEPTH = 5;
/** A presentation is meant for one conversation: it cannot live longer than this. */
export const MAX_PRESENTATION_SECONDS = 300;
const CLOCK_SKEW_MS = 60_000;

export interface AuthorityScope {
  readonly actionKinds: readonly string[];
  readonly currencies: readonly string[];
  readonly counterpartyIds: readonly string[];
  readonly maxAmountMinor: number;
}

export interface RootClaims {
  readonly v: typeof CREDENTIAL_VERSION;
  readonly iss: string;
  readonly kid: string;
  readonly jti: string;
  /** The agent this authority was issued to. */
  readonly sub: string;
  readonly principal: string;
  /** The holder's public key (Ed25519). Only its private half can extend or present this credential. */
  readonly holder: JsonWebKey;
  readonly scope: AuthorityScope;
  /** Verifiers this credential may be shown to. Absent means any. */
  readonly aud?: readonly string[];
  readonly nbf: string;
  readonly exp: string;
  readonly maxDepth: number;
}
export interface LinkClaims {
  readonly jti: string;
  readonly parentJti: string;
  /** Binds this link to exactly one parent element, so it cannot be re-parented. */
  readonly parentDigest: string;
  readonly sub: string;
  readonly holder: JsonWebKey;
  readonly scope: AuthorityScope;
  readonly aud?: readonly string[];
  readonly nbf: string;
  readonly exp: string;
}
export interface Credential {
  readonly root: { readonly claims: RootClaims; readonly sig: string };
  readonly links: readonly {
    readonly claims: LinkClaims;
    readonly sig: string;
  }[];
}
export interface Presentation {
  readonly credential: Credential;
  readonly proof: {
    readonly aud: string;
    readonly challenge: string;
    readonly nonce: string;
    readonly iat: string;
    readonly exp: string;
    readonly sig: string;
  };
}
export interface StatusList {
  readonly iss: string;
  readonly kid: string;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly revoked: readonly string[];
  readonly sig: string;
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
const bytes = (domain: string, value: unknown) =>
  Buffer.from(`${domain}\n${JSON.stringify(canonical(value))}`, "utf8");
const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const sign = (domain: string, value: unknown, key: KeyObject) =>
  cryptoSign(null, bytes(domain, value), key).toString("base64url");
function check(domain: string, value: unknown, sig: string, jwk: JsonWebKey) {
  try {
    return cryptoVerify(
      null,
      bytes(domain, value),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Domain separation: a signature made for one kind of object can never validate as another. */
const D = {
  root: "payflow-authority-credential/v1/root",
  link: "payflow-authority-credential/v1/link",
  proof: "payflow-authority-credential/v1/presentation",
  status: "payflow-authority-credential/v1/status",
} as const;

export const holderJwk = (publicKey: KeyObject): JsonWebKey =>
  publicKey.export({ format: "jwk" });

// ---------------------------------------------------------------- issuing, narrowing, presenting
export function issueCredential(
  claims: RootClaims,
  issuerPrivateKey: KeyObject,
): Credential {
  return {
    root: { claims, sig: sign(D.root, claims, issuerPrivateKey) },
    links: [],
  };
}

/** The current holder delegates a (narrower) slice to another key. Verification, not this function, enforces narrowing. */
export function extendCredential(
  credential: Credential,
  currentHolderPrivateKey: KeyObject,
  child: Omit<LinkClaims, "parentJti" | "parentDigest">,
): Credential {
  const parent = credential.links.at(-1) ?? credential.root;
  const claims: LinkClaims = {
    ...child,
    parentJti: parent.claims.jti,
    parentDigest: sha256(parent),
  };
  return {
    root: credential.root,
    links: [
      ...credential.links,
      { claims, sig: sign(D.link, claims, currentHolderPrivateKey) },
    ],
  };
}

export function present(
  credential: Credential,
  holderPrivateKey: KeyObject,
  binding: {
    aud: string;
    challenge: string;
    nonce: string;
    iat: string;
    exp: string;
  },
): Presentation {
  const signed = {
    ...binding,
    credentialDigest: sha256(credential),
  };
  return {
    credential,
    proof: { ...binding, sig: sign(D.proof, signed, holderPrivateKey) },
  };
}

export function buildStatusList(
  list: Omit<StatusList, "sig">,
  issuerPrivateKey: KeyObject,
): StatusList {
  return { ...list, sig: sign(D.status, list, issuerPrivateKey) };
}

// ---------------------------------------------------------------- verification
export interface IssuerTrust {
  /** Trusted issuer ids and what they may vouch for (same bounds as the federation trust profile). */
  readonly issuer: string;
  readonly status: "TRUSTED" | "SUSPENDED" | "REVOKED";
  readonly maxDelegationDepth: number;
  readonly allowedActionKinds: readonly string[];
  readonly allowedCurrencies: readonly string[];
  readonly maxAmountMinor: number;
}
export interface VerifierEnvironment {
  /** The issuer's current public key for this key id, or null. Comes from a directory the VERIFIER trusts. */
  readonly issuerKey: (
    iss: string,
    kid: string,
    now: string,
  ) => JsonWebKey | null;
  readonly trust: (iss: string) => IssuerTrust | null;
  /** A signed status list for the issuer, as fresh as the verifier could get. */
  readonly statusList: (iss: string) => StatusList | null;
  /** Atomic first-use claim of a presentation nonce for this verifier. Omit to skip replay protection (not advised). */
  readonly claimNonce?: (
    scope: string,
    nonce: string,
  ) => boolean | Promise<boolean>;
}
export interface ExpectedUse {
  readonly aud: string;
  readonly challenge: string;
  readonly now: string;
  /** The exact action the verifier is about to rely on the credential for. */
  readonly action?: {
    readonly kind: string;
    readonly currency: string;
    readonly counterpartyId: string;
    readonly amountMinor: number;
  };
}
export type Reason =
  | "MALFORMED"
  | "UNKNOWN_ISSUER"
  | "ISSUER_NOT_TRUSTED"
  | "UNKNOWN_ISSUER_KEY"
  | "ROOT_SIGNATURE_INVALID"
  | "LINK_SIGNATURE_INVALID"
  | "CHAIN_BROKEN"
  | "SCOPE_WIDENED"
  | "VALIDITY_WIDENED"
  | "DEPTH_EXCEEDED"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "STATUS_LIST_MISSING"
  | "STATUS_LIST_INVALID"
  | "STATUS_LIST_STALE"
  | "REVOKED"
  | "AUDIENCE_NOT_PERMITTED"
  | "PRESENTATION_AUDIENCE_MISMATCH"
  | "CHALLENGE_MISMATCH"
  | "PRESENTATION_WINDOW_INVALID"
  | "POSSESSION_NOT_PROVEN"
  | "ACTION_NOT_IN_SCOPE"
  | "ISSUER_BOUNDS_EXCEEDED"
  | "REPLAYED";
export interface Verdict {
  readonly valid: boolean;
  readonly reasons: readonly Reason[];
  /** The authority actually carried, after every narrowing. Present only when valid. */
  readonly effective?: AuthorityScope;
  readonly agent?: string;
  readonly issuer?: string;
  readonly depth?: number;
  readonly credentialId?: string;
}

const subset = (a: readonly string[], b: readonly string[]) =>
  a.every((x) => b.includes(x));
const time = (s: string) => Date.parse(s);
const isEd25519 = (k: JsonWebKey | undefined): k is JsonWebKey =>
  !!k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string";
const isScope = (s: AuthorityScope | undefined): s is AuthorityScope =>
  !!s &&
  Array.isArray(s.actionKinds) &&
  Array.isArray(s.currencies) &&
  Array.isArray(s.counterpartyIds) &&
  Number.isSafeInteger(s.maxAmountMinor) &&
  s.maxAmountMinor > 0;

export async function verifyPresentation(
  raw: unknown,
  use: ExpectedUse,
  env: VerifierEnvironment,
): Promise<Verdict> {
  const fail = (...reasons: Reason[]): Verdict => ({ valid: false, reasons });
  const p = raw as Presentation | null;
  const cred = p?.credential;
  const root = cred?.root?.claims;
  if (
    !p?.proof ||
    !root ||
    !Array.isArray(cred?.links) ||
    root.v !== CREDENTIAL_VERSION ||
    !isScope(root.scope) ||
    typeof root.iss !== "string" ||
    typeof root.sub !== "string" ||
    !isEd25519(root.holder) ||
    !Number.isSafeInteger(root.maxDepth) ||
    root.maxDepth < 0 ||
    !Number.isFinite(time(root.nbf)) ||
    !Number.isFinite(time(root.exp))
  )
    return fail("MALFORMED");
  const now = time(use.now);
  if (!Number.isFinite(now)) return fail("MALFORMED");

  // 1. Issuer: known, trusted, and its key is current. The verifier decides who it trusts, never the credential.
  const trust = env.trust(root.iss);
  if (!trust) return fail("UNKNOWN_ISSUER");
  if (trust.status !== "TRUSTED") return fail("ISSUER_NOT_TRUSTED");
  const issuerKey = env.issuerKey(root.iss, root.kid, use.now);
  if (!issuerKey) return fail("UNKNOWN_ISSUER_KEY");
  if (!check(D.root, root, cred.root.sig, issuerKey))
    return fail("ROOT_SIGNATURE_INVALID");

  // 2. Walk the chain: each link is signed by the previous holder, bound to its exact parent, and only narrows.
  const reasons = new Set<Reason>();
  let parent: { claims: RootClaims | LinkClaims; sig: string } = cred.root;
  let scope = root.scope;
  let holder = root.holder;
  let agent = root.sub;
  const ids = [root.jti];
  let notBefore = time(root.nbf);
  let notAfter = time(root.exp);
  let audiences: readonly string[] | undefined = root.aud;
  if (
    cred.links.length >
    Math.min(root.maxDepth, MAX_CREDENTIAL_DEPTH, trust.maxDelegationDepth)
  )
    reasons.add("DEPTH_EXCEEDED");
  const links: Credential["links"] = cred.links;
  for (const link of links) {
    const c = link?.claims;
    if (
      !c ||
      !isScope(c.scope) ||
      !isEd25519(c.holder) ||
      !Number.isFinite(time(c.nbf)) ||
      !Number.isFinite(time(c.exp))
    )
      return fail("MALFORMED");
    if (!check(D.link, c, link.sig, holder))
      return fail("LINK_SIGNATURE_INVALID");
    if (c.parentJti !== parent.claims.jti || c.parentDigest !== sha256(parent))
      return fail("CHAIN_BROKEN");
    if (
      !subset(c.scope.actionKinds, scope.actionKinds) ||
      !subset(c.scope.currencies, scope.currencies) ||
      !subset(c.scope.counterpartyIds, scope.counterpartyIds) ||
      c.scope.maxAmountMinor > scope.maxAmountMinor
    )
      reasons.add("SCOPE_WIDENED");
    if (time(c.nbf) < notBefore || time(c.exp) > notAfter)
      reasons.add("VALIDITY_WIDENED");
    // A link may only narrow the audiences; naming a verifier its parent did not allow would widen it.
    if (audiences && (!c.aud || !subset(c.aud, audiences)))
      reasons.add("SCOPE_WIDENED");
    scope = {
      actionKinds: c.scope.actionKinds,
      currencies: c.scope.currencies,
      counterpartyIds: c.scope.counterpartyIds,
      maxAmountMinor: Math.min(c.scope.maxAmountMinor, scope.maxAmountMinor),
    };
    notBefore = Math.max(notBefore, time(c.nbf));
    notAfter = Math.min(notAfter, time(c.exp));
    audiences = c.aud ?? audiences;
    holder = c.holder;
    agent = c.sub;
    ids.push(c.jti);
    parent = link;
  }

  // 3. Lifecycle: the window, the audience, and the issuer's signed revocation list.
  if (now + CLOCK_SKEW_MS < notBefore) reasons.add("NOT_YET_VALID");
  if (now - CLOCK_SKEW_MS >= notAfter) reasons.add("EXPIRED");
  if (audiences && !audiences.includes(use.aud))
    reasons.add("AUDIENCE_NOT_PERMITTED");
  const status = env.statusList(root.iss);
  if (!status) reasons.add("STATUS_LIST_MISSING");
  else if (
    status.iss !== root.iss ||
    !(() => {
      const key = env.issuerKey(status.iss, status.kid, use.now);
      const { sig, ...body } = status;
      return !!key && check(D.status, body, sig, key);
    })()
  )
    reasons.add("STATUS_LIST_INVALID");
  else {
    if (
      now >= time(status.validUntil) ||
      time(status.issuedAt) > now + CLOCK_SKEW_MS
    )
      reasons.add("STATUS_LIST_STALE");
    // Revoking any element revokes it and everything built on it.
    if (ids.some((id) => status.revoked.includes(id))) reasons.add("REVOKED");
  }

  // 4. Proof of possession: the LAST holder signed this exact credential for THIS verifier and THIS challenge.
  const { sig: proofSig, ...binding } = p.proof;
  if (binding.aud !== use.aud) reasons.add("PRESENTATION_AUDIENCE_MISMATCH");
  if (binding.challenge !== use.challenge) reasons.add("CHALLENGE_MISMATCH");
  const iat = time(binding.iat);
  const exp = time(binding.exp);
  if (
    !Number.isFinite(iat) ||
    !Number.isFinite(exp) ||
    exp <= iat ||
    exp - iat > MAX_PRESENTATION_SECONDS * 1000 ||
    now + CLOCK_SKEW_MS < iat ||
    now - CLOCK_SKEW_MS >= exp
  )
    reasons.add("PRESENTATION_WINDOW_INVALID");
  if (
    !check(
      D.proof,
      { ...binding, credentialDigest: sha256(cred) },
      proofSig,
      holder,
    )
  )
    reasons.add("POSSESSION_NOT_PROVEN");

  // 5. The issuer's trust bounds, and the action the verifier is about to rely on.
  if (
    scope.maxAmountMinor > trust.maxAmountMinor ||
    !subset(scope.actionKinds, trust.allowedActionKinds) ||
    !subset(scope.currencies, trust.allowedCurrencies)
  )
    reasons.add("ISSUER_BOUNDS_EXCEEDED");
  if (use.action) {
    const a = use.action;
    if (
      !scope.actionKinds.includes(a.kind) ||
      !scope.currencies.includes(a.currency) ||
      !scope.counterpartyIds.includes(a.counterpartyId) ||
      !(a.amountMinor > 0 && a.amountMinor <= scope.maxAmountMinor)
    )
      reasons.add("ACTION_NOT_IN_SCOPE");
  }
  if (reasons.size > 0) return { valid: false, reasons: [...reasons] };

  // 6. Only a presentation that passed everything consumes its nonce, so a refusal never burns a good one.
  if (
    env.claimNonce &&
    !(await env.claimNonce(`pac:${use.aud}:${use.challenge}`, binding.nonce))
  )
    return fail("REPLAYED");
  return {
    valid: true,
    reasons: [],
    effective: scope,
    agent,
    issuer: root.iss,
    depth: cred.links.length,
    credentialId: ids.at(-1) as string,
  };
}
