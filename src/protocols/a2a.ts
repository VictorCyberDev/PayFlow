import { z } from "zod";
import { FinancialActionKindSchema } from "../network/financial-action.js";

export const A2A_PROTOCOL_VERSION = "1.0" as const;

export function createPayFlowAgentCard(baseUrl: string) {
  const root = new URL(baseUrl);
  if (root.protocol !== "https:" && root.hostname !== "localhost") {
    throw new Error("A2A_HTTPS_REQUIRED");
  }
  return {
    name: "PayFlow Financial Authority",
    description:
      "Deterministic bounded financial Authority, verification, Proof, and reconciliation for autonomous systems.",
    supportedInterfaces: [
      {
        url: new URL("/a2a/v1", root).toString(),
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    version: "0.1.0-preview",
    documentationUrl: new URL("/docs", root).toString(),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      oauth: {
        httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "OAuth2" },
      },
    },
    securityRequirements: [{ oauth: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "financial-authority",
        name: "Financial Authority",
        description:
          "Check or request bounded financial Authority without exposing payment credentials.",
        tags: ["finance", "authorization", "delegation"],
        examples: [
          "Can this procurement agent pay this exact invoice under its Authority?",
        ],
      },
      {
        id: "financial-proof",
        name: "Financial Proof",
        description:
          "Verify what financial effect occurred, including UNKNOWN outcomes.",
        tags: ["finance", "proof", "reconciliation"],
      },
    ],
  } as const;
}

export const DelegatedFinancialScopeSchema = z
  .object({
    principalId: z.string().min(1),
    parentAgentId: z.string().min(1),
    childAgentId: z.string().min(1),
    audience: z.string().min(1),
    actionKinds: z.array(FinancialActionKindSchema).min(1),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    counterpartyIds: z.array(z.string().min(1)).min(1),
    maxAmountMinor: z.number().int().safe().positive(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    nonce: z.string().min(16),
  })
  .strict();
export type DelegatedFinancialScope = Readonly<
  z.infer<typeof DelegatedFinancialScopeSchema>
>;

export type DelegationViolation =
  | "PRINCIPAL_CHANGED"
  | "PARENT_CHAIN_BROKEN"
  | "ACTION_KIND_WIDENED"
  | "CURRENCY_WIDENED"
  | "COUNTERPARTY_WIDENED"
  | "AMOUNT_WIDENED"
  | "EXPIRY_WIDENED";

function isSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  return child.every((value) => parent.includes(value));
}

export function validateDelegationAttenuation(
  parent: DelegatedFinancialScope,
  child: DelegatedFinancialScope,
): readonly DelegationViolation[] {
  const violations: DelegationViolation[] = [];
  if (child.principalId !== parent.principalId)
    violations.push("PRINCIPAL_CHANGED");
  if (child.parentAgentId !== parent.childAgentId)
    violations.push("PARENT_CHAIN_BROKEN");
  if (!isSubset(child.actionKinds, parent.actionKinds))
    violations.push("ACTION_KIND_WIDENED");
  if (!isSubset(child.currencies, parent.currencies))
    violations.push("CURRENCY_WIDENED");
  if (!isSubset(child.counterpartyIds, parent.counterpartyIds)) {
    violations.push("COUNTERPARTY_WIDENED");
  }
  if (child.maxAmountMinor > parent.maxAmountMinor)
    violations.push("AMOUNT_WIDENED");
  if (Date.parse(child.expiresAt) > Date.parse(parent.expiresAt))
    violations.push("EXPIRY_WIDENED");
  return violations;
}

export type DelegatedRequestVerdict =
  | "ACCEPTED"
  | "DUPLICATE"
  | "WRONG_AUDIENCE"
  | "EXPIRED"
  | "WIDENED"
  | "MALFORMED";

export interface DelegationReplayStore {
  /** Atomic. Returns true only for the first claim of this nonce. */
  claimNonce(scope: string, nonce: string): Promise<boolean>;
}

/**
 * Evaluates an agent-to-agent delegation as untrusted input. It only decides
 * whether the delegation may be *presented* to the Trust Kernel; it never
 * authorizes money movement itself.
 */
export async function evaluateDelegatedRequest(
  rawChild: unknown,
  parent: DelegatedFinancialScope,
  expected: { audience: string; now: string },
  store: DelegationReplayStore,
): Promise<{
  verdict: DelegatedRequestVerdict;
  violations: readonly DelegationViolation[];
}> {
  const parsed = DelegatedFinancialScopeSchema.safeParse(rawChild);
  if (!parsed.success || !Number.isFinite(Date.parse(expected.now))) {
    return { verdict: "MALFORMED", violations: [] };
  }
  const child = parsed.data;
  if (child.audience !== expected.audience) {
    return { verdict: "WRONG_AUDIENCE", violations: [] };
  }
  const now = Date.parse(expected.now);
  if (now < Date.parse(child.issuedAt) || now >= Date.parse(child.expiresAt)) {
    return { verdict: "EXPIRED", violations: [] };
  }
  const violations = validateDelegationAttenuation(parent, child);
  if (violations.length > 0) return { verdict: "WIDENED", violations };
  const first = await store.claimNonce(
    `a2a:${child.audience}:${child.parentAgentId}:${child.childAgentId}`,
    child.nonce,
  );
  return { verdict: first ? "ACCEPTED" : "DUPLICATE", violations: [] };
}
