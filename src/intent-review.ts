import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  interpretIntent,
  INTENT_MODEL_LIMITS,
  type IntentModelProvider,
} from "./intent-model.js";
import {
  IntentCompileContextSchema,
  type IntentCompileContext,
} from "./intent.js";

const text = z.string().min(1).max(2000);
const term = z
  .object({ label: z.string().min(1).max(80), value: text })
  .strict();
export const IntentReviewSchema = z
  .object({
    version: z.literal("payflow.intent-review.v1"),
    authority: z.literal("NOT_YET_AUTHORIZED"),
    source: text,
    interpretationStatus: z.enum(["INTERPRETED", "UNAVAILABLE"]),
    status: z.enum([
      "VALID_DRAFT",
      "NEEDS_CLARIFICATION",
      "REJECTED",
      "SAFE_PROVIDER_FAILURE",
    ]),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    interpreted: z.array(term).max(8),
    terms: z.array(term).max(8),
    message: z.string().min(1).max(500),
    question: z.string().max(500).nullable(),
    reasonCodes: z
      .array(
        z
          .string()
          .regex(/^[A-Z_a-z:]+$/)
          .max(120),
      )
      .max(100),
    provenance: z
      .object({
        mode: z.literal("NON_PRODUCTION_REVIEW"),
        instructionVersion: z.string().max(80),
        sourceReference: z.string().max(200),
      })
      .strict(),
    reviewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type IntentReview = z.infer<typeof IntentReviewSchema>;
/** No identity, activation, persistence, provider blobs or financial capabilities. */
export class IntentReviewService {
  constructor(
    private readonly provider: IntentModelProvider,
    private readonly trustedIntake: (
      now: Date,
    ) => IntentCompileContext["reviewBounds"],
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async review(raw: unknown): Promise<IntentReview | null> {
    const request = z
      .object({ source: text.refine((s) => s.trim().length > 0) })
      .strict()
      .safeParse(raw);
    if (
      !request.success ||
      Buffer.byteLength(request.data.source) > INTENT_MODEL_LIMITS.sourceBytes
    )
      return null;
    const now = this.clock();
    const context = IntentCompileContextSchema.parse({
      source: { reference: randomUUID(), text: request.data.source },
      now: now.toISOString(),
      reviewBounds: this.trustedIntake(now),
    });
    const base: IntentReview = {
      version: "payflow.intent-review.v1",
      authority: "NOT_YET_AUTHORIZED",
      source: request.data.source,
      interpretationStatus: "UNAVAILABLE",
      status: "SAFE_PROVIDER_FAILURE",
      fingerprint: null,
      interpreted: [],
      terms: [],
      message:
        "Interpretation is unavailable. Nothing was authorized. Please try again.",
      question: null,
      reasonCodes: [],
      provenance: {
        mode: "NON_PRODUCTION_REVIEW",
        instructionVersion: "unavailable",
        sourceReference: context.source.reference,
      },
      reviewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300000).toISOString(),
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const failure = { status: "MODEL_TIMEOUT" as const };
      const result = await Promise.race([
        interpretIntent(this.provider, context, controller.signal),
        new Promise<typeof failure>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(failure);
          }, INTENT_MODEL_LIMITS.timeoutMs);
        }),
      ]);
      if (result.status !== "INTERPRETED")
        return IntentReviewSchema.parse({
          ...base,
          reasonCodes: [result.status],
        });
      const c = result.compilation;
      const review = {
        ...base,
        interpretationStatus: "INTERPRETED" as const,
        status: c.status,
        provenance: {
          ...base.provenance,
          instructionVersion: result.diagnostic.instructionVersion,
        },
      };
      if (c.status !== "VALID_DRAFT")
        return IntentReviewSchema.parse({
          ...review,
          message:
            c.status === "NEEDS_CLARIFICATION"
              ? "A few terms need clarification. Nothing is authorized."
              : "I can’t turn that into a safe authority yet. Please revise the request; some terms are unsupported or conflict with the demo limits.",
          question:
            c.status === "NEEDS_CLARIFICATION"
              ? (result.questions[0] ??
                "Please clarify the proposed permissions.")
              : null,
          reasonCodes: [...c.issues],
        });
      const d = c.draft,
        t = d.proposedMandateTerms;
      const money = (n: number) =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: t.currency,
        }).format(n / (t.currency === "JPY" ? 1 : 100));
      const max = d.provenance.interpretation.constraints.maximum;
      const interpreted = [
        { label: "Item", value: d.item },
        { label: "Quantity", value: String(d.quantity) },
        {
          label: "Budget",
          value:
            max.state === "EXPLICIT"
              ? `${max.value.bound === "EXCLUSIVE" ? "Below" : "At most"} ${max.value.decimal} ${t.currency}`
              : money(t.maxSingleTransactionMinor),
        },
      ];
      const terms = [
        { label: "Item", value: `${d.quantity} × ${d.item}` },
        { label: "Maximum total", value: money(t.maxSingleTransactionMinor) },
        {
          label: "Condition",
          value: t.allowedConditions
            .map(
              (v) =>
                ({ NEW: "New", USED: "Used", REFURBISHED: "Refurbished" })[v],
            )
            .join(", "),
        },
        {
          label: "Merchants",
          value:
            d.merchants.mode === "ONLY"
              ? `Only ${d.merchants.ids.join(", ")}`
              : "Any merchant, subject to existing policy",
        },
        { label: "Expires", value: t.expiresAt },
        {
          label: "Proposed capabilities",
          value: t.allowedCapabilities
            .map(
              (v) =>
                ({
                  SEARCH_PRODUCTS: "Find products",
                  EVALUATE_PRODUCTS: "Compare products",
                  CREATE_ORDER: "Create purchase order",
                  CAPTURE_PAYMENT: "Pay for a purchase",
                  REQUEST_REFUND: "Request refund",
                  CREATE_SUBSCRIPTION: "Create subscription",
                  OPEN_DISPUTE: "Open dispute",
                })[v],
            )
            .join(", "),
        },
        {
          label: "After future activation",
          value:
            t.autonomousPurchaseThresholdMinor > 0
              ? "Agent could complete within these limits without asking again"
              : "Approval would be required before payment",
        },
      ];
      return IntentReviewSchema.parse({
        ...review,
        message:
          "Nothing is authorized yet. You’ll confirm exact terms before this agent receives spending authority. Authenticated activation is not connected.",
        fingerprint: d.fingerprint,
        interpreted,
        terms,
        expiresAt: new Date(
          Math.min(Date.parse(base.expiresAt), Date.parse(t.expiresAt)),
        ).toISOString(),
      });
    } catch {
      return IntentReviewSchema.parse(base);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
