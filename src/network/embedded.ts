import { z } from "zod";

export const EmbeddedAuthoritySessionSchema = z
  .object({
    sessionId: z.string().min(1),
    organizationId: z.string().min(1),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    principalId: z.string().min(1),
    sponsorPrincipalId: z.string().min(1).optional(),
    allowedTemplateIds: z.array(z.string().min(1)).max(50),
    returnUrl: z.string().url(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    status: z.enum(["OPEN", "COMPLETED", "CANCELLED", "EXPIRED"]),
  })
  .strict();
export type EmbeddedAuthoritySession = Readonly<
  z.infer<typeof EmbeddedAuthoritySessionSchema>
>;

export function validateEmbeddedSession(
  raw: unknown,
  now: string,
  expectedOrganizationId: string,
  expectedEnvironment: "SANDBOX" | "PRODUCTION",
): EmbeddedAuthoritySession {
  const session = EmbeddedAuthoritySessionSchema.parse(raw);
  if (session.organizationId !== expectedOrganizationId)
    throw new Error("EMBEDDED_TENANT_MISMATCH");
  if (session.environment !== expectedEnvironment)
    throw new Error("EMBEDDED_ENVIRONMENT_MISMATCH");
  if (session.status !== "OPEN") throw new Error("EMBEDDED_SESSION_INACTIVE");
  const at = Date.parse(now);
  if (
    at < Date.parse(session.issuedAt) ||
    at >= Date.parse(session.expiresAt)
  ) {
    throw new Error("EMBEDDED_SESSION_EXPIRED");
  }
  return session;
}

export interface EmbeddedAuthorityCandidate {
  readonly templateId: string;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly humanReviewed: boolean;
}

/**
 * Embedded surfaces can construct candidates only. Activation remains an
 * authenticated server-side Authority transition outside the component.
 */
export function buildEmbeddedAuthorityCandidate(
  session: EmbeddedAuthoritySession,
  candidate: EmbeddedAuthorityCandidate,
): EmbeddedAuthorityCandidate {
  if (!session.allowedTemplateIds.includes(candidate.templateId)) {
    throw new Error("EMBEDDED_TEMPLATE_NOT_ALLOWED");
  }
  if (!candidate.humanReviewed)
    throw new Error("EMBEDDED_HUMAN_REVIEW_REQUIRED");
  return Object.freeze({
    templateId: candidate.templateId,
    constraints: Object.freeze({ ...candidate.constraints }),
    humanReviewed: true,
  });
}
