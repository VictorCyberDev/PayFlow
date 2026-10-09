import { z } from "zod";

export const CapabilitySchema = z.enum([
  "SEARCH_PRODUCTS",
  "EVALUATE_PRODUCTS",
  "CREATE_ORDER",
  "CAPTURE_PAYMENT",
  "REQUEST_REFUND",
  "CREATE_SUBSCRIPTION",
  "OPEN_DISPUTE",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const MoneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minor: z.number().int().nonnegative(),
  })
  .strict();
export type Money = Readonly<z.infer<typeof MoneySchema>>;
export const ProductConditionSchema = z.enum(["NEW", "REFURBISHED", "USED"]);
export const MerchantRiskSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "EXCESSIVE",
]);
export type MerchantRisk = z.infer<typeof MerchantRiskSchema>;

export const PrincipalSchema = z
  .object({ id: z.string().min(1), displayName: z.string().min(1) })
  .strict();
export type Principal = Readonly<z.infer<typeof PrincipalSchema>>;

export const AgentPassportSchema = z
  .object({
    id: z.string().min(1),
    principalId: z.string().min(1),
    displayName: z.string().min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
    capabilities: z.array(CapabilitySchema).min(1),
  })
  .strict();
export type AgentPassport = Readonly<z.infer<typeof AgentPassportSchema>>;

export const MandateSchema = z
  .object({
    id: z.string().min(1),
    principalId: z.string().min(1),
    authorizedAgentId: z.string().min(1),
    purpose: z.string().min(1),
    category: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    maxSingleTransactionMinor: z.number().int().positive(),
    cumulativeLimitMinor: z.number().int().positive().optional(),
    allowedConditions: z.array(ProductConditionSchema).min(1),
    merchantRiskCeiling: MerchantRiskSchema,
    autonomousPurchaseThresholdMinor: z.number().int().nonnegative(),
    humanApprovalThresholdMinor: z.number().int().positive(),
    allowedCapabilities: z.array(CapabilitySchema).min(1),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    version: z.number().int().positive(),
    nonce: z.string().min(16),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (
      mandate.autonomousPurchaseThresholdMinor >
      mandate.humanApprovalThresholdMinor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "autonomous threshold exceeds human approval threshold",
      });
    }
    if (
      mandate.humanApprovalThresholdMinor > mandate.maxSingleTransactionMinor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human approval threshold exceeds hard maximum",
      });
    }
    if (
      mandate.cumulativeLimitMinor !== undefined &&
      mandate.maxSingleTransactionMinor > mandate.cumulativeLimitMinor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "single maximum exceeds cumulative limit",
      });
    }
  });
export type Mandate = Readonly<z.infer<typeof MandateSchema>>;

export const TransactionProposalSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    mandateId: z.string().min(1),
    mandateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    amount: MoneySchema,
    merchant: z
      .object({ id: z.string().min(1), displayName: z.string().min(1) })
      .strict(),
    category: z.string().min(1),
    condition: ProductConditionSchema,
    requestedCapability: CapabilitySchema,
    proposedAt: z.string().datetime(),
    nonce: z.string().min(16),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type TransactionProposal = Readonly<
  z.infer<typeof TransactionProposalSchema>
>;

export type AuthorizationDecision = "ALLOW" | "DENY" | "ESCALATE";
export type DecisionCode =
  | "ALLOWED"
  | "MALFORMED_INPUT"
  | "MANDATE_EXPIRED"
  | "MANDATE_INVALID"
  | "MANDATE_INTEGRITY_FAILURE"
  | "AGENT_UNAUTHORIZED"
  | "AGENT_EXPIRED"
  | "AGENT_SUSPENDED"
  | "CAPABILITY_DENIED"
  | "AMOUNT_EXCEEDS_LIMIT"
  | "HUMAN_APPROVAL_LIMIT_EXCEEDED"
  | "CUMULATIVE_LIMIT_EXCEEDED"
  | "HUMAN_APPROVAL_REQUIRED"
  | "CURRENCY_MISMATCH"
  | "CATEGORY_DENIED"
  | "CONDITION_DENIED"
  | "MERCHANT_RISK_TOO_HIGH"
  | "REPLAY_DETECTED";
export type CheckResult = "PASS" | "FAIL" | "ESCALATE" | "NOT_EVALUATED";

export interface DecisionReceipt {
  readonly receiptId: string;
  readonly decision: AuthorizationDecision;
  readonly reasonCodes: readonly DecisionCode[];
  readonly mandateId: string;
  readonly mandateFingerprint: string;
  readonly agentId: string;
  readonly proposalId: string;
  readonly amount: Money;
  readonly checks: Readonly<Record<string, CheckResult>>;
  readonly evaluatedAt: string;
  readonly authorizationEngineVersion: string;
}
