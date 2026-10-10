import { createHash } from "node:crypto";
import { z } from "zod";
import { CapabilitySchema, ProductConditionSchema } from "./domain.js";

const text = z.string().min(1).max(2000);
const instant = z
  .string()
  .datetime({ precision: 3 })
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "invalid calendar instant",
  );
const evidence = z
  .object({
    start: z.number().int().safe().nonnegative(),
    end: z.number().int().safe().positive(),
    quote: text,
  })
  .strict();
function constraint<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("EXPLICIT"),
        value,
        evidence: z.array(evidence).min(1).max(20),
      })
      .strict(),
    z
      .object({ state: z.literal("PROPOSED"), value, explanation: text })
      .strict(),
    z.object({ state: z.literal("MISSING"), reason: text }).strict(),
    z
      .object({
        state: z.literal("AMBIGUOUS"),
        candidates: z.array(value).min(1).max(20),
        reason: text,
      })
      .strict(),
  ]);
}
const amount = z
  .object({
    decimal: z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/),
    bound: z.enum(["INCLUSIVE", "EXCLUSIVE"]),
  })
  .strict();
const currency = z.enum(["USD", "EUR", "GBP", "AUD", "CAD", "JPY"]);
const merchant = z.discriminatedUnion("mode", [
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
const fields = {
  item: constraint(text),
  category: constraint(text),
  maximum: constraint(amount),
  currency: constraint(currency),
  conditions: constraint(z.array(ProductConditionSchema).min(1).max(3)),
  merchants: constraint(merchant),
  quantity: constraint(z.number().int().safe().positive().max(1000)),
  autonomousPurchase: constraint(z.boolean()),
  confirmationRequired: constraint(z.boolean()),
  expiresAt: constraint(instant),
  capabilities: constraint(z.array(CapabilitySchema).min(1).max(7)),
};
export const IntentFieldSchema = z.enum([
  "item",
  "category",
  "maximum",
  "currency",
  "conditions",
  "merchants",
  "quantity",
  "autonomousPurchase",
  "confirmationRequired",
  "expiresAt",
  "capabilities",
]);
export const IntentInterpretationSchema = z
  .object({
    version: z.literal("payflow.intent.v1"),
    sourceReference: z.string().min(1).max(200),
    constraints: z.object(fields).strict(),
    ambiguities: z
      .array(z.object({ field: IntentFieldSchema, description: text }).strict())
      .max(100),
    assumptions: z
      .array(z.object({ field: IntentFieldSchema, description: text }).strict())
      .max(100),
    unsupportedConstraints: z
      .array(z.object({ description: text }).strict())
      .max(100),
  })
  .strict();
export type IntentInterpretation = z.infer<typeof IntentInterpretationSchema>;

// Independently supplied structured review bounds, never extracted/trusted from
// the model object. These are restrictions, NOT an authorization credential.
export const IntentCompileContextSchema = z
  .object({
    source: z
      .object({
        reference: z.string().min(1).max(200),
        text: z.string().min(1).max(20000),
      })
      .strict(),
    now: instant,
    reviewBounds: z
      .object({
        maximumMinor: z.number().int().safe().positive().optional(),
        currency: currency.optional(),
        quantity: z.number().int().safe().positive().max(1000).optional(),
        conditions: z.array(ProductConditionSchema).min(1).optional(),
        merchantIds: z.array(z.string().min(1)).min(1).optional(),
        autonomousPurchase: z.boolean().optional(),
        confirmationRequired: z.boolean().optional(),
        capabilities: z.array(CapabilitySchema).min(1).optional(),
        expiresAt: instant.optional(),
      })
      .strict(),
  })
  .strict();
export type IntentCompileContext = z.infer<typeof IntentCompileContextSchema>;

/** Exact decimal conversion; Number is used only after the BigInt safe-range check. */
export function intentMinorUnits(
  decimal: string,
  code: z.infer<typeof currency>,
): number {
  amount.shape.decimal.parse(decimal);
  currency.parse(code);
  const precision = code === "JPY" ? 0 : 2;
  const [whole, fraction = ""] = decimal.split(".");
  if (fraction.length > precision) throw new Error("INVALID_MONEY_PRECISION");
  const minor =
    BigInt(whole!) * 10n ** BigInt(precision) +
    BigInt(fraction.padEnd(precision, "0") || "0");
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("INVALID_MONEY_RANGE");
  return Number(minor);
}
function sorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface MandateDraft {
  readonly kind: "UNTRUSTED_MANDATE_DRAFT";
  readonly version: "payflow.mandate-draft.v1";
  readonly humanConfirmationRequired: true;
  readonly item: string;
  readonly quantity: number;
  readonly merchants: z.infer<typeof merchant>;
  // No principal/agent identity, mandate ID, nonce, signature or activation API.
  readonly proposedMandateTerms: {
    readonly purpose: string;
    readonly category: string;
    readonly currency: z.infer<typeof currency>;
    readonly maxSingleTransactionMinor: number;
    readonly cumulativeLimitMinor: number;
    readonly allowedConditions: readonly z.infer<
      typeof ProductConditionSchema
    >[];
    readonly autonomousPurchaseThresholdMinor: number;
    readonly humanApprovalThresholdMinor: number;
    readonly allowedCapabilities: readonly z.infer<typeof CapabilitySchema>[];
    readonly expiresAt: string;
  };
  readonly activationRequirements: readonly string[];
  readonly provenance: {
    readonly source: IntentCompileContext["source"];
    readonly interpretation: IntentInterpretation;
    readonly normalizations: readonly string[];
  };
  readonly fingerprint: string;
}
export type IntentCompileResult =
  | { readonly status: "VALID_DRAFT"; readonly draft: MandateDraft }
  | {
      readonly status: "NEEDS_CLARIFICATION";
      readonly issues: readonly string[];
      readonly interpretation: IntentInterpretation;
    }
  | { readonly status: "REJECTED"; readonly issues: readonly string[] };
const commerceCapabilities = new Set([
  "SEARCH_PRODUCTS",
  "EVALUATE_PRODUCTS",
  "CREATE_ORDER",
  "CAPTURE_PAYMENT",
]);

/** Pure compilation: no repository, grant issuer, policy decision or provider capability. */
export function compileIntentDraft(
  raw: unknown,
  rawContext: unknown,
): IntentCompileResult {
  const parsed = IntentInterpretationSchema.safeParse(raw);
  const contextResult = IntentCompileContextSchema.safeParse(rawContext);
  if (!parsed.success || !contextResult.success)
    return freeze({
      status: "REJECTED",
      issues: ["MALFORMED_INTERPRETATION_OR_CONTEXT"],
    });
  const interpretation = parsed.data,
    context = contextResult.data;
  if (interpretation.sourceReference !== context.source.reference)
    return freeze({
      status: "REJECTED",
      issues: ["SOURCE_REFERENCE_MISMATCH"],
    });
  const c = interpretation.constraints;
  const issues: string[] = [];
  for (const [name, value] of Object.entries(c)) {
    if (value.state !== "EXPLICIT") issues.push(`${name}:${value.state}`);
    else
      for (const span of value.evidence) {
        if (
          span.end <= span.start ||
          context.source.text.slice(span.start, span.end) !== span.quote ||
          span.end > context.source.text.length
        )
          return freeze({
            status: "REJECTED",
            issues: ["SOURCE_SPAN_MISMATCH"],
          });
      }
  }
  if (interpretation.unsupportedConstraints.length)
    return freeze({ status: "REJECTED", issues: ["UNSUPPORTED_CONSTRAINTS"] });
  for (const a of interpretation.assumptions)
    issues.push(`${a.field}:ASSUMPTION`);
  for (const a of interpretation.ambiguities)
    issues.push(`${a.field}:AMBIGUITY`);
  if (issues.length)
    return freeze({
      status: "NEEDS_CLARIFICATION",
      issues: sorted(issues),
      interpretation,
    });
  // Narrow every discriminant explicitly; no inferred/missing value can reach a draft.
  if (
    c.item.state !== "EXPLICIT" ||
    c.category.state !== "EXPLICIT" ||
    c.maximum.state !== "EXPLICIT" ||
    c.currency.state !== "EXPLICIT" ||
    c.conditions.state !== "EXPLICIT" ||
    c.merchants.state !== "EXPLICIT" ||
    c.quantity.state !== "EXPLICIT" ||
    c.autonomousPurchase.state !== "EXPLICIT" ||
    c.confirmationRequired.state !== "EXPLICIT" ||
    c.expiresAt.state !== "EXPLICIT" ||
    c.capabilities.state !== "EXPLICIT"
  )
    throw new Error("UNREACHABLE_NONEXPLICIT_CONSTRAINT");
  let maximum: number;
  try {
    maximum =
      intentMinorUnits(c.maximum.value.decimal, c.currency.value) -
      (c.maximum.value.bound === "EXCLUSIVE" ? 1 : 0);
    if (maximum <= 0) throw new Error("EMPTY_BUDGET");
  } catch {
    return freeze({ status: "REJECTED", issues: ["INVALID_MONEY"] });
  }
  const conditions = sorted(c.conditions.value),
    capabilities = sorted(c.capabilities.value);
  if (capabilities.some((cap) => !commerceCapabilities.has(cap)))
    return freeze({ status: "REJECTED", issues: ["UNSUPPORTED_CAPABILITY"] });
  if (
    capabilities.includes("CAPTURE_PAYMENT") &&
    !capabilities.includes("CREATE_ORDER")
  )
    return freeze({
      status: "REJECTED",
      issues: ["INCOMPATIBLE_CAPABILITIES"],
    });
  if (
    c.autonomousPurchase.value &&
    (!capabilities.includes("CREATE_ORDER") ||
      !capabilities.includes("CAPTURE_PAYMENT"))
  )
    return freeze({
      status: "REJECTED",
      issues: ["INCOMPATIBLE_CAPABILITIES"],
    });
  if (
    !c.autonomousPurchase.value &&
    !c.confirmationRequired.value &&
    capabilities.some(
      (cap) => cap === "CREATE_ORDER" || cap === "CAPTURE_PAYMENT",
    )
  )
    return freeze({
      status: "NEEDS_CLARIFICATION",
      issues: ["PURCHASE_PERMISSION_MISSING"],
      interpretation,
    });
  if (c.autonomousPurchase.value && c.confirmationRequired.value)
    return freeze({
      status: "REJECTED",
      issues: ["CONTRADICTORY_CONFIRMATION"],
    });
  if (
    !Number.isFinite(Date.parse(c.expiresAt.value)) ||
    Date.parse(c.expiresAt.value) <= Date.parse(context.now)
  )
    return freeze({ status: "REJECTED", issues: ["INVALID_EXPIRY"] });
  const b = context.reviewBounds;
  const m = c.merchants.value;
  if (
    (b.maximumMinor !== undefined && maximum > b.maximumMinor) ||
    (b.currency !== undefined && c.currency.value !== b.currency) ||
    (b.quantity !== undefined && c.quantity.value > b.quantity) ||
    (b.conditions &&
      conditions.some((condition) => !b.conditions!.includes(condition))) ||
    (b.merchantIds &&
      (m.mode !== "ONLY" ||
        m.ids.some((id) => !b.merchantIds!.includes(id)))) ||
    (b.autonomousPurchase === false && c.autonomousPurchase.value) ||
    (b.confirmationRequired === true && !c.confirmationRequired.value) ||
    (b.capabilities &&
      capabilities.some((cap) => !b.capabilities!.includes(cap))) ||
    (b.expiresAt && Date.parse(c.expiresAt.value) > Date.parse(b.expiresAt))
  )
    return freeze({ status: "REJECTED", issues: ["AUTHORITY_WIDENING"] });
  const item = c.item.value.trim().normalize("NFC"),
    category = c.category.value.trim().normalize("NFC");
  if (!item || !category)
    return freeze({ status: "REJECTED", issues: ["EMPTY_ITEM_OR_CATEGORY"] });
  const draftWithoutHash = {
    kind: "UNTRUSTED_MANDATE_DRAFT" as const,
    version: "payflow.mandate-draft.v1" as const,
    humanConfirmationRequired: true as const,
    item,
    quantity: c.quantity.value,
    merchants:
      m.mode === "ANY" ? m : { mode: "ONLY" as const, ids: sorted(m.ids) },
    proposedMandateTerms: {
      purpose: item,
      category,
      currency: c.currency.value,
      maxSingleTransactionMinor: maximum,
      cumulativeLimitMinor: maximum,
      allowedConditions: conditions,
      autonomousPurchaseThresholdMinor:
        c.autonomousPurchase.value && !c.confirmationRequired.value
          ? maximum
          : 0,
      humanApprovalThresholdMinor: maximum,
      allowedCapabilities: capabilities,
      expiresAt: new Date(c.expiresAt.value).toISOString(),
    },
    activationRequirements: [
      "AUTHENTICATED_HUMAN_CONFIRMATION",
      "TRUSTED_PRINCIPAL_AGENT_AND_RISK_POLICY",
      "QUANTITY_ENFORCEMENT",
      ...(m.mode === "ONLY" ? ["MERCHANT_ALLOWLIST_ENFORCEMENT"] : []),
    ],
    provenance: {
      source: context.source,
      interpretation,
      normalizations: [
        "DECIMAL_TO_MINOR_UNITS",
        "TOTAL_BUDGET_NO_LARGER_THAN_SINGLE_MAXIMUM",
        "CANONICAL_SETS_AND_TEXT",
        ...(c.maximum.value.bound === "EXCLUSIVE"
          ? ["EXCLUSIVE_MAXIMUM_MINUS_ONE_MINOR_UNIT"]
          : []),
      ],
    },
  };
  const fingerprint = createHash("sha256")
    .update(canonical(draftWithoutHash))
    .digest("hex");
  return freeze({
    status: "VALID_DRAFT",
    draft: { ...draftWithoutHash, fingerprint },
  });
}
