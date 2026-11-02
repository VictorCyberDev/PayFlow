import {
  createHash,
  verify as cryptoVerify,
  createPublicKey,
  type JsonWebKey,
} from "node:crypto";
import { z } from "zod";

/**
 * Optional signed facts about the economic action. Additive within payflow-proof/v1: proofs
 * without it stay valid and verify exactly as before; when present it is covered by the signature,
 * so any change to agent, amount, merchant or currency invalidates the proof.
 */
const SubjectSchema = z
  .object({
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    capability: z.string().min(1),
    amountMinor: z.number().int().safe().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    merchantId: z.string().min(1),
  })
  .strict();
export type PortableProofSubject = Readonly<z.infer<typeof SubjectSchema>>;

const PortableProofSchema = z
  .object({
    version: z.literal("payflow-proof/v1"),
    issuer: z.string().min(1),
    keyId: z.string().min(1),
    authorityId: z.string().min(1),
    actionId: z.string().min(1),
    outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
    effectCount: z.union([z.literal(0), z.literal(1), z.null()]),
    observedAt: z.string().datetime(),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    subject: SubjectSchema.optional(),
    signature: z.string().min(32),
  })
  .strict();
export type PortableProof = Readonly<z.infer<typeof PortableProofSchema>>;
export type PortableProofPayload = Omit<PortableProof, "signature">;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function portableProofPayloadBytes(
  payload: PortableProofPayload,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
}

/**
 * `maxAgeSeconds` is a freshness window for live presentations (default 24h). Pass `null` to
 * verify historical evidence by authenticity only: a proof of a past payment stays valid forever,
 * but a proof dated in the future is always refused.
 */
export function verifyPortableProof(
  raw: unknown,
  publicJwk: JsonWebKey,
  now: string,
  maxAgeSeconds: number | null = 86400,
): { valid: boolean; reason: string; proof?: PortableProof } {
  const parsed = PortableProofSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, reason: "MALFORMED_PROOF" };
  const proof = parsed.data;
  const observed = Date.parse(proof.observedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(at)) {
    return { valid: false, reason: "STALE_PROOF" };
  }
  if (maxAgeSeconds === null) {
    if (observed - at > 5 * 60 * 1000)
      return { valid: false, reason: "PROOF_FROM_FUTURE" };
  } else if (Math.abs(at - observed) > maxAgeSeconds * 1000) {
    return { valid: false, reason: "STALE_PROOF" };
  }
  let key;
  try {
    key = createPublicKey({ key: publicJwk, format: "jwk" });
  } catch {
    return { valid: false, reason: "INVALID_PUBLIC_KEY" };
  }
  const { signature, ...payload } = proof;
  const valid = cryptoVerify(
    null,
    portableProofPayloadBytes(payload),
    key,
    Buffer.from(signature, "base64url"),
  );
  if (!valid) return { valid: false, reason: "SIGNATURE_INVALID" };
  if (proof.outcome === "SUCCEEDED" && proof.effectCount !== 1) {
    return { valid: false, reason: "INCONSISTENT_EFFECT_COUNT" };
  }
  if (proof.outcome === "FAILED" && proof.effectCount !== 0) {
    return { valid: false, reason: "INCONSISTENT_EFFECT_COUNT" };
  }
  if (proof.outcome === "UNKNOWN" && proof.effectCount !== null) {
    return { valid: false, reason: "INCONSISTENT_EFFECT_COUNT" };
  }
  return { valid: true, reason: "PROOF_VALID", proof };
}

export function proofDigest(raw: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(raw)), "utf8")
    .digest("hex");
}

/** The proof's signed facts compared with what a relying party expects. Returns mismatches. */
export function matchesExpected(
  proof: PortableProof,
  expected: {
    issuer?: string;
    agentId?: string;
    authorityId?: string;
    amountMinor?: number;
    currency?: string;
    merchantId?: string;
  },
): string[] {
  const mismatches: string[] = [];
  const need = (field: string, actual: unknown, wanted: unknown) => {
    if (wanted !== undefined && actual !== wanted) mismatches.push(field);
  };
  need("issuer", proof.issuer, expected.issuer);
  need("authorityId", proof.authorityId, expected.authorityId);
  const bound = [
    expected.agentId,
    expected.amountMinor,
    expected.currency,
    expected.merchantId,
  ].some((v) => v !== undefined);
  if (bound && !proof.subject) return [...mismatches, "subject_not_in_proof"];
  need("agentId", proof.subject?.agentId, expected.agentId);
  need("amountMinor", proof.subject?.amountMinor, expected.amountMinor);
  need("currency", proof.subject?.currency, expected.currency);
  need("merchantId", proof.subject?.merchantId, expected.merchantId);
  return mismatches;
}

/** A JWKS-style document, as returned by GET /v1/keys. */
export function selectKey(document: unknown, keyId: string): JsonWebKey | null {
  const doc = document as { keys?: { keyId?: string; jwk?: JsonWebKey }[] };
  return doc.keys?.find((k) => k.keyId === keyId)?.jwk ?? null;
}

const money = (minor: number, currency: string): string =>
  currency === "USD"
    ? `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 === 0 ? 0 : 2 })}`
    : `${(minor / 100).toFixed(2)} ${currency}`;

/**
 * Plain-language reading of a proof for a person: the verdict first, then the facts, never raw
 * cryptographic fields. UNKNOWN is never described as success or as failure.
 */
export function explainProof(result: {
  valid: boolean;
  reason: string;
  proof?: PortableProof;
}): string[] {
  if (!result.valid || !result.proof)
    return ["PayFlow Proof", "Verified: NO", `Reason: ${result.reason}`];
  const p = result.proof;
  const outcome =
    p.outcome === "SUCCEEDED"
      ? "Paid once (one provider effect)"
      : p.outcome === "FAILED"
        ? "$0 moved"
        : "We're confirming whether money moved. Do not retry.";
  const lines = ["PayFlow Proof", "Verified: YES"];
  if (p.subject) {
    lines.push(
      `Agent: ${p.subject.agentId}`,
      `Action: ${p.subject.capability === "CAPTURE_PAYMENT" ? "Purchase" : p.subject.capability}`,
      `Amount: ${money(p.subject.amountMinor, p.subject.currency)}`,
      `Merchant: ${p.subject.merchantId}`,
    );
  } else {
    lines.push("Agent/amount/merchant: not recorded in this proof");
  }
  lines.push(
    `Authority: ${p.authorityId}`,
    `Economic outcome: ${outcome}`,
    `Issuer: ${p.issuer}`,
    `Signed: ${p.observedAt}`,
  );
  return lines;
}
