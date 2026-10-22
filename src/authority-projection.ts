import { z } from "zod";
import { CapabilitySchema, ProductConditionSchema } from "./domain.js";

const id = z.string().min(1).max(128);
const minor = z.number().int().safe().nonnegative();
/** Bounded display contract, never an authorization input or execution capability. */
export const AuthorityProjectionSchema = z
  .object({
    version: z.literal("payflow.authority-view.v1"),
    mandateId: id,
    principalId: id,
    agent: z
      .object({
        id,
        displayName: z.string().min(1).max(120),
        status: z.enum([
          "ACTIVE",
          "SUSPENDED",
          "REVOKED",
          "EXPIRED",
          "UNAVAILABLE",
        ]),
      })
      .strict(),
    purpose: z.string().min(1).max(500),
    currency: z.string().regex(/^[A-Z]{3}$/),
    singleMaximumMinor: minor,
    cumulativeLimitMinor: minor.nullable(),
    committedMinor: minor,
    reservedMinor: minor,
    remainingMinor: minor.nullable(),
    quantityLimit: z.number().int().positive().max(1000).nullable(),
    quantityRemaining: z.number().int().nonnegative().max(1000).nullable(),
    merchantScopeSummary: z.string().min(1).max(500),
    allowedConditions: z.array(ProductConditionSchema).min(1).max(3),
    allowedCapabilities: z.array(CapabilitySchema).min(1).max(7),
    autonomousThresholdMinor: minor,
    humanApprovalThresholdMinor: minor,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    state: z.enum(["ACTIVE", "REVOKED", "EXPIRED", "UNAVAILABLE"]),
    freshDispatchBlocked: z.boolean().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const invalid =
      v.singleMaximumMinor === 0 ||
      Date.parse(v.createdAt) >= Date.parse(v.expiresAt) ||
      Date.parse(v.createdAt) > Date.parse(v.observedAt) ||
      v.autonomousThresholdMinor > v.humanApprovalThresholdMinor ||
      v.humanApprovalThresholdMinor > v.singleMaximumMinor ||
      (v.cumulativeLimitMinor === null
        ? v.remainingMinor !== null
        : !Number.isSafeInteger(v.committedMinor + v.reservedMinor) ||
          v.singleMaximumMinor > v.cumulativeLimitMinor ||
          v.committedMinor + v.reservedMinor > v.cumulativeLimitMinor ||
          v.remainingMinor !==
            v.cumulativeLimitMinor - v.committedMinor - v.reservedMinor) ||
      (v.quantityLimit === null
        ? v.quantityRemaining !== null
        : v.quantityRemaining === null ||
          v.quantityRemaining > v.quantityLimit) ||
      (v.state === "ACTIVE" &&
        (Date.parse(v.observedAt) >= Date.parse(v.expiresAt) ||
          v.agent.status !== "ACTIVE")) ||
      (v.state !== "ACTIVE" && v.freshDispatchBlocked !== true);
    if (invalid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Inconsistent authority view",
      });
  });
export type AuthorityProjection = Readonly<
  z.infer<typeof AuthorityProjectionSchema>
>;

/** Future trusted host port. Implement using one owner-scoped durable snapshot,
 * existing repository accounting/current state, and server clock. No browser input,
 * no financial decisions, no write methods. M5A intentionally supplies no adapter. */
export interface AuthorityViewReader {
  readOwned(principalId: string, mandateId: string): Promise<unknown>;
}
export interface AuthorityViewerVerifier {
  /** Must verify trusted host session, not decode a client owner identifier. */
  requirePrincipal(context: unknown): Promise<string>;
}
export class AuthorityViewService {
  constructor(
    private readonly viewer: AuthorityViewerVerifier,
    private readonly reader: AuthorityViewReader,
  ) {}
  async read(
    context: unknown,
    request: unknown,
  ): Promise<AuthorityProjection | null> {
    const query = z.object({ mandateId: id }).strict().safeParse(request);
    if (!query.success) return null;
    try {
      const principalId = id.parse(await this.viewer.requirePrincipal(context));
      const raw = await this.reader.readOwned(
        principalId,
        query.data.mandateId,
      );
      const parsed = AuthorityProjectionSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.principalId !== principalId ||
        parsed.data.mandateId !== query.data.mandateId
      )
        return null;
      // Strict schema + JSON copy prevents internal fields and shared mutable aliases.
      return AuthorityProjectionSchema.parse(
        JSON.parse(JSON.stringify(parsed.data)),
      );
    } catch {
      return null;
    }
  }
}
