import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalDurableValue } from "./persistence.js";
import {
  DiscoveryQuerySchema,
  NormalizedDiscoveryOfferSchema,
  mappingSchema,
} from "./commerce-discovery.js";
export const RankingMaterialSchema = z
  .object({
    requestId: z.string().uuid(),
    query: DiscoveryQuerySchema,
    candidates: z
      .array(
        z
          .object({
            candidateId: z.string().regex(/^[a-f0-9]{64}$/),
            offer: NormalizedDiscoveryOfferSchema,
            checkout: z.literal("SUPPORTED_CHECKOUT"),
            mapping: mappingSchema,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    selectedCandidateId: z.string().regex(/^[a-f0-9]{64}$/),
    selectedAt: z.string().datetime(),
  })
  .strict();
export function rankingMaterialFingerprint(raw: unknown): string {
  return createHash("sha256")
    .update("payflow:ranking-material:v1\n")
    .update(canonicalDurableValue(RankingMaterialSchema.parse(raw)))
    .digest("hex");
}
