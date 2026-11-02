import { z } from "zod";
import { MoneySchema } from "../domain.js";
import type { CommerceRanker } from "../commerce-discovery.js";
import {
  type DelegatedCommerceService,
  type DelegatedOutcome,
} from "../delegated-commerce.js";
import type { PostgresTrustRepository } from "../persistence.js";
import { requireAgentAccess } from "./access.js";
import { GATEWAY_AUDIENCE, GatewayRequestError } from "./gateway.js";

/**
 * M7.4 — the external-agent Gateway connected to real (Sandbox) payment execution.
 *
 *   authenticated agent access
 *     -> binding to the Authority's agent and principal
 *     -> atomic replay claim
 *     -> DelegatedCommerceService (the one authoritative decision path):
 *          trusted quote -> claimed-terms check -> sealed manifest -> proposal
 *          -> Trust Kernel -> durable Reservation -> one-time signed grant
 *          -> Execution Boundary (durable revalidation) -> payment rail -> reconciliation
 *
 * This class decides nothing. It cannot widen an Authority, it never retries a provider call,
 * and it maps the existing outcome to a structured, secret-free machine response. UNKNOWN stays
 * UNKNOWN: a quarantined payment is never reported as failed and never retried.
 */
export const GatewayPurchaseRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    authority: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    action: z.literal("purchase"),
    query: z
      .object({
        text: z.string().min(1).max(200),
        quantity: z.number().int().safe().positive().max(1000),
      })
      .strict(),
    /** Amount the agent believes it is paying. Verified against the trusted quote; never trusted. */
    amount: MoneySchema,
    merchant: z.object({ id: z.string().min(1).max(128) }).strict(),
    nonce: z.string().min(16).max(128),
  })
  .strict();
export type GatewayPurchaseRequest = z.infer<
  typeof GatewayPurchaseRequestSchema
>;

export type GatewayDecision = "ALLOW" | "DENY" | "ESCALATE";
export type GatewayStatus =
  "COMPLETED" | "DENIED" | "NEEDS_APPROVAL" | "UNRESOLVED";

export interface GatewayExecutionResponse {
  readonly requestId: string;
  readonly decision: GatewayDecision;
  readonly status: GatewayStatus;
  /** Provider effects PayFlow is certain about. `null` means UNKNOWN, never "zero". */
  readonly effectCount: 0 | 1 | null;
  readonly reason?: string;
  readonly recoverable: boolean;
  readonly humanSummary: string;
  readonly nextAction: string;
  readonly doNotRetry?: true;
  /** Opaque references for the Proof surface. Contains no credentials or provider secrets. */
  readonly proof?: Readonly<{
    proposalId: string | null;
    /** Path to read the durable Proof (scope `proof:read`). Absent when no proposal exists. */
    href?: string;
    receiptId?: string;
    executionId?: string;
  }>;
}

/** Privacy-safe analytics event. Carries identifiers and outcome only: no payloads, no secrets. */
export interface GatewayEvent {
  readonly type:
    | "gateway.request_received"
    | "gateway.replay_blocked"
    | "gateway.allow"
    | "gateway.deny"
    | "gateway.executed"
    | "gateway.unknown";
  readonly at: string;
  readonly clientId: string;
  readonly authority: string;
}

export interface ExecutingGatewayDependencies {
  readonly repo: PostgresTrustRepository;
  readonly delegated: Pick<DelegatedCommerceService, "attempt">;
  readonly ranker: CommerceRanker;
  readonly now: () => string;
  readonly onEvent?: (event: GatewayEvent) => void;
}

const usd = (minor: number, currency: string): string =>
  currency === "USD"
    ? `$${(minor / 100).toLocaleString("en-US", {
        minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      })}`
    : `${(minor / 100).toFixed(2)} ${currency}`;

interface Mapped {
  readonly reason: string;
  readonly recoverable: boolean;
  readonly humanSummary: string;
  readonly nextAction: string;
}

