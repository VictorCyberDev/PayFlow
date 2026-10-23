import type { DecisionReceipt } from "./domain.js";
import type { DurableCheckoutService } from "./checkout.js";
import type { DiscoveryCheckoutService } from "./discovery-checkout.js";
import type { CommerceRanker } from "./commerce-discovery.js";
import type { DurableAuthorizationService } from "./durable-service.js";
import type {
  ExecutionBoundary,
  ExecutionGrantIssuer,
} from "./execution-grant.js";
import {
  ExecutionQuarantinedError,
  ExecutionRejectedError,
} from "./execution-outcome.js";

/**
 * M6 — delegated / human-not-present commerce.
 *
 * This is composition, not a policy engine. A human has already created and authenticated a
 * Mandate that may allow an eligible request without another confirmation (the Mandate's
 * autonomous purchase threshold). Delegation is exactly the existing kernel decision ALLOW:
 *
 *   selection -> quote -> manifest -> proposal -> authorizeProposal (kernel + durable reservation)
 *   -> one-time signed grant -> ExecutionBoundary (immediate durable revalidation) -> PayPal rail
 *
 * Nothing here decides, widens, retries or simulates financial authority. The service only
 * (1) refuses to issue a grant unless the existing kernel returned ALLOW, (2) never asks a human,
 * (3) never retries a provider call, and (4) returns a bounded, secret-free outcome.
 */
export type DelegatedOutcome =
  | Readonly<{
      status: "COMPLETED";
      proposalId: string;
      operationId: string;
      receiptId: string;
      executionId: string;
      askedHuman: false;
      providerEffect: "CAPTURED";
    }>
  | Readonly<{
      status: "DENIED";
      proposalId: string;
      operationId: string;
      receiptId: string;
      reasonCodes: readonly string[];
      askedHuman: false;
      providerEffect: "NONE";
    }>
  | Readonly<{
      /** Above the autonomous threshold: delegation does not apply; no reservation, grant or capture. */
      status: "NEEDS_HUMAN";
      proposalId: string;
      operationId: string;
      receiptId: string;
      askedHuman: false;
      providerEffect: "NONE";
    }>
  | Readonly<{
      /** Refused before any financial dispatch (no eligible offer, quote refusal, authority unavailable). */
      status: "REFUSED";
      code: string;
      proposalId: string | null;
      /** The proposal, or the selection for a refusal that happened before any proposal existed. */
      operationId: string | null;
      askedHuman: false;
      providerEffect: "NONE";
    }>
  | Readonly<{
      /** The provider may have acted. Quarantined and reconciled by the existing rail; never retried. */
      status: "UNRESOLVED";
      proposalId: string;
      operationId: string;
      receiptId: string;
      code: string;
      askedHuman: false;
      providerEffect: "UNKNOWN";
    }>;

/** The only methods the orchestrator needs. Narrow on purpose: it cannot reach anything else. */
export type DelegatedDiscovery = Pick<
  DiscoveryCheckoutService,
  "selectForCheckout" | "quoteSelection"
>;
export type DelegatedCheckout = Pick<
  DurableCheckoutService,
  "sealManifest" | "compileManifestProposal"
>;

export interface DelegatedAttemptInput {
  readonly mandateId: string;
  readonly query: unknown;
  readonly ranker: CommerceRanker;
}

const safeCode = (error: unknown, fallback: string): string => {
  const m = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,96}$/.test(m) ? m : fallback;
};

export class DelegatedCommerceService {
  constructor(
    private readonly deps: Readonly<{
      discovery: DelegatedDiscovery;
      checkout: DelegatedCheckout;
      authorizer: DurableAuthorizationService;
      issuer: ExecutionGrantIssuer;
      boundary: ExecutionBoundary;
      merchantRisk: "LOW" | "MEDIUM" | "HIGH";
      clock: () => string;
    }>,
  ) {}

