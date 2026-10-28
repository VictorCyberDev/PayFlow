import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";

export const IssuerTrustProfileSchema = z
  .object({
    issuer: z.string().url(),
    status: z.enum(["TRUSTED", "SUSPENDED", "REVOKED"]),
    acceptedSchemaVersions: z.array(z.string().min(1)).min(1),
    maxDelegationDepth: z.number().int().safe().nonnegative().max(32),
    allowedActionKinds: z.array(z.string().min(1)).min(1),
    allowedCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    maxAmountMinor: z.number().int().safe().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type IssuerTrustProfile = Readonly<z.infer<typeof IssuerTrustProfileSchema>>;

export const ExternalAuthorityAssertionSchema = z
  .object({
    schemaVersion: z.string().min(1),
    issuer: z.string().url(),
    authorityId: z.string().min(1),
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    actionKinds: z.array(z.string().min(1)).min(1),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    maxAmountMinor: z.number().int().safe().positive(),
    delegationDepth: z.number().int().safe().nonnegative(),
    audience: z.string().min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ExternalAuthorityAssertion = Readonly<
  z.infer<typeof ExternalAuthorityAssertionSchema>
>;

export const SignedExternalAuthorityAssertionSchema = z
  .object({
    payload: ExternalAuthorityAssertionSchema,
    keyId: z.string().min(1),
    signature: z.string().min(32),
  })
  .strict();
export type SignedExternalAuthorityAssertion = Readonly<
  z.infer<typeof SignedExternalAuthorityAssertionSchema>
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function externalAuthorityAssertionBytes(
  assertion: ExternalAuthorityAssertion,
): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(assertion)), "utf8");
}

/**
 * Policy evaluation for an assertion whose cryptographic authenticity has
 * already been established. Network-facing code should use
 * verifyAndEvaluateExternalIssuerAssertion instead.
 */
export function evaluateExternalIssuerAssertion(
  rawAssertion: unknown,
  rawProfile: unknown,
  expectedAudience: string,
  now: string,
): { trusted: boolean; reasons: readonly string[]; assertion?: ExternalAuthorityAssertion } {
  const assertionResult = ExternalAuthorityAssertionSchema.safeParse(rawAssertion);
  const profileResult = IssuerTrustProfileSchema.safeParse(rawProfile);
  if (!assertionResult.success || !profileResult.success) {
    return { trusted: false, reasons: ["MALFORMED_EXTERNAL_AUTHORITY"] };
  }
  const assertion = assertionResult.data;
  const profile = profileResult.data;
  const reasons: string[] = [];
  if (profile.status !== "TRUSTED") reasons.push("ISSUER_NOT_TRUSTED");
  if (assertion.issuer !== profile.issuer) reasons.push("ISSUER_MISMATCH");
  if (!profile.acceptedSchemaVersions.includes(assertion.schemaVersion)) {
    reasons.push("SCHEMA_VERSION_DENIED");
  }
  if (assertion.audience !== expectedAudience) reasons.push("AUDIENCE_MISMATCH");
  if (
    Date.parse(now) < Date.parse(assertion.issuedAt) ||
    Date.parse(now) >= Date.parse(assertion.expiresAt)
  ) {
    reasons.push("ASSERTION_NOT_CURRENT");
  }
  if (assertion.delegationDepth > profile.maxDelegationDepth) {
    reasons.push("DELEGATION_DEPTH_EXCEEDED");
  }
  if (assertion.maxAmountMinor > profile.maxAmountMinor) {
    reasons.push("AMOUNT_TRUST_BOUNDARY_EXCEEDED");
  }
  if (!assertion.actionKinds.every((kind) => profile.allowedActionKinds.includes(kind))) {
    reasons.push("ACTION_TRUST_BOUNDARY_EXCEEDED");
  }
  if (!assertion.currencies.every((currency) => profile.allowedCurrencies.includes(currency))) {
    reasons.push("CURRENCY_TRUST_BOUNDARY_EXCEEDED");
  }
  return reasons.length === 0
    ? { trusted: true, reasons, assertion }
    : { trusted: false, reasons };
}

export function verifyAndEvaluateExternalIssuerAssertion(
  rawSignedAssertion: unknown,
  rawProfile: unknown,
  publicJwk: JsonWebKey,
  expectedAudience: string,
  now: string,
): { trusted: boolean; reasons: readonly string[]; assertion?: ExternalAuthorityAssertion; keyId?: string } {
  const signed = SignedExternalAuthorityAssertionSchema.safeParse(rawSignedAssertion);
  if (!signed.success) return { trusted: false, reasons: ["MALFORMED_SIGNED_ASSERTION"] };
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicJwk, format: "jwk" });
  } catch {
    return { trusted: false, reasons: ["INVALID_ISSUER_PUBLIC_KEY"] };
  }
  const authentic = cryptoVerify(
    null,
    externalAuthorityAssertionBytes(signed.data.payload),
    publicKey,
    Buffer.from(signed.data.signature, "base64url"),
  );
  if (!authentic) return { trusted: false, reasons: ["ISSUER_SIGNATURE_INVALID"] };
  const evaluated = evaluateExternalIssuerAssertion(
    signed.data.payload,
    rawProfile,
    expectedAudience,
    now,
  );
  return evaluated.trusted && evaluated.assertion
    ? { ...evaluated, keyId: signed.data.keyId }
    : evaluated;
}

export interface FederationDomain {
  readonly issuer: string;
  readonly status: "TRUSTED" | "REVOKED";
  readonly metadataFreshUntil: string;
  readonly verify: (
    presentation: unknown,
    audience: string,
    now: string,
  ) => Promise<{ verdict: string }>;
}

export async function federatedVerify(
  domains: ReadonlyMap<string, FederationDomain>,
  issuer: string,
  presentation: unknown,
  audience: string,
  now: string,
): Promise<{
  verdict:
    | "VALID"
    | "INVALID"
    | "REVOKED_ISSUER"
    | "STALE_METADATA"
    | "UNKNOWN_ISSUER";
  remoteVerdict?: string;
}> {
  const domain = domains.get(issuer);
  if (!domain) return { verdict: "UNKNOWN_ISSUER" };
  if (domain.status === "REVOKED") return { verdict: "REVOKED_ISSUER" };
  if (Date.parse(now) >= Date.parse(domain.metadataFreshUntil)) {
    return { verdict: "STALE_METADATA" };
  }
  const result = await domain.verify(presentation, audience, now);
  return {
    verdict: result.verdict === "VALID" ? "VALID" : "INVALID",
    remoteVerdict: result.verdict,
  };
}
