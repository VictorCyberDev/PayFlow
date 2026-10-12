import {
  RankingMaterialSchema,
  rankingMaterialFingerprint,
} from "./discovery-proof.js";
import type { PayPalOrderView } from "./paypal.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type PostgresTrustRepository,
  persistedDate,
  canonicalDurableValue,
} from "./persistence.js";
import { mandateFingerprint, proposalDigest } from "./canonical.js";
import { authorize } from "./kernel.js";
import { verifyTrustTrace } from "./trust-trace.js";
import {
  verifyHistoricalExecutionGrant,
  type PublicKeyResolver,
} from "./execution-grant.js";
import {
  CheckoutManifestSchema,
  CheckoutQuoteSchema,
  checkoutManifestFingerprint,
  checkoutQuoteFingerprint,
  hasCommerceMetadata,
} from "./checkout-contracts.js";
import {
  controlledOfferFingerprint,
  merchantBindingFingerprint,
  MerchantBindingSchema,
} from "./commerce.js";
import { storedSelection, selectionFingerprint } from "./discovery-checkout.js";
import {
  discoveryFingerprint,
  mappingSchema,
  discoveryEligibility,
} from "./commerce-discovery.js";
import {
  AuthorizationMaterialSchema,
  authorizationMaterialFingerprint,
  ProviderObservationSchema,
  QuoteRefusalSchema,
  quoteRefusalFingerprint,
  providerObservationFingerprint,
} from "./trace-material.js";
import { verifyPayPalCommerce } from "./paypal-commerce.js";
export const TRACE_LIMITS = Object.freeze({
  stages: 40,
  evidence: 128,
  ledger: 4096,
  observations: 32,
  bytes: 65536,
  ledgerBytes: 2097152,
});
const identifier = z.string().min(1).max(128),
  reason = z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .max(96);
export const TraceStageSchema = z
  .object({
    stage: identifier,
    status: z.enum([
      "VERIFIED",
      "NOT_APPLICABLE",
      "INCOMPLETE",
      "INVALID",
      "UNKNOWN",
    ]),
    reasonCode: reason,
  })
  .strict();
export type TraceStage = z.infer<typeof TraceStageSchema>;
const money = z.number().int().safe().nonnegative().nullable();
export const OperationTraceSchema = z
  .object({
    version: z.literal("payflow.operation-trace.v1"),
    operationId: identifier,
    status: z.enum([
      "VERIFIED",
      "INCOMPLETE",
      "INVALID",
      "UNKNOWN_FINANCIAL_OUTCOME",
      "LEGACY",
    ]),
    financialOutcome: identifier,
    references: z
      .object(
        Object.fromEntries(
          [
            "principalId",
            "mandateId",
            "agentId",
            "selectionId",
            "requestId",
            "candidateId",
            "mappingId",
            "quoteId",
            "manifestId",
            "proposalId",
            "receiptId",
            "reservationId",
            "grantId",
            "paymentAttemptId",
            "providerOrderId",
            "providerCaptureId",
          ].map((k) => [k, identifier.nullable()]),
        ),
      )
      .strict(),
    stages: z.array(TraceStageSchema).max(TRACE_LIMITS.stages),
    authorityMeter: z
      .object({
        financial: z
          .object({
            currency: z.string().max(3).nullable(),
            singleMaximumMinor: money,
            principalState: z
              .enum(["ACTIVE", "DISABLED", "REVOKED"])
              .nullable(),
            agentState: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]).nullable(),
            mandateState: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]).nullable(),
            requestedMinor: money,
            authorizedMinor: money,
            reservedMinor: money,
            committedMinor: money,
            remainingMinor: money,
            capability: identifier.nullable(),
            mandateExpiresAt: z.string().datetime().nullable(),
            reservationState: identifier.nullable(),
            grantState: identifier.nullable(),
            freshDispatchBlocked: z.boolean().nullable(),
          })
          .strict(),
        commerce: z
          .object({
            trust: z.literal("TRUSTED_CHECKOUT"),
            observedPrice: z
              .object({
                trust: z.literal("UNTRUSTED_OBSERVATION"),
                minor: money,
                currency: z.string().max(3).nullable(),
              })
              .strict(),
            trustedTotalMinor: money,
            category: identifier.nullable(),
            condition: identifier.nullable(),
            logicalMerchant: identifier.nullable(),
            expectedRecipient: identifier.nullable(),
            observedRecipient: identifier.nullable(),
            observedAmount: z.string().max(32).nullable(),
            observedCurrency: z.string().max(3).nullable(),
            sku: identifier.nullable(),
            productFamily: identifier.nullable(),
            variant: z
              .object({
                switchType: identifier,
                finish: identifier,
                layout: identifier,
              })
              .strict()
              .nullable(),
            quantity: money,
            mappingRevision: money,
            offerFingerprint: z.string().max(64).nullable(),
            manifestFingerprint: z.string().max(64).nullable(),
          })
          .strict(),
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            sequence: z.number().int().safe().positive(),
            type: z
              .string()
              .regex(/^[A-Z0-9_]+$/)
              .max(64),
            hash: z.string().length(64),
          })
          .strict(),
      )
      .max(TRACE_LIMITS.evidence),
  })
  .strict();
