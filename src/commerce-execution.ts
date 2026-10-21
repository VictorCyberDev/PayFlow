import type { Sql } from "postgres";
import {
  CheckoutManifestSchema,
  hasCommerceMetadata,
  type CheckoutManifest,
} from "./checkout-contracts.js";
import {
  ControlledOfferSchema,
  MerchantBindingSchema,
  merchantBindingFingerprint,
} from "./commerce.js";
import { proposalDigest } from "./canonical.js";
import type { ExecutionGrantClaims } from "./execution-grant.js";
import type { PostgresTrustRepository } from "./persistence.js";

/** Reload the M4B relationship through its full corruption-checking read path.
 * No caller manifest and no independent financial authorization decision. */
export async function commerceExecutionTerms(
  repo: PostgresTrustRepository,
  db: Sql,
  grant: Pick<
    ExecutionGrantClaims,
    | "proposalId"
    | "proposalDigest"
    | "principalId"
    | "agentId"
    | "mandateId"
    | "mandateFingerprint"
    | "capability"
  >,
  freshAt?: string,
): Promise<CheckoutManifest | undefined> {
  const p = await repo.getProposal(grant.proposalId, db, true);
  if (!p || proposalDigest(p) !== grant.proposalDigest)
    throw new Error("COMMERCE_PROPOSAL_LINK_INVALID");
  // Old installations may not have migration 006. Reserved metadata must still
  // fail closed; absence of a table cannot downgrade a commerce operation.
  const tables =
    await db`select to_regclass('checkout_manifest_proposals') present`;
  const linked = tables[0]?.present
    ? await db`select m.document,q.offer_document from checkout_manifest_proposals l join checkout_manifests m on m.id=l.manifest_id join commerce_quotes q on q.id=m.quote_id where l.proposal_id=${p.id}`
    : [];
  if (!hasCommerceMetadata(p.metadata)) {
    if (linked.length) throw new Error("COMMERCE_EXECUTION_BINDING_REQUIRED");
    return undefined;
  }
  if (linked.length !== 1) throw new Error("COMMERCE_MANIFEST_MISSING");
  const m = CheckoutManifestSchema.parse(linked[0]!.document);
  const offer = ControlledOfferSchema.parse(linked[0]!.offer_document);
  if (
    m.owner.principalId !== grant.principalId ||
    m.owner.agentId !== grant.agentId ||
    m.owner.mandateId !== grant.mandateId ||
    m.owner.mandateFingerprint !== grant.mandateFingerprint ||
    grant.capability !== "CAPTURE_PAYMENT"
  )
    throw new Error("COMMERCE_PROPOSAL_LINK_INVALID");
  if (
    offer.productFamilyId !== m.productFamilyId ||
    offer.offerId !== m.offerId ||
    offer.catalogRevision !== m.catalogRevision ||
    offer.sku !== m.sku ||
    offer.condition !== m.condition ||
    JSON.stringify(offer.variant) !== JSON.stringify(m.variant) ||
    offer.unitPrice.minor !== m.unitAmountMinor ||
    offer.unitPrice.currency !== m.currency ||
    offer.availableQuantity < m.quantity
  )
    throw new Error("COMMERCE_ITEM_MISMATCH");
  // The controlled demo has zero fees. Do not invent a PayPal customer-fee field.
  if (m.customerFeeMinor !== 0)
    throw new Error("COMMERCE_PROVIDER_RESPONSE_INVALID");
  if (freshAt !== undefined) {
    const head =
      await db`select h.revision,b.*,encode(sha256(convert_to(b.document::text,'UTF8')),'hex') actual_hash from commerce_merchant_heads h join commerce_merchant_bindings b on b.merchant_id=h.merchant_id and b.revision=h.revision where h.merchant_id=${m.logicalMerchantId} for update of h`;
    if (head.length !== 1) throw new Error("COMMERCE_BINDING_STALE");
    const b = MerchantBindingSchema.parse(head[0]!.document);
    if (
      !b.active ||
      head[0]!.document_hash !== head[0]!.actual_hash ||
      head[0]!.active !== b.active ||
      head[0]!.expected_recipient !== b.expectedPayPalMerchantId ||
      head[0]!.checkout_source_id !== b.checkoutSourceId ||
      head[0]!.environment !== b.environment ||
      Number(head[0]!.revision) !== m.merchantBindingRevision ||
      merchantBindingFingerprint(b) !== m.merchantBindingFingerprint ||
      head[0]!.fingerprint !== m.merchantBindingFingerprint ||
      b.expectedPayPalMerchantId !== m.expectedPayPalMerchantId ||
      b.environment !== m.environment
    )
      throw new Error("COMMERCE_BINDING_STALE");
    const expired =
      await db`select quote_id from commerce_quote_expirations where quote_id=${m.quoteId}`;
    if (
      !Number.isFinite(Date.parse(freshAt)) ||
      Date.parse(freshAt) < Date.parse(m.quotedAt) ||
      Date.parse(freshAt) >= Date.parse(m.quoteExpiresAt) ||
      expired.length
    )
      throw new Error("COMMERCE_QUOTE_EXPIRED");
  }
  Object.freeze(m.owner);
  Object.freeze(m.variant);
  return Object.freeze(m);
}
