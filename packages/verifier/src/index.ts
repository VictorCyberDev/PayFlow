import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { z } from "zod";

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
    signature: z.string().min(32),
  })
  .strict();
export type PortableProof = Readonly<z.infer<typeof PortableProofSchema>>;

function payloadBytes(proof: PortableProof): Buffer {
  const { signature: _signature, ...payload } = proof;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function verifyPortableProof(
  raw: unknown,
  publicJwk: JsonWebKey,
  now: string,
  maxAgeSeconds = 86400,
): { valid: boolean; reason: string; proof?: PortableProof } {
  const parsed = PortableProofSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, reason: "MALFORMED_PROOF" };
  const proof = parsed.data;
  const observed = Date.parse(proof.observedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(at) || Math.abs(at - observed) > maxAgeSeconds * 1000) {
    return { valid: false, reason: "STALE_PROOF" };
  }
  let key;
  try {
    key = createPublicKey({ key: publicJwk, format: "jwk" });
  } catch {
    return { valid: false, reason: "INVALID_PUBLIC_KEY" };
  }
  const valid = cryptoVerify(null, payloadBytes(proof), key, Buffer.from(proof.signature, "base64url"));
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
  return createHash("sha256").update(JSON.stringify(raw), "utf8").digest("hex");
}
