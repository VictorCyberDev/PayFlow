import { CheckoutQuoteRefusedError } from "./checkout.js";
import {
  QuoteRefusalSchema,
  quoteRefusalFingerprint,
} from "./trace-material.js";
import {
  RankingMaterialSchema,
  rankingMaterialFingerprint,
} from "./discovery-proof.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { mandateFingerprint } from "./canonical.js";
import {
  ControlledOfferSchema,
  controlledOfferFingerprint,
} from "./commerce.js";
import {
  type CommerceDiscoveryEngine,
  type ControlledDiscoveryResolver,
  NormalizedDiscoveryOfferSchema,
  discoveryFingerprint,
  freezeDiscovery,
  DISCOVERY_LIMITS,
  type CommerceRanker,
  type DiscoverySelection,
} from "./commerce-discovery.js";
import type { DurableCheckoutService } from "./checkout.js";
import type { PostgresTrustRepository } from "./persistence.js";
import { persistedDate } from "./persistence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const storedSelection = z
  .object({
    version: z.literal("payflow.discovery-selection.v1"),
    requestId: z.string().uuid(),
    candidateId: hash,
    offer: NormalizedDiscoveryOfferSchema,
    discoveryFingerprint: hash,
    controlledOffer: ControlledOfferSchema,
    controlledOfferFingerprint: hash,
    promotionStatus: z.literal("SUPPORTED_CHECKOUT"),
    mappingId: z.string().min(1).max(96),
    mappingRevision: z.number().int().positive().max(1000000),
    mappingFingerprint: hash,
    principalId: z.string().min(1).max(128),
    mandateId: z.string().min(1).max(128),
    mandateFingerprint: hash,
    quantity: z.number().int().positive().max(1000),
    selectedAt: z.string().datetime(),
  })
  .strict();
export function selectionFingerprint(
  document: z.infer<typeof storedSelection>,
): string {
  return createHash("sha256")
    .update("payflow:discovery-selection:v1\n")
    .update(JSON.stringify(storedSelection.parse(document)))
    .digest("hex");
}
/** Trusted host composition and owner routing are required, as with M4B. No
 * authorization, manifest, grant or provider dispatch occurs in this service. */
