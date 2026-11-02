/**
 * Browser-safe verification of a `payflow-proof/v1` portable proof, using WebCrypto Ed25519.
 * Read-only: no network, no credentials, no PayFlow session. It deliberately mirrors the Node
 * verifier in packages/verifier (parity is pinned by tests/verify-proof-parity.test.ts) because the
 * browser graph may not import server code.
 */
export interface ProofSubject {
  principalId: string;
  agentId: string;
  capability: string;
  amountMinor: number;
  currency: string;
  merchantId: string;
  rail?: "SIMULATED" | "PAYPAL_SANDBOX";
}
export interface PortableProof {
  version: "payflow-proof/v1";
  issuer: string;
  keyId: string;
  authorityId: string;
  actionId: string;
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  effectCount: 0 | 1 | null;
  observedAt: string;
  evidenceDigest: string;
  subject?: ProofSubject;
  signature: string;
}
export type VerifyReason =
  | "PROOF_VALID"
  | "MALFORMED_PROOF"
  | "INVALID_PUBLIC_KEY"
  | "UNKNOWN_KEY"
  | "SIGNATURE_INVALID"
  | "INCONSISTENT_EFFECT_COUNT"
  | "PROOF_FROM_FUTURE";
export interface VerifyResult {
  valid: boolean;
  reason: VerifyReason;
  proof?: PortableProof;
}

const TOP_KEYS = [
  "version",
  "issuer",
  "keyId",
  "authorityId",
  "actionId",
  "outcome",
  "effectCount",
  "observedAt",
  "evidenceDigest",
  "subject",
  "signature",
];
const SUBJECT_KEYS = [
  "principalId",
  "agentId",
  "capability",
  "amountMinor",
  "currency",
  "merchantId",
  "rail",
];
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) =>
  Object.keys(o).every((k) => allowed.includes(k));

export function parseProof(raw: unknown): PortableProof | null {
  if (!isObj(raw) || !onlyKeys(raw, TOP_KEYS)) return null;
  if (raw.version !== "payflow-proof/v1") return null;
  for (const k of ["issuer", "keyId", "authorityId", "actionId"])
    if (!str(raw[k])) return null;
  if (!["SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(raw.outcome)))
    return null;
  if (!(
    raw.effectCount === 0 ||
    raw.effectCount === 1 ||
    raw.effectCount === null
  ))
    return null;
  if (!str(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt)))
    return null;
  if (
    typeof raw.evidenceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.evidenceDigest)
  )
    return null;
  if (typeof raw.signature !== "string" || raw.signature.length < 32)
    return null;
  if (raw.subject !== undefined) {
    const s = raw.subject;
    if (!isObj(s) || !onlyKeys(s, SUBJECT_KEYS)) return null;
    for (const k of ["principalId", "agentId", "capability", "merchantId"])
      if (!str(s[k])) return null;
    if (!Number.isSafeInteger(s.amountMinor) || (s.amountMinor as number) < 0)
      return null;
    if (
      s.rail !== undefined &&
      s.rail !== "SIMULATED" &&
      s.rail !== "PAYPAL_SANDBOX"
    )
      return null;
    if (typeof s.currency !== "string" || !/^[A-Z]{3}$/.test(s.currency))
      return null;
  }
  return raw as unknown as PortableProof;
}

/** Code-point key order, matching packages/verifier (never locale-dependent). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObj(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  return value;
}

const fromB64Url = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Accepts one public JWK, or the GET /v1/keys document (selected by the proof's keyId). */
export function selectPublicKey(
  doc: unknown,
  keyId: string,
): JsonWebKey | null {
  if (isObj(doc) && Array.isArray(doc.keys)) {
    const hit = (doc.keys as unknown[]).find(
      (k) => isObj(k) && k.keyId === keyId,
    );
    return isObj(hit) && isObj(hit.jwk) ? (hit.jwk as JsonWebKey) : null;
  }
  return isObj(doc) ? (doc as JsonWebKey) : null;
}