  async attempt(input: DelegatedAttemptInput): Promise<DelegatedOutcome> {
    const { discovery, checkout, authorizer, issuer, boundary } = this.deps;
    let proposalId: string | null = null;
    let selectionId: string | null = null;
    // 1. Untrusted selection -> trusted quote -> sealed manifest -> proposal. Any refusal here
    //    happens before authorization and therefore before any reservation, grant or provider call.
    try {
      selectionId = await discovery.selectForCheckout(
        input.mandateId,
        input.query,
        input.ranker,
      );
      const quote = await discovery.quoteSelection(selectionId);
      const manifest = await checkout.sealManifest(quote.quoteId);
      const proposal = await checkout.compileManifestProposal(
        manifest.manifestId,
      );
      proposalId = proposal.id;
    } catch (error) {
      return refused(
        safeCode(error, "DELEGATED_REQUEST_REFUSED"),
        proposalId,
        selectionId,
      );
    }
    // 2. The existing deterministic kernel decides. Authority being unavailable (revoked, expired,
    //    suspended, principal disabled) is a refusal with zero provider effect.
    let receipt: DecisionReceipt, reservationId: string | null;
    try {
      const authorized = await authorizer.authorizeProposal(
        proposalId,
        this.deps.merchantRisk,
        this.deps.clock(),
      );
      receipt = authorized.receipt;
      reservationId = authorized.reservation?.id ?? null;
    } catch (error) {
      return refused(
        safeCode(error, "AUTHORITY_UNAVAILABLE"),
        proposalId,
        selectionId,
      );
    }
    if (receipt.decision === "DENY")
      return Object.freeze({
        status: "DENIED",
        proposalId,
        operationId: proposalId,
        receiptId: receipt.receiptId,
        reasonCodes: Object.freeze([...receipt.reasonCodes]),
        askedHuman: false,
        providerEffect: "NONE",
      } as const);
    if (receipt.decision !== "ALLOW" || reservationId === null)
      return Object.freeze({
        status: "NEEDS_HUMAN",
        proposalId,
        operationId: proposalId,
        receiptId: receipt.receiptId,
        askedHuman: false,
        providerEffect: "NONE",
      } as const);
    // 3. Delegated execution: one-time signed grant, then the ordinary boundary, which re-validates
    //    Mandate, Agent, Principal, quote and commerce binding under durable locks immediately
    //    before the rail may dispatch.
    let token: string;
    try {
      token = await issuer.issue(reservationId, this.deps.clock());
    } catch (error) {
      return refused(
        safeCode(error, "GRANT_UNAVAILABLE"),
        proposalId,
        selectionId,
      );
    }
    try {
      const done = await boundary.execute(token, this.deps.clock());
      return Object.freeze({
        status: "COMPLETED",
        proposalId,
        operationId: proposalId,
        receiptId: receipt.receiptId,
        executionId: done.executionId,
        askedHuman: false,
        providerEffect: "CAPTURED",
      } as const);
    } catch (error) {
      if (error instanceof ExecutionQuarantinedError)
        return Object.freeze({
          status: "UNRESOLVED",
          proposalId,
          operationId: proposalId,
          receiptId: receipt.receiptId,
          code: safeCode(error, "PAYMENT_REQUIRES_INVESTIGATION"),
          askedHuman: false,
          providerEffect: "UNKNOWN",
        } as const);
      // Revalidation failed or the rail proved no effect. Never retried here.
      return refused(
        error instanceof ExecutionRejectedError
          ? safeCode(error, "EXECUTION_REJECTED")
          : safeCode(error, "EXECUTION_REFUSED"),
        proposalId,
        selectionId,
      );
    }
  }
}

function refused(
  code: string,
  proposalId: string | null,
  selectionId: string | null,
): DelegatedOutcome {
  return Object.freeze({
    status: "REFUSED",
    code,
    proposalId,
    operationId: proposalId ?? selectionId,
    askedHuman: false,
    providerEffect: "NONE",
  } as const);
}