export type OperationTrace = z.infer<typeof OperationTraceSchema>;
export function traceOverall(
  stages: readonly TraceStage[],
  outcome: string,
  legacy = false,
): OperationTrace["status"] {
  if (stages.some((s) => s.status === "INVALID")) return "INVALID";
  if (
    [
      "CAPTURE_UNKNOWN",
      "ORDER_CREATE_UNKNOWN",
      "CAPTURE_IN_FLIGHT",
      "ORDER_CREATING",
      "CAPTURE_PENDING_PROVIDER",
    ].includes(outcome)
  )
    return "UNKNOWN_FINANCIAL_OUTCOME";
  if (legacy) return "LEGACY";
  if (
    stages.some((s) => s.status === "INCOMPLETE" || s.status === "UNKNOWN") ||
    outcome !== "CAPTURED"
  )
    return "INCOMPLETE";
  return "VERIFIED";
}
export function boundOperationTrace(raw: unknown): OperationTrace {
  const t = OperationTraceSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(t)) > TRACE_LIMITS.bytes)
    throw new Error("TRACE_LIMIT_EXCEEDED");
  return t;
}
const same = (a: unknown, b: unknown) =>
  canonicalDurableValue(a) === canonicalDurableValue(b);
const safeRecipient = (v: unknown) =>
  typeof v === "string" && /^[A-Z0-9]{13}$/.test(v) ? v : null;
/** Read-only REPEATABLE READ snapshot. IDs select records; they never provide
 * expected terms. No payment calls, authority mutations or view evidence events. */