export async function verifyProof(
  rawProof: unknown,
  keyDocument: unknown,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const proof = parseProof(rawProof);
  if (!proof) return { valid: false, reason: "MALFORMED_PROOF" };
  if (Date.parse(proof.observedAt) - now.getTime() > 5 * 60 * 1000)
    return { valid: false, reason: "PROOF_FROM_FUTURE" };
  const jwk = selectPublicKey(keyDocument, proof.keyId);
  if (!jwk) return { valid: false, reason: "UNKNOWN_KEY" };
  if ("d" in jwk) return { valid: false, reason: "INVALID_PUBLIC_KEY" }; // never accept private material
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return { valid: false, reason: "INVALID_PUBLIC_KEY" };
  }
  const { signature, ...payload } = proof;
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(payload)));
  let authentic = false;
  try {
    authentic = await crypto.subtle.verify(
      "Ed25519",
      key,
      fromB64Url(signature),
      bytes,
    );
  } catch {
    authentic = false;
  }
  if (!authentic) return { valid: false, reason: "SIGNATURE_INVALID" };
  const consistent =
    (proof.outcome === "SUCCEEDED" && proof.effectCount === 1) ||
    (proof.outcome === "FAILED" && proof.effectCount === 0) ||
    (proof.outcome === "UNKNOWN" && proof.effectCount === null);
  if (!consistent) return { valid: false, reason: "INCONSISTENT_EFFECT_COUNT" };
  return { valid: true, reason: "PROOF_VALID", proof };
}

const money = (minor: number, currency: string) =>
  currency === "USD"
    ? `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 === 0 ? 0 : 2 })}`
    : `${(minor / 100).toFixed(2)} ${currency}`;

export interface Presentation {
  headline: "Verified" | "Not verified";
  /** Plain-language outcome. UNKNOWN is never success and never failure. */
  outcome?: string;
  facts: { label: string; value: string }[];
  reason: string;
}

const REASONS: Record<VerifyReason, string> = {
  PROOF_VALID: "The signature is authentic and the record is consistent.",
  MALFORMED_PROOF:
    "This is not a PayFlow Proof (wrong shape or unknown fields).",
  INVALID_PUBLIC_KEY: "The key is not a usable public key.",
  UNKNOWN_KEY: "No public key was provided for this Proof's key id.",
  SIGNATURE_INVALID:
    "The Proof was changed, or it was signed by a different key.",
  INCONSISTENT_EFFECT_COUNT: "The outcome and the effect count disagree.",
  PROOF_FROM_FUTURE: "The Proof is dated in the future.",
};

export function present(result: VerifyResult): Presentation {
  if (!result.valid || !result.proof)
    return {
      headline: "Not verified",
      facts: [],
      reason: REASONS[result.reason],
    };
  const p = result.proof;
  const facts: { label: string; value: string }[] = [];
  if (p.subject) {
    facts.push(
      { label: "Agent", value: p.subject.agentId },
      {
        label: "Action",
        value:
          p.subject.capability === "CAPTURE_PAYMENT"
            ? "Purchase"
            : p.subject.capability,
      },
      {
        label: "Amount",
        value: money(p.subject.amountMinor, p.subject.currency),
      },
      { label: "Merchant", value: p.subject.merchantId },
      ...(p.subject.rail
        ? [
            {
              label: "Rail",
              value:
                p.subject.rail === "SIMULATED"
                  ? "Simulated (no real money)"
                  : "PayPal Sandbox",
            },
          ]
        : []),
    );
  }
  facts.push(
    { label: "Authority", value: p.authorityId },
    { label: "Issuer", value: p.issuer },
    { label: "Signed", value: p.observedAt },
  );
  const outcome =
    p.outcome === "SUCCEEDED"
      ? "Paid once"
      : p.outcome === "FAILED"
        ? "$0 moved"
        : "We're confirming whether money moved. Don't retry.";
  return { headline: "Verified", outcome, facts, reason: REASONS.PROOF_VALID };
}
