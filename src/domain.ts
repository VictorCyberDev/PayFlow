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
    minor: z.number().int().safe().nonnegative(),
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

// Exact case-sensitive logical merchant identifiers; never display-name folding.
export const MerchantScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ANY") }).strict(),
  z
    .object({
      mode: z.literal("ONLY"),
      ids: z
        .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))
        .min(1)
        .max(100),
    })
    .strict(),
]);
export const MandateSchema = z
  .object({
    id: z.string().min(1),
    principalId: z.string().min(1),
    authorizedAgentId: z.string().min(1),
    purpose: z.string().min(1),
    category: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    maxSingleTransactionMinor: z.number().int().safe().positive(),
    cumulativeLimitMinor: z.number().int().safe().positive().optional(),
    quantityLimit: z.number().int().safe().positive().max(1000).optional(),
    merchantScope: MerchantScopeSchema.optional(),
    allowedConditions: z.array(ProductConditionSchema).min(1),
    merchantRiskCeiling: MerchantRiskSchema,
    autonomousPurchaseThresholdMinor: z.number().int().safe().nonnegative(),
    humanApprovalThresholdMinor: z.number().int().safe().positive(),
    allowedCapabilities: z.array(CapabilitySchema).min(1),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    version: z.number().int().safe().positive(),
    nonce: z.string().min(16),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (
      mandate.autonomousPurchaseThresholdMinor >
      mandate.humanApprovalThresholdMinor
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "autonomous threshold exceeds human approval threshold",
      });
    if (mandate.humanApprovalThresholdMinor > mandate.maxSingleTransactionMinor)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human approval threshold exceeds hard maximum",
      });
    if (
      mandate.cumulativeLimitMinor !== undefined &&
      mandate.maxSingleTransactionMinor > mandate.cumulativeLimitMinor
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "single maximum exceeds cumulative limit",
      });
  });
export type Mandate = Readonly<z.infer<typeof MandateSchema>>;

export const TransactionProposalSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    mandateId: z.string().min(1),
    mandateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    amount: MoneySchema,
    quantity: z.number().int().safe().positive().max(1000).optional(),
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

export const AuthorizationDecisionSchema = z.enum([
  "ALLOW",
  "DENY",
  "ESCALATE",
]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
export const DecisionCodeSchema = z.enum([
  "ALLOWED",
  "MALFORMED_INPUT",
  "MANDATE_EXPIRED",
  "MANDATE_INVALID",
  "MANDATE_INTEGRITY_FAILURE",
  "AGENT_UNAUTHORIZED",
  "AGENT_EXPIRED",
  "AGENT_SUSPENDED",
  "CAPABILITY_DENIED",
  "AMOUNT_EXCEEDS_LIMIT",
  "HUMAN_APPROVAL_LIMIT_EXCEEDED",
  "CUMULATIVE_LIMIT_EXCEEDED",
  "HUMAN_APPROVAL_REQUIRED",
  "CURRENCY_MISMATCH",
  "CATEGORY_DENIED",
  "CONDITION_DENIED",
  "MERCHANT_RISK_TOO_HIGH",
  "REPLAY_DETECTED",
  "QUANTITY_EXHAUSTED",
  "MERCHANT_NOT_ALLOWED",
]);
export type DecisionCode = z.infer<typeof DecisionCodeSchema>;
export const CheckResultSchema = z.enum([
  "PASS",
  "FAIL",
  "ESCALATE",
  "NOT_EVALUATED",
]);
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const DecisionReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    decision: AuthorizationDecisionSchema,
    reasonCodes: z.array(DecisionCodeSchema).min(1),
    mandateId: z.string().min(1),
    mandateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    agentId: z.string().min(1),
    proposalId: z.string().min(1),
    amount: MoneySchema,
    checks: z.record(z.string(), CheckResultSchema),
    evaluatedAt: z.string().datetime(),
    authorizationEngineVersion: z.string().min(1),
  })
  .strict();
export type DecisionReceipt = Readonly<z.infer<typeof DecisionReceiptSchema>>;
