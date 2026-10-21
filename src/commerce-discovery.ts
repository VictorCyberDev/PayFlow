import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CommerceConditionSchema,
  CommerceMoneySchema,
  DEMO_MERCHANT_ID,
  DEMO_MERCHANT_NAME,
  KeyboardVariantSchema,
} from "./commerce.js";
import type {
  FakeControlledCommerceSource,
  ControlledOffer,
} from "./controlled-commerce.js";
import { MandateSchema, type Mandate } from "./domain.js";

export const DISCOVERY_LIMITS = Object.freeze({
  providers: 4,
  offersPerProvider: 20,
  candidates: 20,
  responseBytes: 65536,
  textBytes: 16384,
  provenanceBytes: 4096,
  references: 40,
  rankingInputBytes: 65536,
  rankingBytes: 2048,
  explanation: 512,
  timeoutMs: 2000,
  observationAgeMs: 300000,
});
const identifier = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const text = z.string().min(1).max(160);
const url = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  });
const claimVariant = z
  .object({
    switchType: z.string().min(1).max(32).nullable(),
    finish: z.string().min(1).max(32).nullable(),
    layout: z.string().min(1).max(32).nullable(),
  })
  .strict();
const rawOffer = z
  .object({
    offerId: identifier,
    productFamilyId: identifier.nullable().optional(),
    merchantClaim: z.object({ id: identifier, displayName: text }).strict(),
    title: text,
    snippet: z.string().max(512).optional(),
    categoryClaim: z.string().min(1).max(32).nullable().optional(),
    conditionClaim: z.string().min(1).max(64).nullable().optional(),
    variantClaims: claimVariant.optional(),
    skuClaim: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .nullable()
      .optional(),
    priceObservation: CommerceMoneySchema.nullable().optional(),
    availableQuantity: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(100000)
      .nullable()
      .optional(),
    productUrl: url.nullable().optional(),
    imageUrl: url.nullable().optional(),
    provenance: z.string().min(1).max(200).nullable().optional(),
    observedAt: z.string().datetime(),
  })
  .strict();
export const NormalizedDiscoveryOfferSchema = rawOffer
  .extend({
    version: z.literal("payflow.normalized-discovery.v1"),
    trust: z.literal("UNTRUSTED_DISCOVERY"),
    providerId: identifier,
    condition: CommerceConditionSchema,
    productFamilyId: identifier.nullable(),
    categoryClaim: rawOffer.shape.categoryClaim.unwrap(),
    conditionClaim: rawOffer.shape.conditionClaim.unwrap(),
    variantClaims: claimVariant,
    skuClaim: rawOffer.shape.skuClaim.unwrap(),
    priceObservation: CommerceMoneySchema.nullable(),
    availableQuantity: rawOffer.shape.availableQuantity.unwrap(),
    productUrl: url.nullable(),
    imageUrl: url.nullable(),
    provenance: rawOffer.shape.provenance.unwrap(),
  })
  .strict()
  .refine(
    (o) =>
      o.condition ===
      (CommerceConditionSchema.safeParse(o.conditionClaim).success
        ? o.conditionClaim
        : "UNKNOWN"),
    "CONDITION_NORMALIZATION_INVALID",
  );
export type NormalizedDiscoveryOffer = Readonly<
  z.infer<typeof NormalizedDiscoveryOfferSchema>
>;
export const DiscoveryQuerySchema = z
  .object({
    text: z.string().min(1).max(512),
    quantity: z.number().int().safe().positive().max(1000),
    requiredVariant: KeyboardVariantSchema.optional(),
  })
  .strict();
