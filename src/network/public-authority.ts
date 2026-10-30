import type { Mandate } from "../domain.js";
import type { AuthorityLifecycleState } from "./verify.js";

/**
 * Projects an internal Mandate onto the public, transport-neutral
 * Financial Authority Schema v1 (spec/financial-authority-v1.schema.json).
 * The projection is lossy by design: it never exposes the internal
 * fingerprint, nonce or approval thresholds. A conforming document remains
 * untrusted input for any verifier until signature, status and conditions
 * are evaluated.
 */
export function toPublicAuthorityDocument(
  mandate: Mandate,
  state: AuthorityLifecycleState,
  options: { now: string; organizationId?: string; proofReference?: string },
) {
  const expired = Date.parse(options.now) >= Date.parse(mandate.expiresAt);
  return {
    version: "financial-authority/v1" as const,
    authorityId: mandate.id,
    principal: {
      id: mandate.principalId,
      ...(options.organizationId === undefined
        ? {}
        : { organizationId: options.organizationId }),
    },
    agent: { id: mandate.authorizedAgentId },
    scope: {
      actions: [...mandate.allowedCapabilities].sort(),
      currencies: [mandate.currency],
      maxAmountMinor: mandate.maxSingleTransactionMinor,
      counterparties:
        mandate.merchantScope?.mode === "ONLY"
          ? [...mandate.merchantScope.ids].sort()
          : [],
      conditions: {
        category: mandate.category,
        allowedConditions: [...mandate.allowedConditions].sort(),
        merchantRiskCeiling: mandate.merchantRiskCeiling,
        ...(mandate.quantityLimit === undefined
          ? {}
          : { quantityLimit: mandate.quantityLimit }),
      },
    },
    validity: {
      issuedAt: mandate.createdAt,
      expiresAt: mandate.expiresAt,
      status: state === "ACTIVE" && expired ? ("EXPIRED" as const) : state,
    },
    execution: {
      runtimeRevalidation: true as const,
      oneTimeGrant: true as const,
      idempotency: true as const,
      railIndependent: true,
    },
    proof: {
      required: true as const,
      ...(options.proofReference === undefined
        ? {}
        : { reference: options.proofReference }),
    },
  };
}