function mapRefusal(code: string, limit: string): Mapped {
  switch (code) {
    case "AMOUNT_EXCEEDS_LIMIT":
    case "AMOUNT_EXCEEDS_AUTHORITY":
      return {
        reason: "AMOUNT_EXCEEDS_AUTHORITY",
        recoverable: true,
        humanSummary: `The price is above this Authority's ${limit} limit.`,
        nextAction: "REDUCE_AMOUNT_OR_REQUEST_APPROVAL",
      };
    case "CLAIMED_TERMS_MISMATCH":
      return {
        reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
        recoverable: true,
        humanSummary:
          "The amount or merchant in the request does not match the trusted price.",
        nextAction: "REFRESH_QUOTE_AND_RETRY_WITH_NEW_NONCE",
      };
    case "NO_ELIGIBLE_DISCOVERY_CANDIDATES":
      return {
        reason: "NO_OFFER_INSIDE_AUTHORITY",
        recoverable: true,
        humanSummary: `Nothing available fits inside this Authority (limit ${limit}). $0 moved.`,
        nextAction: "CHANGE_REQUEST_OR_REQUEST_APPROVAL",
      };
    case "DISCOVERY_AUTHORITY_UNAVAILABLE":
    case "AUTHORITY_UNAVAILABLE":
      return {
        reason: "AUTHORITY_UNAVAILABLE",
        recoverable: false,
        humanSummary:
          "This Authority isn't available right now: it may be suspended, stopped or expired. $0 moved.",
        nextAction: "ASK_OWNER_TO_REVIEW_AUTHORITY",
      };
    case "MANDATE_REVOKED":
    case "PRINCIPAL_INACTIVE":
      return {
        reason: "AUTHORITY_REVOKED",
        recoverable: false,
        humanSummary: "This Authority was stopped.",
        nextAction: "ASK_OWNER_FOR_NEW_AUTHORITY",
      };
    case "PAYMENT_RAIL_NOT_CONNECTED":
      return {
        reason: "PAYMENT_RAIL_NOT_CONNECTED",
        recoverable: true,
        humanSummary: "No payment method is connected to this Authority yet.",
        nextAction: "ASK_OWNER_TO_CONNECT_PAYMENT_METHOD",
      };
    default:
      return {
        reason: /^[A-Z0-9_]{3,96}$/.test(code) ? code : "REQUEST_REFUSED",
        recoverable: false,
        humanSummary:
          "The current Authority does not allow this request. $0 moved.",
        nextAction: "STOP_AND_REPORT_TO_OWNER",
      };
  }
}

export class ExecutingGateway {
  constructor(private readonly deps: ExecutingGatewayDependencies) {}