export type DiscoveryQuery = Readonly<z.infer<typeof DiscoveryQuerySchema>>;
export function discoveryFingerprint(offer: NormalizedDiscoveryOffer): string {
  return createHash("sha256")
    .update("payflow:discovery-observation:v1\n")
    .update(JSON.stringify(NormalizedDiscoveryOfferSchema.parse(offer)))
    .digest("hex");
}
export function freezeDiscovery(
  offer: NormalizedDiscoveryOffer,
): NormalizedDiscoveryOffer {
  Object.freeze(offer.merchantClaim);
  Object.freeze(offer.variantClaims);
  if (offer.priceObservation) Object.freeze(offer.priceObservation);
  return Object.freeze(offer);
}
export function normalizeDiscoveryOffer(
  providerId: string,
  raw: unknown,
): NormalizedDiscoveryOffer {
  identifier.parse(providerId);
  const o = rawOffer.parse(raw);
  const condition = CommerceConditionSchema.safeParse(o.conditionClaim);
  return freezeDiscovery(
    NormalizedDiscoveryOfferSchema.parse({
      ...o,
      version: "payflow.normalized-discovery.v1",
      trust: "UNTRUSTED_DISCOVERY",
      providerId,
      productFamilyId: o.productFamilyId ?? null,
      categoryClaim: o.categoryClaim ?? null,
      conditionClaim: o.conditionClaim ?? null,
      condition: condition.success ? condition.data : "UNKNOWN",
      variantClaims: o.variantClaims ?? {
        switchType: null,
        finish: null,
        layout: null,
      },
      skuClaim: o.skuClaim ?? null,
      priceObservation: o.priceObservation ?? null,
      availableQuantity: o.availableQuantity ?? null,
      productUrl: o.productUrl ?? null,
      imageUrl: o.imageUrl ?? null,
      provenance: o.provenance ?? null,
    }),
  );
}
export interface CommerceDiscoveryProvider {
  readonly providerId: string;
  /** Adapters must bound transport bytes BEFORE decoding. Output remains untrusted. */
  discover(query: DiscoveryQuery, signal: AbortSignal): Promise<unknown>;
}
export class FakeDiscoveryProvider implements CommerceDiscoveryProvider {
  constructor(
    readonly providerId: string,
    private readonly observations: readonly unknown[],
  ) {
    identifier.parse(providerId);
  }
  discover(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.observations));
  }
}
export const mappingSchema = z
  .object({
    mappingId: identifier,
    revision: z.number().int().positive().max(1000000),
    providerId: identifier,
    offerId: identifier,
    productFamilyId: identifier,
    merchantClaimId: z.literal(DEMO_MERCHANT_ID),
    controlledOfferId: identifier,
    sku: z.string().min(1).max(64),
    variant: KeyboardVariantSchema,
    condition: z.enum(["NEW", "USED", "REFURBISHED"]),
  })
  .strict();
export type DiscoveryMapping = Readonly<z.infer<typeof mappingSchema>>;
export type ControlledResolution =
  | {
      status: "SUPPORTED_CHECKOUT";
      offer: ControlledOffer;
      mappingFingerprint: string;
      mappingId: string;
      mappingRevision: number;
      merchantId: string;
    }
  | {
      status: "DISCOVERY_ONLY";
      reason: "CHECKOUT_NOT_SUPPORTED" | "RELATIONSHIP_MISMATCH";
    };
/** Operator-only mapping, NEVER constructed from requests/provider/model output.
 * This milestone supports only explicitly named Demo Merchant observations. */