export class OperationTraceService {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly keys: PublicKeyResolver,
  ) {}
  async project(raw: unknown, now: string): Promise<OperationTrace> {
    const query = z
      .union([
        z.object({ proposalId: identifier }).strict(),
        z.object({ quoteId: identifier }).strict(),
        z.object({ selectionId: z.string().uuid() }).strict(),
      ])
      .parse(raw);
    z.string().datetime().parse(now);
    return this.repo.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const stages: TraceStage[] = [],
          evidence: OperationTrace["evidence"] = [];
        const stage = (
          name: string,
          status: TraceStage["status"],
          reasonCode: string,
        ) => {
          const existing = stages.find((s) => s.stage === name);
          if (existing) {
            const rank = {
              NOT_APPLICABLE: 0,
              VERIFIED: 1,
              INCOMPLETE: 2,
              UNKNOWN: 3,
              INVALID: 4,
            };
            if (rank[status] > rank[existing.status]) {
              existing.status = status;
              existing.reasonCode = reasonCode;
            }
            return;
          }
          if (stages.length < TRACE_LIMITS.stages - 1)
            stages.push({ stage: name, status, reasonCode });
          else if (!stages.some((s) => s.reasonCode === "TRACE_LIMIT_EXCEEDED"))
            stages.push({
              stage: "TRACE_BOUNDS",
              status: "INCOMPLETE",
              reasonCode: "TRACE_LIMIT_EXCEEDED",
            });
        };
        const check = (name: string, valid: boolean, code: string) =>
          stage(
            name,
            valid ? "VERIFIED" : "INVALID",
            valid ? "RELATIONSHIP_VERIFIED" : code,
          );
        const initial: OperationTrace = {
          version: "payflow.operation-trace.v1",
          operationId:
            "proposalId" in query
              ? query.proposalId
              : "quoteId" in query
                ? query.quoteId
                : query.selectionId,
          status: "INCOMPLETE",
          financialOutcome: "NOT_STARTED",
          references: Object.fromEntries(
            [
              "principalId",
              "mandateId",
              "agentId",
              "selectionId",
              "requestId",
              "candidateId",
              "mappingId",
              "quoteId",
              "manifestId",
              "proposalId",
              "receiptId",
              "reservationId",
              "grantId",
              "paymentAttemptId",
              "providerOrderId",
              "providerCaptureId",
            ].map((k) => [k, null]),
          ),
          stages,
          authorityMeter: {
            financial: {
              currency: null,
              singleMaximumMinor: null,
              principalState: null,
              agentState: null,
              mandateState: null,
              requestedMinor: null,
              authorizedMinor: null,
              reservedMinor: null,
              committedMinor: null,
              remainingMinor: null,
              capability: null,
              mandateExpiresAt: null,
              reservationState: null,
              grantState: null,
              freshDispatchBlocked: null,
            },
            commerce: {
              trust: "TRUSTED_CHECKOUT",
              observedPrice: {
                trust: "UNTRUSTED_OBSERVATION",
                minor: null,
                currency: null,
              },
              trustedTotalMinor: null,
              category: null,
              condition: null,
              logicalMerchant: null,
              expectedRecipient: null,
              observedRecipient: null,
              observedAmount: null,
              observedCurrency: null,
              sku: null,
              productFamily: null,
              variant: null,
              quantity: null,
              mappingRevision: null,
              offerFingerprint: null,
              manifestFingerprint: null,
            },
          },
          evidence,
        };
        const reference = (key: string, value: unknown) => {
          if (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 128
          )
            initial.references[key] = value;
          else if (value !== null && value !== undefined)
            stage("TRACE_BOUNDS", "INCOMPLETE", "TRACE_LIMIT_EXCEEDED");
        };
        const finish = (legacy = false) =>
          boundOperationTrace({
            ...initial,
            status: traceOverall(stages, initial.financialOutcome, legacy),
          });
        try {
          const [size] =
            await db`select count(*)::int n,coalesce(sum(octet_length(data::text)),0)::bigint bytes from (select data from evidence_events order by sequence limit ${TRACE_LIMITS.ledger + 1}) bounded`;
          if (
            Number(size?.n) > TRACE_LIMITS.ledger ||
            Number(size?.bytes) > TRACE_LIMITS.ledgerBytes
          ) {
            stage("EVIDENCE", "INCOMPLETE", "TRACE_LIMIT_EXCEEDED");
            return finish();
          }
          const ledger = await this.repo.evidence(db);
          check(
            "EVIDENCE",
            verifyTrustTrace(ledger).valid,
            "EVIDENCE_CHAIN_INVALID",
          );
          let quoteId: string | null =
            "quoteId" in query ? query.quoteId : null;
          let proposalId: string | null =
            "proposalId" in query ? query.proposalId : null;
          let selectionId: string | null =
            "selectionId" in query ? query.selectionId : null;
          if (selectionId) {
            const [link] =
              await db`select quote_id from commerce_discovery_quote_links where selection_id=${selectionId}`;
            quoteId = link ? String(link.quote_id) : null;
          }
          if (proposalId) {
            const [link] =
              await db`select m.quote_id from checkout_manifest_proposals l join checkout_manifests m on m.id=l.manifest_id where l.proposal_id=${proposalId}`;
            quoteId = link ? String(link.quote_id) : null;
          }
          if (quoteId && !proposalId) {
            const [link] =
              await db`select l.proposal_id from checkout_manifests m join checkout_manifest_proposals l on l.manifest_id=m.id where m.quote_id=${quoteId}`;
            proposalId = link ? String(link.proposal_id) : null;
          }
          if (quoteId && !selectionId) {
            const [link] =
              await db`select selection_id from commerce_discovery_quote_links where quote_id=${quoteId}`;
            selectionId = link ? String(link.selection_id) : null;
          }
          const commerce = !!quoteId || !!selectionId;
          let selection: z.infer<typeof storedSelection> | undefined;
          if (selectionId) {
            const [row] =
              await db`select * from commerce_discovery_selections where id=${selectionId}`;
            if (!row) {
              stage("DISCOVERY", "INVALID", "DISCOVERY_SELECTION_MISSING");
              return finish();
            }
            const s = storedSelection.parse(row.document),
              fp = discoveryFingerprint(s.offer);
            selection = s;
            reference("selectionId", selectionId);
            reference("requestId", s.requestId);
            reference("candidateId", s.candidateId);
            reference("mappingId", s.mappingId);
            reference("principalId", s.principalId);
            reference("mandateId", s.mandateId);
            check(
              "DISCOVERY",
              row.document_hash === selectionFingerprint(s) &&
                row.request_id === s.requestId &&
                row.candidate_id === s.candidateId &&
                row.principal_id === s.principalId &&
                row.mandate_id === s.mandateId &&
                row.mandate_fingerprint === s.mandateFingerprint &&
                s.selectedAt === persistedDate(row.selected_at).toISOString() &&
                fp === s.discoveryFingerprint &&
                s.candidateId ===
                  createHash("sha256")
                    .update(s.requestId + ":" + fp)
                    .digest("hex"),
              "DISCOVERY_PROVENANCE_INVALID",
            );
            const mapping = mappingSchema.parse({
              mappingId: s.mappingId,
              revision: s.mappingRevision,
              providerId: s.offer.providerId,
              offerId: s.offer.offerId,
              productFamilyId: s.controlledOffer.productFamilyId,
              merchantClaimId: s.controlledOffer.merchantId,
              controlledOfferId: s.controlledOffer.offerId,
              sku: s.controlledOffer.sku,
              variant: s.controlledOffer.variant,
              condition: s.controlledOffer.condition,
            });
            const mappingFp = createHash("sha256")
              .update(
                "payflow:discovery-mapping:v1\n" + JSON.stringify(mapping),
              )
              .digest("hex");
            check(
              "PROMOTION",
              mappingFp === s.mappingFingerprint &&
                controlledOfferFingerprint(s.controlledOffer) ===
                  s.controlledOfferFingerprint &&
                s.offer.condition === s.controlledOffer.condition &&
                same(s.offer.variantClaims, s.controlledOffer.variant) &&
                s.offer.merchantClaim.id === s.controlledOffer.merchantId,
              "PROMOTION_BINDING_INVALID",
            );
            initial.authorityMeter.commerce.observedPrice = {
              trust: "UNTRUSTED_OBSERVATION",
              minor: s.offer.priceObservation?.minor ?? null,
              currency: s.offer.priceObservation?.currency ?? null,
            };
            initial.authorityMeter.commerce.mappingRevision = s.mappingRevision;
            const [rankingRow] =
              await db`select * from discovery_ranking_material where selection_id=${selectionId}`;
            if (!rankingRow)
              stage(
                "RANKER_SELECTION",
                "INCOMPLETE",
                "RANKING_MATERIAL_ABSENT",
              );
            else {
              const proof = RankingMaterialSchema.parse(rankingRow.document),
                mandate = await this.repo.getMandate(s.mandateId, db);
              check(
                "RANKER_SELECTION",
                !!mandate &&
                  rankingMaterialFingerprint(proof) ===
                    rankingRow.fingerprint &&
                  proof.requestId === s.requestId &&
                  proof.selectedCandidateId === s.candidateId &&
                  proof.query.quantity === s.quantity &&
                  proof.selectedAt === s.selectedAt &&
                  new Set(proof.candidates.map((c) => c.candidateId)).size ===
                    proof.candidates.length &&
                  proof.candidates.some(
                    (c) =>
                      c.candidateId === s.candidateId &&
                      discoveryFingerprint(c.offer) === fp,
                  ) &&
                  proof.candidates.every((c) => {
                    const cid = createHash("sha256")
                      .update(
                        proof.requestId + ":" + discoveryFingerprint(c.offer),
                      )
                      .digest("hex");
                    return (
                      cid === c.candidateId &&
                      c.mapping.providerId === c.offer.providerId &&
                      c.mapping.offerId === c.offer.offerId &&
                      c.mapping.productFamilyId === c.offer.productFamilyId &&
                      c.mapping.merchantClaimId === c.offer.merchantClaim.id &&
                      c.mapping.condition === c.offer.condition &&
                      same(c.mapping.variant, c.offer.variantClaims) &&
                      discoveryEligibility(
                        c.offer,
                        mandate,
                        proof.query,
                        {
                          status: "SUPPORTED_CHECKOUT",
                          merchantId: c.mapping.merchantClaimId,
                          mapping: c.mapping,
                          mappingFingerprint: createHash("sha256")
                            .update(
                              "payflow:discovery-mapping:v1\n" +
                                JSON.stringify(c.mapping),
                            )
                            .digest("hex"),
                        },
                        "EXECUTABLE",
                        proof.selectedAt,
                      ).status === "ELIGIBLE"
                    );
                  }),
                "RANKING_MEMBERSHIP_INVALID",
              );
            }
            const [link] =
              await db`select * from commerce_discovery_quote_links where selection_id=${selectionId}`;
            if (!link) {
              const [refused] =
                await db`select * from commerce_quote_refusals where selection_id=${selectionId}`;
              if (refused) {
                const refusal = QuoteRefusalSchema.parse(refused.document);
                const m = await this.repo.getMandate(s.mandateId, db);
                check(
                  "QUOTE_REFUSAL",
                  !!m &&
                    refused.fingerprint === quoteRefusalFingerprint(refusal) &&
                    controlledOfferFingerprint(refusal.offer) ===
                      refusal.quote.controlledOfferFingerprint &&
                    refusal.quote.totalMinor > m.maxSingleTransactionMinor &&
                    refusal.quote.offerId === s.controlledOffer.offerId &&
                    refusal.quote.sku === s.controlledOffer.sku &&
                    same(refusal.quote.variant, s.controlledOffer.variant),
                  "QUOTE_REFUSAL_INVALID",
                );
                initial.authorityMeter.commerce.trustedTotalMinor =
                  refusal.quote.totalMinor;
                initial.authorityMeter.financial.requestedMinor =
                  refusal.quote.totalMinor;
                initial.authorityMeter.financial.singleMaximumMinor =
                  m?.maxSingleTransactionMinor ?? null;
                initial.authorityMeter.financial.currency =
                  refusal.quote.currency;
                initial.financialOutcome = "DENIED";
              }
              stage(
                "DISCOVERY_QUOTE_LINK",
                "INCOMPLETE",
                "DISCOVERY_QUOTE_LINK_MISSING",
              );
              return finish();
            }
            check(
              "DISCOVERY_QUOTE_LINK",
              link.quote_id === quoteId &&
                link.mapping_fingerprint === mappingFp,
              "DISCOVERY_QUOTE_LINK_INVALID",
            );
          } else
            stage(
              "DISCOVERY",
              commerce ? "INCOMPLETE" : "NOT_APPLICABLE",
              commerce
                ? "DISCOVERY_PROVENANCE_ABSENT"
                : "LEGACY_DISCOVERY_NOT_APPLICABLE",
            );
          let manifest: z.infer<typeof CheckoutManifestSchema> | undefined;
          if (quoteId) {
            const [qrow] =
              await db`select q.*,encode(sha256(convert_to(q.document::text,'UTF8')),'hex') actual_hash,encode(sha256(convert_to(q.offer_document::text,'UTF8')),'hex') actual_offer_hash from commerce_quotes q where id=${quoteId}`;
            if (!qrow) {
              stage("QUOTE", "INVALID", "QUOTE_MISSING");
              return finish();
            }
            const q = CheckoutQuoteSchema.parse(qrow.document);
            reference("quoteId", q.quoteId);
            if (selection) {
              const [link] =
                await db`select * from commerce_discovery_quote_links where selection_id=${selectionId}`;
              check(
                "SELECTED_QUOTE",
                link?.controlled_offer_fingerprint ===
                  q.controlledOfferFingerprint &&
                  qrow.principal_id === selection.principalId &&
                  qrow.mandate_id === selection.mandateId &&
                  qrow.mandate_fingerprint === selection.mandateFingerprint &&
                  q.quantity === selection.quantity &&
                  q.offerId === selection.controlledOffer.offerId &&
                  q.sku === selection.controlledOffer.sku &&
                  q.condition === selection.controlledOffer.condition &&
                  same(q.variant, selection.controlledOffer.variant),
                "DISCOVERY_QUOTE_LINK_INVALID",
              );
            }
            check(
              "QUOTE",
              q.quoteId === quoteId &&
                qrow.document_hash === qrow.actual_hash &&
                qrow.offer_document_hash === qrow.actual_offer_hash &&
                checkoutQuoteFingerprint(q) === qrow.fingerprint &&
                controlledOfferFingerprint(qrow.offer_document) ===
                  q.controlledOfferFingerprint,
              "QUOTE_INTEGRITY_INVALID",
            );
            const c = initial.authorityMeter.commerce;
            c.trustedTotalMinor = q.totalMinor;
            c.condition = q.condition;
            c.logicalMerchant = q.logicalMerchantId;
            c.sku = q.sku;
            c.variant = q.variant;
            c.quantity = q.quantity;
            c.productFamily = q.productFamilyId;
            c.offerFingerprint = q.controlledOfferFingerprint;
            c.category = "KEYBOARD";
            const [mrow] =
              await db`select *,encode(sha256(convert_to(document::text,'UTF8')),'hex') actual_hash from checkout_manifests where quote_id=${quoteId}`;
            if (mrow) {
              manifest = CheckoutManifestSchema.parse(mrow.document);
              reference("manifestId", manifest.manifestId);
              check(
                "MANIFEST",
                mrow.document_hash === mrow.actual_hash &&
                  checkoutManifestFingerprint(manifest) === mrow.fingerprint &&
                  manifest.quoteId === q.quoteId &&
                  manifest.totalMinor === q.totalMinor &&
                  manifest.currency === q.currency,
                "MANIFEST_INTEGRITY_INVALID",
              );
              c.manifestFingerprint = checkoutManifestFingerprint(manifest);
              c.expectedRecipient = manifest.expectedPayPalMerchantId;
              const [brow] =
                await db`select * from commerce_merchant_bindings where merchant_id=${manifest.logicalMerchantId} and revision=${manifest.merchantBindingRevision}`;
              const binding = MerchantBindingSchema.parse(brow?.document);
              check(
                "MERCHANT_BINDING",
                merchantBindingFingerprint(binding) ===
                  manifest.merchantBindingFingerprint &&
                  binding.expectedPayPalMerchantId ===
                    manifest.expectedPayPalMerchantId,
                "MERCHANT_BINDING_INVALID",
              );
            } else stage("MANIFEST", "INCOMPLETE", "MANIFEST_NOT_SEALED");
          }
          if (!proposalId) {
            stage("PROPOSAL", "INCOMPLETE", "PROPOSAL_NOT_CREATED");
            return finish();
          }
          const p = await this.repo.getProposal(proposalId, db);
          if (!p) {
            stage("PROPOSAL", "INVALID", "PROPOSAL_MISSING");
            return finish();
          }
          reference("proposalId", p.id);
          reference("mandateId", p.mandateId);
          reference("agentId", p.agentId);
          const legacy = !hasCommerceMetadata(p.metadata);
          check("PROPOSAL", !(legacy && commerce), "COMMERCE_BINDING_REQUIRED");
          const m = await this.repo.getMandate(p.mandateId, db),
            agent = await this.repo.getAgent(p.agentId, db, false);
          if (!m || !agent) {
            stage("AUTHORITY", "INVALID", "AUTHORITY_RECORD_MISSING");
            return finish(legacy);
          }
          check(
            "IDENTITY",
            p.agentId === m.authorizedAgentId &&
              agent.principalId === m.principalId &&
              p.mandateFingerprint === mandateFingerprint(m),
            "AUTHORITY_IDENTITY_INVALID",
          );
          const [principal] =
            await db`select status from principals where id=${m.principalId}`;
          const [mandateState] =
            await db`select revoked_at from mandates where id=${m.id}`;
          const f = initial.authorityMeter.financial;
          f.currency = m.currency;
          reference("principalId", m.principalId);
          f.singleMaximumMinor = m.maxSingleTransactionMinor;
          f.requestedMinor = p.amount.minor;
          f.capability = p.requestedCapability;
          f.mandateExpiresAt = m.expiresAt;
          f.principalState = principal
            ? z.enum(["ACTIVE", "DISABLED", "REVOKED"]).parse(principal.status)
            : null;
          f.agentState = agent.status;
          f.mandateState = mandateState?.revoked_at
            ? "REVOKED"
            : Date.parse(now) >= Date.parse(m.expiresAt)
              ? "EXPIRED"
              : "ACTIVE";
          const [currentBinding] = manifest
            ? await db`select b.* from commerce_merchant_heads h join commerce_merchant_bindings b on b.merchant_id=h.merchant_id and b.revision=h.revision where h.merchant_id=${manifest.logicalMerchantId}`
            : [];
          f.freshDispatchBlocked =
            (manifest !== undefined &&
              (!currentBinding ||
                !currentBinding.active ||
                Number(currentBinding.revision) !==
                  manifest.merchantBindingRevision ||
                currentBinding.fingerprint !==
                  manifest.merchantBindingFingerprint)) ||
            !principal ||
            principal.status !== "ACTIVE" ||
            agent.status !== "ACTIVE" ||
            !m.allowedCapabilities.includes(p.requestedCapability) ||
            !agent.capabilities.includes(p.requestedCapability) ||
            Date.parse(now) < Date.parse(m.createdAt) ||
            Date.parse(now) < Date.parse(agent.issuedAt) ||
            !!mandateState?.revoked_at ||
            Date.parse(now) >= Date.parse(m.expiresAt) ||
            Date.parse(now) >= Date.parse(agent.expiresAt) ||
            (manifest !== undefined &&
              Date.parse(now) >= Date.parse(manifest.quoteExpiresAt));
          check("PRINCIPAL", !!principal, "PRINCIPAL_MISSING");
          check(
            "MANDATE",
            p.mandateFingerprint === mandateFingerprint(m),
            "MANDATE_FINGERPRINT_INVALID",
          );
          check(
            "AGENT_PASSPORT",
            agent.id === m.authorizedAgentId &&
              agent.principalId === m.principalId,
            "AGENT_OWNERSHIP_INVALID",
          );
          const accounting = await this.repo.authorityAccounting(
            m.id,
            m.cumulativeLimitMinor,
            db,
          );
          f.committedMinor = accounting.committedMinor;
          f.remainingMinor = accounting.availableMinor;
          const [drow] =
            await db`select id from decision_receipts where proposal_id=${p.id}`;
          if (!drow) {
            stage("RECEIPT", "INCOMPLETE", "AUTHORIZATION_NOT_EVALUATED");
            return finish(legacy);
          }
          const receipt = await this.repo.getReceipt(String(drow.id), db);
          if (!receipt) throw new Error();
          reference("receiptId", receipt.receiptId);
          await this.repo.assertReceiptProposal(receipt.receiptId, p, db);
          check(
            "RECEIPT",
            receipt.proposalId === p.id &&
              receipt.mandateFingerprint === p.mandateFingerprint &&
              receipt.agentId === p.agentId &&
              receipt.amount.minor === p.amount.minor &&
              receipt.amount.currency === p.amount.currency,
            "RECEIPT_RELATIONSHIP_INVALID",
          );
          const [material] =
            await db`select * from authorization_verification_material where receipt_id=${receipt.receiptId}`;
          if (material) {
            const proof = AuthorizationMaterialSchema.parse(material.document);
            const { consumedQuantity, ...context } = proof.context;
            const replay = authorize(m, proof.agent, p, {
              ...context,
              ...(consumedQuantity === undefined ? {} : { consumedQuantity }),
            });
            const expected = { ...replay, receiptId: receipt.receiptId };
            check(
              "AUTHORITY_CONSERVATION",
              authorizationMaterialFingerprint(proof) ===
                material.fingerprint && same(expected, receipt),
              "AUTHORIZATION_REPLAY_INVALID",
            );
          } else
            stage(
              "AUTHORITY_CONSERVATION",
              "INCOMPLETE",
              "AUTHORIZATION_MATERIAL_ABSENT",
            );
          if (receipt.decision === "DENY") {
            initial.financialOutcome = "DENIED";
            stage("EXECUTION", "NOT_APPLICABLE", "DENIED_NO_EXECUTION");
            return finish(legacy);
          }
          const [approval] =
            await db`select * from approvals where receipt_id=${receipt.receiptId}`;
          stage(
            "HUMAN_APPROVAL",
            receipt.decision === "ESCALATE"
              ? approval &&
                approval.principal_id === m.principalId &&
                approval.proposal_id === p.id &&
                approval.status === "APPROVED"
                ? "VERIFIED"
                : "INCOMPLETE"
              : "NOT_APPLICABLE",
            receipt.decision === "ESCALATE"
              ? "ESCALATION_APPROVAL_RELATIONSHIP"
              : "APPROVAL_NOT_REQUIRED",
          );
          const r = await this.repo.getReservationByProposal(p.id, db);
          if (!r) {
            stage("RESERVATION", "INCOMPLETE", "RESERVATION_ABSENT");
            return finish(legacy);
          }
          check(
            "RESERVATION",
            r.receiptId === receipt.receiptId &&
              r.mandateId === p.mandateId &&
              r.amountMinor === p.amount.minor &&
              r.currency === p.amount.currency &&
              (r.quantity === undefined || r.quantity === p.quantity),
            "RESERVATION_RELATIONSHIP_INVALID",
          );
          reference("reservationId", r.id);
          f.reservedMinor = ["AUTHORIZED", "EXECUTING"].includes(r.status)
            ? r.amountMinor
            : 0;
          f.reservationState = r.status;
          f.authorizedMinor = r.amountMinor;
          initial.financialOutcome = r.status;
          const [g] =
            await db`select * from execution_grants where reservation_id=${r.id}`;
          if (!g) {
            stage("GRANT", "INCOMPLETE", "GRANT_ABSENT");
            return finish(legacy);
          }
          await this.repo.assertGrantSnapshot(String(g.id), db);
          reference("grantId", String(g.id));
          f.grantState = String(g.status);
          f.freshDispatchBlocked =
            f.freshDispatchBlocked ||
            Date.parse(now) >= persistedDate(g.expires_at).getTime() ||
            Date.parse(now) >= Date.parse(r.expiresAt) ||
            !["ISSUED", "CLAIMED"].includes(String(g.status));
          const [signature] =
            await db`select signed_token from execution_grant_signatures where grant_id=${String(g.id)}`;
          if (signature) {
            const c = verifyHistoricalExecutionGrant(
              String(signature.signed_token),
              this.keys,
            );
            const columns: Record<string, unknown> = {
              jti: g.id,
              kid: g.kid,
              version: g.version,
              audience: g.audience,
              principalId: g.principal_id,
              agentId: g.agent_id,
              mandateId: g.mandate_id,
              mandateFingerprint: g.mandate_fingerprint,
              proposalId: g.proposal_id,
              proposalDigest: g.proposal_digest,
              receiptId: g.receipt_id,
              reservationId: g.reservation_id,
              capability: g.capability,
              amountMinor: Number(g.amount_minor),
              currency: g.currency,
              merchantId: g.merchant_id,
              issuedAt: persistedDate(g.issued_at).toISOString(),
              expiresAt: persistedDate(g.expires_at).toISOString(),
              authorizationEngineVersion: receipt.authorizationEngineVersion,
            };
            check(
              "GRANT_SIGNATURE",
              Object.entries(columns).every(
                ([k, v]) => c[k as keyof typeof c] === v,
              ) &&
                c.proposalDigest === proposalDigest(p) &&
                c.reservationId === r.id &&
                c.principalId === m.principalId,
              "GRANT_BINDING_INVALID",
            );
          } else
            stage("GRANT_SIGNATURE", "INCOMPLETE", "SIGNATURE_MATERIAL_ABSENT");
          const [a] =
            await db`select * from payment_attempts where grant_id=${String(g.id)}`;
          if (!a) {
            stage("ATTEMPT", "INCOMPLETE", "PAYMENT_NOT_STARTED");
            return finish(legacy);
          }
          check(
            "ATTEMPT",
            a.reservation_id === r.id &&
              a.proposal_id === p.id &&
              a.mandate_id === m.id &&
              a.principal_id === m.principalId &&
              Number(a.amount_minor) === p.amount.minor &&
              a.currency === p.amount.currency &&
              a.merchant_reference === p.merchant.id,
            "ATTEMPT_BINDING_INVALID",
          );
          initial.financialOutcome = String(a.status);
          reference("paymentAttemptId", String(a.id));
          reference("providerOrderId", a.provider_order_id);
          reference("providerCaptureId", a.provider_capture_id);
          const related = ledger.filter((e) =>
            [
              p.id,
              r.id,
              String(g.id),
              String(a.id),
              receipt.receiptId,
              selectionId,
              quoteId,
              manifest?.manifestId,
            ].some((id) => id && Object.values(e.data).includes(id)),
          );
          if (related.length > TRACE_LIMITS.evidence) {
            stage("EVIDENCE", "INCOMPLETE", "TRACE_LIMIT_EXCEEDED");
            return finish(legacy);
          }
          for (const e of related) {
            if (!/^[A-Z0-9_]{1,64}$/.test(e.type)) {
              stage("EVIDENCE", "INVALID", "EVIDENCE_REPRESENTATION_INVALID");
              continue;
            }
            evidence.push({ sequence: e.sequence, type: e.type, hash: e.hash });
          }
          const loaded =
            await db`select * from paypal_provider_observations where payment_attempt_id=${String(a.id)} order by observed_at,id limit ${TRACE_LIMITS.observations + 1}`;
          const observationSequence = (id: unknown) =>
            related.find(
              (e) =>
                e.type === "PAYPAL_PROVIDER_OBSERVED" &&
                e.data.observationId === id,
            )?.sequence ?? 0;
          const observations = [...loaded].sort(
            (a, b) => observationSequence(a.id) - observationSequence(b.id),
          );
          if (observations.length > TRACE_LIMITS.observations) {
            stage("PROVIDER", "INCOMPLETE", "TRACE_LIMIT_EXCEEDED");
            return finish(legacy);
          }
          if (!observations.length)
            stage("PROVIDER", "INCOMPLETE", "PROVIDER_OBSERVATIONS_ABSENT");
          for (const o of observations) {
            const view = ProviderObservationSchema.parse(o.document);
            check(
              "PROVIDER_STATUS",
              [
                "CREATED",
                "SAVED",
                "APPROVED",
                "PAYER_ACTION_REQUIRED",
                "COMPLETED",
                "VOIDED",
              ].includes(view.status),
              "PROVIDER_STATUS_INVALID",
            );
            if (o.phase === "GET" && view.status === "APPROVED")
              stage("PAYER_APPROVAL", "VERIFIED", "SERVER_APPROVAL_OBSERVED");
            check(
              "PROVIDER_OBSERVATION",
              providerObservationFingerprint(view) === o.fingerprint &&
                related.some(
                  (e) =>
                    e.type === "PAYPAL_PROVIDER_OBSERVED" &&
                    e.data.observationId === o.id &&
                    e.data.fingerprint === o.fingerprint &&
                    e.data.phase === o.phase,
                ),
              "PROVIDER_OBSERVATION_INVALID",
            );
            if (a.provider_order_id)
              check(
                "PROVIDER_ORDER_ID",
                view.id === a.provider_order_id,
                "PROVIDER_ORDER_SUBSTITUTION",
              );
            else
              stage(
                "PROVIDER_ORDER_ID",
                "INCOMPLETE",
                "PROVIDER_ORDER_NOT_LINKED",
              );
            if (manifest) {
              try {
                verifyPayPalCommerce(
                  manifest,
                  view as PayPalOrderView,
                  view.captures.length > 0,
                );
                check(
                  "PROVIDER_COMMERCE",
                  view.purchaseUnits[0]?.referenceId === p.id,
                  "PROVIDER_REFERENCE_INVALID",
                );
              } catch {
                stage(
                  "PROVIDER_COMMERCE",
                  "INVALID",
                  "COMMERCE_PROVIDER_MISMATCH",
                );
              }
            }
            const u = view.purchaseUnits[0];
            initial.authorityMeter.commerce.observedRecipient = safeRecipient(
              u?.payeeMerchantId,
            );
            initial.authorityMeter.commerce.observedAmount =
              typeof u?.amountValue === "string" &&
              /^\d{1,14}(\.\d{2})?$/.test(u.amountValue)
                ? u.amountValue
                : null;
            initial.authorityMeter.commerce.observedCurrency = [
              "USD",
              "EUR",
              "GBP",
              "AUD",
              "CAD",
              "JPY",
            ].includes(u?.currency ?? "")
              ? u!.currency!
              : null;
            if (a.status === "CAPTURED" && view.captures.length) {
              const c = view.captures[0]!;
              check(
                "CAPTURE",
                c.id === a.provider_capture_id &&
                  c.status === "COMPLETED" &&
                  view.status === "COMPLETED" &&
                  (c.orderId === undefined ||
                    c.orderId === a.provider_order_id),
                "CAPTURE_BINDING_INVALID",
              );
            }
          }
          if (manifest) {
            for (const e of related.filter(
              (e) => e.type === "PAYPAL_OPERATION_DISPATCHED",
            ))
              check(
                "DISPATCH_FRESHNESS",
                Date.parse(e.occurredAt) >= Date.parse(manifest.quotedAt) &&
                  Date.parse(e.occurredAt) <
                    Date.parse(manifest.quoteExpiresAt) &&
                  Date.parse(e.occurredAt) < Date.parse(m.expiresAt) &&
                  Date.parse(e.occurredAt) < Date.parse(r.expiresAt) &&
                  Date.parse(e.occurredAt) <
                    persistedDate(g.expires_at).getTime() &&
                  (!mandateState?.revoked_at ||
                    Date.parse(e.occurredAt) <
                      persistedDate(mandateState.revoked_at).getTime()),
                "DISPATCH_AUTHORITY_EXPIRED",
              );
          }
          const [resume] =
            await db`select principal_id,proposal_id,paypal_order_id,created_at,expires_at from payment_resume_capabilities where payment_attempt_id=${String(a.id)}`;
          if (resume)
            check(
              "RESUME_BINDING",
              resume.principal_id === a.principal_id &&
                resume.proposal_id === a.proposal_id &&
                resume.paypal_order_id === a.provider_order_id,
              "RESUME_BINDING_INVALID",
            );
          else
            stage("RESUME_BINDING", "NOT_APPLICABLE", "NO_RESUME_CAPABILITY");
          if (String(a.failure_classification).startsWith("COMMERCE_")) {
            stage("QUARANTINE", "INVALID", "COMMERCE_PROVIDER_MISMATCH");
            initial.financialOutcome = "QUARANTINED";
          }
          if (a.status === "CAPTURED")
            check(
              "FINANCIAL_FINALIZATION",
              r.status === "COMMITTED" &&
                g.status === "CONSUMED" &&
                !!a.provider_capture_id &&
                a.provider_capture_status === "COMPLETED" &&
                related.some(
                  (e) =>
                    e.type === "PAYMENT_COMMITTED" &&
                    e.data.paymentAttemptId === a.id &&
                    e.data.paypalCaptureId === a.provider_capture_id &&
                    e.occurredAt === persistedDate(a.captured_at).toISOString(),
                ) &&
                observations.some((o) => {
                  const v = ProviderObservationSchema.parse(o.document);
                  return (
                    v.status === "COMPLETED" &&
                    v.captures.some(
                      (c) =>
                        c.id === a.provider_capture_id &&
                        c.status === "COMPLETED",
                    )
                  );
                }),
              "FINANCIAL_FINALIZATION_INVALID",
            );
          else
            stage(
              "FINANCIAL_FINALIZATION",
              "INCOMPLETE",
              f.freshDispatchBlocked
                ? "CURRENT_AUTHORITY_WITHHOLDS_CAPTURE"
                : "PAYMENT_NOT_FINAL",
            );
          return finish(legacy);
        } catch (error) {
          stage(
            "DURABLE_INTEGRITY",
            error instanceof Error &&
              error.message === "GRANT_PROOF_KEY_UNAVAILABLE"
              ? "INCOMPLETE"
              : "INVALID",
            error instanceof Error &&
              error.message === "GRANT_PROOF_KEY_UNAVAILABLE"
              ? "GRANT_PROOF_KEY_UNAVAILABLE"
              : "DURABLE_RELATIONSHIP_INVALID",
          );
          return finish();
        }
      },
    );
  }
}
