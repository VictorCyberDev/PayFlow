import { z } from "zod";

export const DirectoryKeySchema = z
  .object({
    kid: z.string().min(1),
    alg: z.enum(["Ed25519", "ES256"]),
    publicJwk: z.record(z.string(), z.unknown()),
    status: z.enum(["ACTIVE", "ROTATING", "REVOKED"]),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime().optional(),
  })
  .strict();

export const AuthorityDomainMetadataSchema = z
  .object({
    version: z.literal("authority-directory/v1"),
    issuer: z.string().url(),
    status: z.enum(["TRUSTED", "UNTRUSTED", "REVOKED"]),
    capabilities: z
      .array(z.enum(["ISSUE_AUTHORITY", "VERIFY_AUTHORITY", "VERIFY_PROOF"]))
      .min(1),
    endpoints: z
      .object({
        verification: z.string().url(),
        proof: z.string().url().optional(),
        metadata: z.string().url(),
      })
      .strict(),
    keys: z.array(DirectoryKeySchema).min(1),
    cacheMaxAgeSeconds: z.number().int().safe().positive().max(86_400),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AuthorityDomainMetadata = Readonly<
  z.infer<typeof AuthorityDomainMetadataSchema>
>;

export class AuthorityDirectory {
  private readonly domains = new Map<string, AuthorityDomainMetadata>();

  register(raw: unknown): AuthorityDomainMetadata {
    const metadata = AuthorityDomainMetadataSchema.parse(raw);
    this.domains.set(metadata.issuer, metadata);
    return metadata;
  }

  resolveIssuer(issuer: string): AuthorityDomainMetadata | null {
    return this.domains.get(issuer) ?? null;
  }

  resolveActiveKey(issuer: string, kid: string, now: string) {
    const metadata = this.resolveIssuer(issuer);
    if (!metadata || metadata.status !== "TRUSTED") return null;
    const at = Date.parse(now);
    return (
      metadata.keys.find((key) => {
        if (key.kid !== kid || key.status === "REVOKED") return false;
        if (at < Date.parse(key.validFrom)) return false;
        return key.validUntil === undefined || at < Date.parse(key.validUntil);
      }) ?? null
    );
  }
}