export class ControlledDiscoveryResolver {
  readonly #mappings = new Map<string, DiscoveryMapping>();
  constructor(
    private readonly source: FakeControlledCommerceSource,
    operatorMappings: readonly unknown[],
  ) {
    if (operatorMappings.length > 20)
      throw new Error("DISCOVERY_MAPPING_LIMIT");
    for (const raw of operatorMappings) {
      const m = mappingSchema.parse(raw),
        key = JSON.stringify([m.providerId, m.offerId]);
      if (this.#mappings.has(key))
        throw new Error("DISCOVERY_MAPPING_DUPLICATE");
      Object.freeze(m.variant);
      this.#mappings.set(key, Object.freeze(m));
    }
  }
  inspect(o: NormalizedDiscoveryOffer):
    | {
        status: "SUPPORTED_CHECKOUT";
        merchantId: string;
        mappingFingerprint: string;
        mapping: DiscoveryMapping;
      }
    | { status: "DISCOVERY_ONLY" } {
    const m = this.#mappings.get(JSON.stringify([o.providerId, o.offerId]));
    return m &&
      o.merchantClaim.id === m.merchantClaimId &&
      o.merchantClaim.displayName === DEMO_MERCHANT_NAME &&
      o.productFamilyId === m.productFamilyId &&
      o.condition === m.condition &&
      o.categoryClaim === "KEYBOARD" &&
      (o.skuClaim === null || o.skuClaim === m.sku) &&
      JSON.stringify(o.variantClaims) === JSON.stringify(m.variant)
      ? {
          status: "SUPPORTED_CHECKOUT",
          merchantId: DEMO_MERCHANT_ID,
          mapping: m,
          mappingFingerprint: createHash("sha256")
            .update("payflow:discovery-mapping:v1\n" + JSON.stringify(m))
            .digest("hex"),
        }
      : { status: "DISCOVERY_ONLY" };
  }
  resolve(o: NormalizedDiscoveryOffer): ControlledResolution {
    const m = this.#mappings.get(JSON.stringify([o.providerId, o.offerId]));
    if (!m)
      return { status: "DISCOVERY_ONLY", reason: "CHECKOUT_NOT_SUPPORTED" };
    const offer = this.source.getControlledOffer(m.controlledOfferId);
    if (
      !offer ||
      this.source.resolveCheckoutSupport(offer).status !==
        "SUPPORTED_CHECKOUT" ||
      o.merchantClaim.id !== m.merchantClaimId ||
      o.merchantClaim.displayName !== DEMO_MERCHANT_NAME ||
      o.productFamilyId !== m.productFamilyId ||
      o.condition !== m.condition ||
      o.categoryClaim !== "KEYBOARD" ||
      (o.skuClaim !== null && o.skuClaim !== m.sku) ||
      JSON.stringify(o.variantClaims) !== JSON.stringify(m.variant) ||
      offer.sku !== m.sku ||
      offer.productFamilyId !== m.productFamilyId ||
      offer.condition !== m.condition ||
      JSON.stringify(offer.variant) !== JSON.stringify(m.variant)
    )
      return { status: "DISCOVERY_ONLY", reason: "RELATIONSHIP_MISMATCH" };
    return {
      status: "SUPPORTED_CHECKOUT",
      offer,
      mappingId: m.mappingId,
      mappingRevision: m.revision,
      merchantId: DEMO_MERCHANT_ID,
      mappingFingerprint: createHash("sha256")
        .update("payflow:discovery-mapping:v1\n" + JSON.stringify(m))
        .digest("hex"),
    };
  }
}
export type DiscoveryEligibility = {
  status: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  reason: string;
};
/** Preliminary offer filtering only. This function cannot authorize/reserve/pay. */
export function discoveryEligibility(
  o: NormalizedDiscoveryOffer,
  m: Mandate,
  q: DiscoveryQuery,
  resolution: ReturnType<ControlledDiscoveryResolver["inspect"]>,
  mode: "EXECUTABLE" | "RECOMMENDATION",
  now: string,
): DiscoveryEligibility {
  const fail = (
    reason: string,
    status: DiscoveryEligibility["status"] = "INELIGIBLE",
  ): DiscoveryEligibility => ({ status, reason });
  if (
    Date.parse(o.observedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(o.observedAt) >=
      DISCOVERY_LIMITS.observationAgeMs
  )
    return fail("OBSERVATION_STALE", "UNKNOWN");
  if (o.condition === "UNKNOWN") return fail("CONDITION_UNKNOWN", "UNKNOWN");
  if (!m.allowedConditions.some((c) => c === o.condition))
    return fail("CONDITION_NOT_ALLOWED");
  if (o.categoryClaim === null) return fail("CATEGORY_UNKNOWN", "UNKNOWN");
  if (o.categoryClaim !== m.category) return fail("CATEGORY_NOT_ALLOWED");
  if (!o.priceObservation) return fail("PRICE_UNKNOWN", "UNKNOWN");
  if (o.priceObservation.currency !== m.currency)
    return fail("CURRENCY_NOT_ALLOWED");
  if (
    BigInt(o.priceObservation.minor) * BigInt(q.quantity) >
    BigInt(m.maxSingleTransactionMinor)
  )
    return fail("PRICE_OBSERVATION_OVER_LIMIT");
  if (o.availableQuantity === null)
    return fail("AVAILABILITY_UNKNOWN", "UNKNOWN");
  if (
    o.availableQuantity < q.quantity ||
    (m.quantityLimit !== undefined && q.quantity > m.quantityLimit)
  )
    return fail("QUANTITY_UNAVAILABLE");
  if (
    q.requiredVariant &&
    JSON.stringify(q.requiredVariant) !== JSON.stringify(o.variantClaims)
  )
    return fail("VARIANT_MISMATCH");
  if (resolution.status === "SUPPORTED_CHECKOUT") {
    if (
      m.merchantScope?.mode === "ONLY" &&
      !m.merchantScope.ids.includes(resolution.merchantId)
    )
      return fail("MERCHANT_NOT_SUPPORTED");
  } else if (mode === "EXECUTABLE" || m.merchantScope?.mode === "ONLY")
    return fail("CHECKOUT_NOT_SUPPORTED", "UNKNOWN");
  return { status: "ELIGIBLE", reason: "PRELIMINARY_ONLY" };
}
export interface RankingCandidate {
  readonly candidateId: string;
  readonly offer: NormalizedDiscoveryOffer;
  readonly checkout: "SUPPORTED_CHECKOUT" | "DISCOVERY_ONLY";
}
export interface CommerceRanker {
  rank(
    input: Readonly<{
      trust: "UNTRUSTED_DISCOVERY";
      candidates: readonly RankingCandidate[];
      preference: string;
    }>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class FakeCommerceRanker implements CommerceRanker {
  rank(input: Parameters<CommerceRanker["rank"]>[0]): Promise<unknown> {
    // Deterministic useful baseline, not an implicit error fallback. Eligible only.
    const sorted = [...input.candidates].sort(
      (a, b) =>
        a.offer.priceObservation!.minor - b.offer.priceObservation!.minor ||
        (a.candidateId < b.candidateId ? -1 : 1),
    );
    return Promise.resolve({
      candidateId: sorted[0]!.candidateId,
      explanation: "Lowest observed price among preliminary eligible offers.",
    });
  }
}
const selectionSchema = z
  .object({
    candidateId: z.string().regex(/^[a-f0-9]{64}$/),
    explanation: z.string().max(DISCOVERY_LIMITS.explanation).optional(),
  })
  .strict();
export async function boundedDiscoveryCall<T>(
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("DISCOVERY_TIMEOUT"));
        }, DISCOVERY_LIMITS.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
export interface DiscoverySelection {
  readonly requestId: string;
  readonly candidate: RankingCandidate;
  readonly explanation: string;
  readonly quantity: number;
  readonly mappingFingerprint: string | null;
  readonly rankingProof: unknown;
  readonly selectedAt: string;
}
export class CommerceDiscoveryEngine {
  readonly #providers: readonly CommerceDiscoveryProvider[];
  constructor(
    providers: readonly CommerceDiscoveryProvider[],
    private readonly resolver: ControlledDiscoveryResolver,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (
      providers.length === 0 ||
      providers.length > DISCOVERY_LIMITS.providers ||
      new Set(providers.map((p) => identifier.parse(p.providerId))).size !==
        providers.length
    )
      throw new Error("DISCOVERY_PROVIDER_CONFIGURATION_INVALID");
    // Freeze trusted provider IDs separately: an adapter cannot change its namespace.
    this.#providers = Object.freeze(
      providers.map((p) =>
        Object.freeze({
          providerId: p.providerId,
          discover: p.discover.bind(p),
        }),
      ),
    );
  }
  async select(
    rawMandate: unknown,
    rawQuery: unknown,
    ranker: CommerceRanker,
    mode: "EXECUTABLE" | "RECOMMENDATION" = "EXECUTABLE",
  ): Promise<DiscoverySelection> {
    const pm = MandateSchema.safeParse(rawMandate),
      pq = DiscoveryQuerySchema.safeParse(rawQuery);
    if (!pm.success || !pq.success)
      throw new Error("DISCOVERY_REQUEST_INVALID");
    const mandate = pm.data,
      query = pq.data;
    z.enum(["EXECUTABLE", "RECOMMENDATION"]).parse(mode);
    Object.freeze(query.requiredVariant);
    Object.freeze(query);
    const requestId = randomUUID(),
      candidates: RankingCandidate[] = [];
    const mappingBindings = new Map<string, string | null>();
    const proofMappings = new Map<string, DiscoveryMapping | null>();
    const results = await Promise.allSettled(
      this.#providers.map((p) =>
        boundedDiscoveryCall((signal) => p.discover(query, signal)),
      ),
    );
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      let response: unknown;
      try {
        response = boundedProviderResponse(result.value);
      } catch {
        continue;
      }
      if (
        !Array.isArray(response) ||
        response.length > DISCOVERY_LIMITS.offersPerProvider
      )
        continue;
      const offers: NormalizedDiscoveryOffer[] = [];
      for (const raw of response as unknown[]) {
        try {
          offers.push(
            normalizeDiscoveryOffer(this.#providers[index]!.providerId, raw),
          );
        } catch {
          /* Reject individual malformed offers; never fabricate facts. */
        }
      }
      if (
        Buffer.byteLength(
          JSON.stringify(
            offers.map((o) => [
              o.title,
              o.snippet,
              o.merchantClaim.displayName,
            ]),
          ),
        ) > DISCOVERY_LIMITS.textBytes ||
        Buffer.byteLength(JSON.stringify(offers.map((o) => o.provenance))) >
          DISCOVERY_LIMITS.provenanceBytes ||
        offers.reduce(
          (n, o) =>
            n + Number(o.productUrl !== null) + Number(o.imageUrl !== null),
          0,
        ) > DISCOVERY_LIMITS.references
      )
        continue;
      const counts = new Map<string, number>();
      for (const o of offers)
        counts.set(o.offerId, (counts.get(o.offerId) ?? 0) + 1);
      for (const o of offers) {
        if (counts.get(o.offerId) !== 1) continue;
        const resolution = this.resolver.inspect(o);
        if (
          discoveryEligibility(
            o,
            mandate,
            query,
            resolution,
            mode,
            this.clock().toISOString(),
          ).status !== "ELIGIBLE"
        )
          continue;
        const candidateId = createHash("sha256")
          .update(requestId + ":" + discoveryFingerprint(o))
          .digest("hex");
        proofMappings.set(
          candidateId,
          resolution.status === "SUPPORTED_CHECKOUT"
            ? resolution.mapping
            : null,
        );
        mappingBindings.set(
          candidateId,
          resolution.status === "SUPPORTED_CHECKOUT"
            ? resolution.mappingFingerprint
            : null,
        );
        candidates.push(
          Object.freeze({ candidateId, offer: o, checkout: resolution.status }),
        );
      }
    }
    let inputBytes = 0;
    const eligible = Object.freeze(
      candidates.slice(0, DISCOVERY_LIMITS.candidates).filter((c) => {
        const bytes = Buffer.byteLength(JSON.stringify(c));
        if (inputBytes + bytes > DISCOVERY_LIMITS.rankingInputBytes)
          return false;
        inputBytes += bytes;
        return true;
      }),
    );
    if (!eligible.length) throw new Error("NO_ELIGIBLE_DISCOVERY_CANDIDATES");
    let output: unknown;
    try {
      output = await boundedDiscoveryCall((signal) =>
        ranker.rank(
          Object.freeze({
            trust: "UNTRUSTED_DISCOVERY",
            candidates: eligible,
            preference: query.text,
          }),
          signal,
        ),
      );
    } catch {
      throw new Error("COMMERCE_RANKING_UNAVAILABLE");
    }
    // JSON text is the adapter contract; bounded before parsing, no recursive objects.
    if (
      typeof output !== "string" &&
      (output === null ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        Object.keys(output).length > 2)
    )
      throw new Error("COMMERCE_RANKING_INVALID");
    let parsed: z.infer<typeof selectionSchema>;
    try {
      if (typeof output === "string") {
        if (Buffer.byteLength(output) > DISCOVERY_LIMITS.rankingBytes)
          throw new Error();
        parsed = selectionSchema.parse(JSON.parse(output) as unknown);
      } else {
        // Bound only the accepted flat fields before schema parsing.
        const flat = output as Record<string, unknown>;
        if (
          Object.keys(flat).some(
            (k) => k !== "candidateId" && k !== "explanation",
          ) ||
          typeof flat.candidateId !== "string" ||
          flat.candidateId.length !== 64 ||
          (flat.explanation !== undefined &&
            (typeof flat.explanation !== "string" ||
              flat.explanation.length > DISCOVERY_LIMITS.explanation))
        )
          throw new Error();
        if (
          Buffer.byteLength(JSON.stringify(flat)) >
          DISCOVERY_LIMITS.rankingBytes
        )
          throw new Error();
        parsed = selectionSchema.parse(flat);
      }
    } catch {
      throw new Error("COMMERCE_RANKING_INVALID");
    }
    const candidate = eligible.find(
      (c) => c.candidateId === parsed.candidateId,
    );
    if (
      !candidate ||
      (mode === "EXECUTABLE" && candidate.checkout !== "SUPPORTED_CHECKOUT")
    )
      throw new Error("COMMERCE_CANDIDATE_NOT_IN_REQUEST");
    if (
      discoveryEligibility(
        candidate.offer,
        mandate,
        query,
        this.resolver.inspect(candidate.offer),
        mode,
        this.clock().toISOString(),
      ).status !== "ELIGIBLE"
    )
      throw new Error("DISCOVERY_SELECTION_STALE");
    return Object.freeze({
      requestId,
      candidate,
      explanation: parsed.explanation ?? "",
      quantity: query.quantity,
      mappingFingerprint: mappingBindings.get(candidate.candidateId) ?? null,
      rankingProof: {
        requestId,
        query,
        candidates: eligible.map((c) => ({
          ...c,
          mapping: proofMappings.get(c.candidateId),
        })),
        selectedCandidateId: candidate.candidateId,
        selectedAt: this.clock().toISOString(),
      },
      selectedAt: this.clock().toISOString(),
    });
  }
}

/** Bounded traversal precedes schema parsing. Network adapters must also stop
 * reading at responseBytes, before decoding JSON. Whole-response overflow fails. */
export function boundedProviderResponse(raw: unknown): unknown {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > DISCOVERY_LIMITS.responseBytes)
      throw new Error("DISCOVERY_RESPONSE_LIMIT");
    raw = JSON.parse(raw) as unknown;
  }
  let bytes = 0,
    nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 5)
      throw new Error("DISCOVERY_RESPONSE_LIMIT");
    if (typeof value === "string") bytes += Buffer.byteLength(value) * 6 + 2;
    else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      bytes += 32;
    else if (Array.isArray(value)) {
      if (value.length > DISCOVERY_LIMITS.offersPerProvider)
        throw new Error("DISCOVERY_RESPONSE_LIMIT");
      for (const child of value) visit(child, depth + 1);
    } else if (
      value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const keys = Object.keys(value);
      if (keys.length > 20) throw new Error("DISCOVERY_RESPONSE_LIMIT");
      for (const key of keys) {
        bytes += Buffer.byteLength(key) * 6 + 3;
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    } else if (value !== undefined)
      throw new Error("DISCOVERY_RESPONSE_INVALID");
    if (bytes > DISCOVERY_LIMITS.responseBytes)
      throw new Error("DISCOVERY_RESPONSE_LIMIT");
  };
  visit(raw, 0);
  return raw;
}
