import { z } from "zod";
import {
  explainProof,
  matchesExpected,
  selectKey,
  verifyPortableProof,
} from "../../packages/verifier/src/index.js";

/**
 * Public, anonymous, read-only Proof verification. It answers one question: "is this signed Proof authentic, and what
 * does it say?" It reads published PUBLIC keys and nothing else: no tenant data, no database write, no outbound call.
 * Everything in the answer is derived from the Proof the caller sent plus the verdict.
 *
 * It trusts only the issuer this host publishes keys for. A Proof from any other issuer is "UNKNOWN_ISSUER": the host
 * never fetches a key from a URL a caller supplied (no SSRF), and federated issuers are a separate, reviewed step (M24).
 */
export const MAX_VERIFY_BODY_BYTES = 16 * 1024;

const ExpectSchema = z
  .object({
    issuer: z.string().max(128).optional(),
    agentId: z.string().max(128).optional(),
    authorityId: z.string().max(128).optional(),
    amountMinor: z.number().int().safe().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    merchantId: z.string().max(128).optional(),
  })
  .strict();

export const VerifyProofRequestSchema = z
  .object({
    proof: z.record(z.string(), z.unknown()),
    expect: ExpectSchema.optional(),
    /** Require freshness. Omit to verify a historical Proof by authenticity only. */
    maxAgeSeconds: z.number().int().min(60).max(31_536_000).optional(),
  })
  .strict();

export interface HostedVerifyContext {
  /** The one issuer this host publishes keys for. */
  readonly issuer: string;
  /** Public key document (`GET /v1/keys`). Public by design. */
  readonly keys: () => Promise<unknown>;
  readonly now: () => string;
}

export interface HostedVerifyReply {
  readonly status: 200 | 400;
  readonly body: Record<string, unknown>;
}

const refuse = (reason: string): HostedVerifyReply => ({
  status: 400,
  body: {
    verified: false,
    reason,
    summary: ["Verified: NO", `Reason: ${reason}`],
    mismatches: [],
    humanSummary:
      "The request is not a valid Proof verification request. Nothing was checked.",
  },
});

export async function verifyProofRequest(
  rawBody: unknown,
  context: HostedVerifyContext,
): Promise<HostedVerifyReply> {
  const parsed = VerifyProofRequestSchema.safeParse(rawBody);
  if (!parsed.success) return refuse("MALFORMED_VERIFY_REQUEST");
  const { proof, expect, maxAgeSeconds } = parsed.data;
  const checkedAt = context.now();
  const unverified = (reason: string): HostedVerifyReply => ({
    status: 200,
    body: {
      verified: false,
      reason,
      summary: ["Verified: NO", `Reason: ${reason}`],
      mismatches: [],
      checkedAt,
    },
  });
  const keyId = typeof proof.keyId === "string" ? proof.keyId : "";
  if (!keyId) return unverified("MALFORMED_PROOF");
  if (proof.issuer !== context.issuer) return unverified("UNKNOWN_ISSUER");
  const jwk = selectKey(await context.keys(), keyId);
  if (!jwk) return unverified("UNKNOWN_KEY");
  const result = verifyPortableProof(
    proof,
    jwk,
    checkedAt,
    maxAgeSeconds ?? null,
  );
  const mismatches =
    result.valid && result.proof && expect
      ? matchesExpected(
          result.proof,
          Object.fromEntries(
            Object.entries(expect).filter(([, v]) => v !== undefined),
          ),
        )
      : [];
  const summary = explainProof(result);
  if (mismatches.length) {
    summary[1] = "Verified: NO";
    summary.push(`Does not match what you expected: ${mismatches.join(", ")}`);
  }
  const verified = result.valid && mismatches.length === 0;
  return {
    status: 200,
    body: {
      verified,
      // "authentic" is the signature; "verified" additionally requires every expectation to match.
      authentic: result.valid,
      reason: result.reason,
      mismatches,
      summary,
      checkedAt,
      ...(result.valid && result.proof
        ? {
            outcome: result.proof.outcome,
            // null means UNKNOWN. It is never turned into 0.
            effectCount: result.proof.effectCount,
            issuer: result.proof.issuer,
            keyId: result.proof.keyId,
            actionId: result.proof.actionId,
          }
        : {}),
    },
  };
}