export class DiscoveryCheckoutService {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly engine: CommerceDiscoveryEngine,
    private readonly resolver: ControlledDiscoveryResolver,
    private readonly checkout: DurableCheckoutService,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private async authority(mandateId: string, expected?: string) {
    const m = await this.repo.getMandate(mandateId);
    if (!m) throw new Error("DISCOVERY_AUTHORITY_UNAVAILABLE");
    await this.repo.assertMandateActive(m.id);
    await this.repo.assertPrincipalActive(m.principalId, this.repo.sql);
    const a = await this.repo.getAgent(m.authorizedAgentId),
      now = this.clock().getTime();
    if (
      !a ||
      a.status !== "ACTIVE" ||
      a.principalId !== m.principalId ||
      now < Date.parse(a.issuedAt) ||
      now >= Date.parse(a.expiresAt) ||
      now < Date.parse(m.createdAt) ||
      now >= Date.parse(m.expiresAt) ||
      (expected !== undefined && expected !== mandateFingerprint(m))
    )
      throw new Error("DISCOVERY_AUTHORITY_UNAVAILABLE");
    return m;
  }
  async recommend(
    mandateId: string,
    query: unknown,
    ranker: CommerceRanker,
  ): Promise<DiscoverySelection> {
    return this.engine.select(
      await this.authority(mandateId),
      query,
      ranker,
      "RECOMMENDATION",
    );
  }
  async selectForCheckout(
    mandateId: string,
    query: unknown,
    ranker: CommerceRanker,
  ): Promise<string> {
    const mandate = await this.authority(mandateId),
      fingerprint = mandateFingerprint(mandate);
    const selected = await this.engine.select(
      mandate,
      query,
      ranker,
      "EXECUTABLE",
    );
    await this.authority(mandateId, fingerprint);
    const r = this.resolver.resolve(selected.candidate.offer);
    if (
      r.status !== "SUPPORTED_CHECKOUT" ||
      r.mappingFingerprint !== selected.mappingFingerprint
    )
      throw new Error("DISCOVERY_CHECKOUT_UNAVAILABLE");
    const document = storedSelection.parse({
      version: "payflow.discovery-selection.v1",
      requestId: selected.requestId,
      candidateId: selected.candidate.candidateId,
      offer: selected.candidate.offer,
      discoveryFingerprint: discoveryFingerprint(selected.candidate.offer),
      controlledOffer: r.offer,
      controlledOfferFingerprint: controlledOfferFingerprint(r.offer),
      promotionStatus: "SUPPORTED_CHECKOUT",
      mappingId: r.mappingId,
      mappingRevision: r.mappingRevision,
      mappingFingerprint: r.mappingFingerprint,
      principalId: mandate.principalId,
      mandateId,
      mandateFingerprint: fingerprint,
      quantity: selected.quantity,
      selectedAt: selected.selectedAt,
    });
    const id = randomUUID();
    await this.repo.sql.begin(async (tx) => {
      await tx`insert into commerce_discovery_selections(id,request_id,candidate_id,principal_id,mandate_id,mandate_fingerprint,document,document_hash,selected_at) values(${id},${document.requestId},${document.candidateId},${document.principalId},${mandateId},${fingerprint},${tx.json(document)},${selectionFingerprint(document)},${document.selectedAt})`;
      const [proofTable] =
        await tx`select to_regclass('discovery_ranking_material') present`;
      if (proofTable?.present) {
        const proof = RankingMaterialSchema.parse(selected.rankingProof);
        await tx`insert into discovery_ranking_material(selection_id,document,fingerprint) values(${id},${tx.json(proof)},${rankingMaterialFingerprint(proof)})`;
      }
      await this.repo.appendEvidenceInTransaction(
        tx,
        "COMMERCE_DISCOVERY_SELECTED",
        {
          selectionId: id,
          selectionFingerprint: selectionFingerprint(document),
          requestId: document.requestId,
          candidateId: document.candidateId,
          discoveryFingerprint: document.discoveryFingerprint,
          controlledOfferFingerprint: document.controlledOfferFingerprint,
          mappingFingerprint: document.mappingFingerprint,
        },
        this.clock().toISOString(),
      );
    });
    return id;
  }
  /** Never refetches discovery. Quote is issued from a freshly resolved controlled
   * handle, with the existing M4B checks. Independent callers share one quote. */
  async quoteSelection(selectionId: string) {
    z.string().uuid().parse(selectionId);
    const db = await this.repo.sql.reserve();
    let locked = false;
    try {
      await db`select pg_advisory_lock(hashtextextended(${selectionId},8))`;
      locked = true;
      const [row] =
        await db`select * from commerce_discovery_selections where id=${selectionId}`;
      if (!row) throw new Error("DISCOVERY_SELECTION_UNAVAILABLE");
      const parsed = storedSelection.safeParse(row.document);
      if (!parsed.success) throw new Error("DISCOVERY_SELECTION_CORRUPT");
      const s = parsed.data;
      if (
        row.document_hash !== selectionFingerprint(s) ||
        s.requestId !== row.request_id ||
        s.candidateId !== row.candidate_id ||
        s.principalId !== row.principal_id ||
        s.mandateId !== row.mandate_id ||
        s.mandateFingerprint !== row.mandate_fingerprint ||
        s.selectedAt !== persistedDate(row.selected_at).toISOString() ||
        discoveryFingerprint(s.offer) !== s.discoveryFingerprint ||
        controlledOfferFingerprint(s.controlledOffer) !==
          s.controlledOfferFingerprint ||
        s.candidateId !==
          createHash("sha256")
            .update(s.requestId + ":" + s.discoveryFingerprint)
            .digest("hex")
      )
        throw new Error("DISCOVERY_SELECTION_CORRUPT");
      const mandate = await this.authority(s.mandateId, s.mandateFingerprint);
      if (mandate.principalId !== s.principalId)
        throw new Error("DISCOVERY_SELECTION_CORRUPT");
      const now = this.clock().getTime();
      if (
        now < Date.parse(s.selectedAt) ||
        now < Date.parse(s.offer.observedAt) ||
        now - Date.parse(s.offer.observedAt) >=
          DISCOVERY_LIMITS.observationAgeMs
      )
        throw new Error("DISCOVERY_SELECTION_STALE");
      const resolution = this.resolver.resolve(freezeDiscovery(s.offer));
      if (
        resolution.status !== "SUPPORTED_CHECKOUT" ||
        resolution.mappingFingerprint !== s.mappingFingerprint ||
        resolution.mappingId !== s.mappingId ||
        resolution.mappingRevision !== s.mappingRevision ||
        resolution.offer.offerId !== s.controlledOffer.offerId ||
        resolution.offer.sourceId !== s.controlledOffer.sourceId
      )
        throw new Error("DISCOVERY_RELATIONSHIP_CHANGED");
      const [linked] =
        await db`select * from commerce_discovery_quote_links where selection_id=${selectionId}`;
      if (linked) {
        const quote = await this.checkout.getQuote(String(linked.quote_id));
        const [owner] =
          await db`select principal_id, mandate_id, mandate_fingerprint from commerce_quotes where id=${String(linked.quote_id)}`;
        if (
          !owner ||
          owner.principal_id !== s.principalId ||
          owner.mandate_id !== s.mandateId ||
          owner.mandate_fingerprint !== s.mandateFingerprint ||
          quote.quantity !== s.quantity ||
          quote.controlledOfferFingerprint !==
            linked.controlled_offer_fingerprint ||
          linked.mapping_fingerprint !== s.mappingFingerprint ||
          quote.offerId !== resolution.offer.offerId ||
          quote.sku !== resolution.offer.sku ||
          JSON.stringify(quote.variant) !==
            JSON.stringify(resolution.offer.variant) ||
          quote.condition !== resolution.offer.condition
        )
          throw new Error("DISCOVERY_SELECTION_CORRUPT");
        return quote;
      }
      // Observed price, merchant claim and AI explanation are never quote inputs.
      const quote = await this.checkout
        .issueQuote(resolution.offer, s.mandateId, s.quantity)
        .catch(async (error) => {
          if (error instanceof CheckoutQuoteRefusedError) {
            const [table] =
              await db`select to_regclass('commerce_quote_refusals') present`;
            if (table?.present) {
              const document = QuoteRefusalSchema.parse({
                quote: error.trustedTerms,
                offer: resolution.offer,
                reason: "AMOUNT_EXCEEDS_LIMIT",
              });
              const fingerprint = quoteRefusalFingerprint(document);
              await this.repo.sql.begin(async (tx) => {
                await tx`insert into commerce_quote_refusals(selection_id,document,fingerprint) values(${selectionId},${tx.json(document)},${fingerprint}) on conflict(selection_id) do nothing`;
              });
            }
          }
          throw error;
        });
      await this.repo.sql.begin(async (tx) => {
        await tx`insert into commerce_discovery_quote_links(selection_id,quote_id,controlled_offer_fingerprint,mapping_fingerprint,resolved_at) values(${selectionId},${quote.quoteId},${quote.controlledOfferFingerprint},${resolution.mappingFingerprint},${this.clock().toISOString()})`;
        await this.repo.appendEvidenceInTransaction(
          tx,
          "COMMERCE_DISCOVERY_RESOLVED",
          {
            selectionId,
            quoteId: quote.quoteId,
            controlledOfferFingerprint: quote.controlledOfferFingerprint,
            mappingFingerprint: resolution.mappingFingerprint,
          },
          this.clock().toISOString(),
        );
      });
      return quote;
    } finally {
      try {
        if (locked)
          await db`select pg_advisory_unlock(hashtextextended(${selectionId},8))`;
      } finally {
        db.release();
      }
    }
  }
}
