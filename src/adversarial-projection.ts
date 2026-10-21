import { z } from "zod";
export const BREAK_PAYFLOW_ATTACKS = Object.freeze([
  "USED_UNDER_NEW",
  "MERCHANT_SUBSTITUTION",
  "SKU_SUBSTITUTION",
  "VARIANT_SUBSTITUTION",
  "PRICE_DRIFT",
  "HIDDEN_CHARGE",
  "STALE_QUOTE",
  "PROMPT_INJECTION",
  "INVENTED_CANDIDATE",
  "AI_AUTHORITY_FIELDS",
  "CREATE_ORDER_ONLY",
  "MANDATE_REVOKED",
  "AGENT_SUSPENDED",
  "GRANT_EXPIRED",
  "RESERVATION_EXPIRED",
  "QUOTE_EXPIRED",
  "BINDING_CHANGED",
  "FORGED_APPROVAL",
  "ORDER_SUBSTITUTION",
  "BROWSER_FINANCIAL_SUBSTITUTION",
  "LOST_CREATE",
  "LOST_CAPTURE",
  "RECIPIENT_MISMATCH",
  "AMOUNT_CURRENCY_MISMATCH",
  "ITEM_MISMATCH",
  "DISCOVERY_CORRUPTION",
  "MANIFEST_CORRUPTION",
  "PROPOSAL_CORRUPTION",
  "GRANT_TAMPERING",
  "CROSS_PRINCIPAL_RESUME",
  "CROSS_ATTEMPT_RESUME",
  "CONCURRENT_EXECUTION",
  "CONCURRENT_RESUME",
  "UNKNOWN_REPLACEMENT",
  "MAPPING_REVISION",
  "DISCOVERY_ONLY_RETAILER",
  "ORPHANED_QUOTE",
] as const);
export const AdversarialResultSchema = z
  .object({
    attackId: z.enum(BREAK_PAYFLOW_ATTACKS),
    title: z.string().max(96),
    threatBoundary: z.string().max(64),
    expectedDefense: z.string().max(128),
    result: z.enum([
      "BLOCKED",
      "DENIED",
      "QUARANTINED",
      "RECONCILED",
      "NOT_APPLICABLE",
    ]),
    stoppedAt: z.string().max(64),
    financialSideEffect: z.boolean(),
    providerCreateCalls: z.number().int().nonnegative().max(100),
    providerCaptureCalls: z.number().int().nonnegative().max(100),
    traceStatus: z.enum([
      "VERIFIED",
      "INCOMPLETE",
      "INVALID",
      "UNKNOWN_FINANCIAL_OUTCOME",
      "LEGACY",
    ]),
    reasonCode: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(96),
  })
  .strict();
export type AdversarialResult = z.infer<typeof AdversarialResultSchema>;
const explanations: Readonly<Record<string, string>> = {
  CONDITION_NOT_ALLOWED:
    "Blocked: the offer is USED while the mandate permits NEW only.",
  COMMERCE_CANDIDATE_NOT_IN_REQUEST:
    "Blocked: the model returned a candidate outside this discovery request.",
  AMOUNT_EXCEEDS_LIMIT:
    "Denied: the trusted checkout total exceeds the mandate transaction limit.",
  CURRENT_AUTHORITY_WITHHOLDS_CAPTURE:
    "Capture withheld: current PayFlow authority does not permit a new dispatch.",
  COMMERCE_PROVIDER_MISMATCH:
    "Quarantined: provider observations conflict with immutable commerce terms.",
  CAPTURE_RECONCILED:
    "Recovered: the original capture was observed and committed without another capture.",
  DISCOVERY_QUOTE_LINK_MISSING:
    "Incomplete: no immutable discovery-to-quote relationship exists.",
};
export function securityExplanation(code: string): string {
  return (
    explanations[code] ??
    "PayFlow retained the durable operation and failed closed at the recorded boundary."
  );
}
/** The runner must exercise the actual composed system and measure provider calls.
 * This projection reports that execution; it never authorizes or simulates defenses. */
export async function runBreakPayFlow(
  attackId: AdversarialResult["attackId"],
  runner: () => Promise<Omit<AdversarialResult, "attackId" | "title">>,
): Promise<AdversarialResult> {
  if (!BREAK_PAYFLOW_ATTACKS.includes(attackId))
    throw new Error("ATTACK_NOT_SUPPORTED");
  const observed = await runner();
  const result = AdversarialResultSchema.parse({
    attackId,
    title: attackId.replaceAll("_", " "),
    ...observed,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 2048)
    throw new Error("ATTACK_RESULT_LIMIT");
  return result;
}