  async requestPurchase(
    rawAccess: unknown,
    rawRequest: unknown,
  ): Promise<GatewayExecutionResponse> {
    const { repo, delegated, ranker, now, onEvent } = this.deps;
    const at = now();
    const access = requireAgentAccess(
      rawAccess,
      "action:request",
      at,
      GATEWAY_AUDIENCE,
    );
    const parsed = GatewayPurchaseRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new GatewayRequestError("REQUEST_MALFORMED");
    const request = parsed.data;
    const requestId = request.requestId ?? `req_${crypto.randomUUID()}`;

    // The access credential is bound to exactly one agent and principal. The Authority must
    // belong to that same pair; the caller cannot name a different agent or Authority owner.
    const mandate = await repo.getMandate(request.authority);
    if (!mandate) throw new GatewayRequestError("AUTHORITY_NOT_FOUND");
    if (
      access.agentId !== request.agentId ||
      mandate.authorizedAgentId !== request.agentId
    )
      throw new GatewayRequestError("ACCESS_AGENT_MISMATCH");
    if (access.principalId !== mandate.principalId)
      throw new GatewayRequestError("ACCESS_PRINCIPAL_MISMATCH");

    const emit = (type: GatewayEvent["type"]) =>
      onEvent?.({
        type,
        at: now(),
        clientId: access.clientId,
        authority: mandate.id,
      });
    emit("gateway.request_received");
    const limit = usd(mandate.maxSingleTransactionMinor, mandate.currency);

    // Atomic. The first presentation of a nonce wins; every replay is a zero-effect DENY.
    const first = await repo.claimReplay(
      `gateway-purchase:${mandate.id}:${request.agentId}`,
      request.nonce,
    );
    if (!first) {
      emit("gateway.replay_blocked");
      return deny(requestId, {
        reason: "REPLAY_DETECTED",
        recoverable: true,
        humanSummary: "This request was already received. $0 moved again.",
        nextAction: "USE_NEW_NONCE_FOR_A_NEW_REQUEST",
      });
    }

    const outcome: DelegatedOutcome = await delegated.attempt({
      mandateId: mandate.id,
      query: request.query,
      ranker,
      expected: {
        totalMinor: request.amount.minor,
        currency: request.amount.currency,
        merchantId: request.merchant.id,
      },
    });
    const presented = this.present(requestId, outcome, limit);
    const response: GatewayExecutionResponse = presented.proof?.proposalId
      ? Object.freeze({
          ...presented,
          proof: Object.freeze({
            ...presented.proof,
            href: `/v1/proofs/${encodeURIComponent(presented.proof.proposalId)}`,
          }),
        })
      : presented;
    emit(
      response.status === "COMPLETED"
        ? "gateway.executed"
        : response.status === "UNRESOLVED"
          ? "gateway.unknown"
          : response.decision === "ALLOW"
            ? "gateway.allow"
            : "gateway.deny",
    );
    return response;
  }

  private present(
    requestId: string,
    outcome: DelegatedOutcome,
    limit: string,
  ): GatewayExecutionResponse {
    switch (outcome.status) {
      case "COMPLETED":
        return Object.freeze({
          requestId,
          decision: "ALLOW",
          status: "COMPLETED",
          effectCount: 1,
          recoverable: false,
          humanSummary: "Paid once inside your Authority.",
          nextAction: "INSPECT_PROOF",
          proof: {
            proposalId: outcome.proposalId,
            receiptId: outcome.receiptId,
            executionId: outcome.executionId,
          },
        });
      case "DENIED": {
        const m = mapRefusal(outcome.reasonCodes[0] ?? "", limit);
        return deny(requestId, m, {
          proposalId: outcome.proposalId,
          receiptId: outcome.receiptId,
        });
      }
      case "NEEDS_HUMAN":
        return Object.freeze({
          requestId,
          decision: "ESCALATE",
          status: "NEEDS_APPROVAL",
          effectCount: 0,
          reason: "APPROVAL_REQUIRED",
          recoverable: true,
          humanSummary:
            "This is above what the agent may do alone. Your decision is needed. $0 moved.",
          nextAction: "WAIT_FOR_OWNER_DECISION",
          proof: {
            proposalId: outcome.proposalId,
            receiptId: outcome.receiptId,
          },
        });
      case "UNRESOLVED":
        return Object.freeze({
          requestId,
          decision: "ALLOW",
          status: "UNRESOLVED",
          effectCount: null,
          reason: outcome.code,
          recoverable: false,
          doNotRetry: true as const,
          humanSummary: "We're confirming whether money moved.",
          nextAction: "DO_NOT_RETRY_WAIT_FOR_RECONCILIATION",
          proof: {
            proposalId: outcome.proposalId,
            receiptId: outcome.receiptId,
          },
        });
      case "REFUSED":
        return deny(requestId, mapRefusal(outcome.code, limit), {
          proposalId: outcome.proposalId,
        });
    }
  }
}

function deny(
  requestId: string,
  m: Mapped,
  proof?: GatewayExecutionResponse["proof"],
): GatewayExecutionResponse {
  return Object.freeze({
    requestId,
    decision: "DENY",
    status: "DENIED",
    effectCount: 0,
    reason: m.reason,
    recoverable: m.recoverable,
    humanSummary: m.humanSummary,
    nextAction: m.nextAction,
    ...(proof ? { proof } : {}),
  });
}
