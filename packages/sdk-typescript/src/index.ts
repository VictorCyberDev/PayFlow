export interface PayFlowClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** References to the durable Proof for an operation. Contains no credentials. */
export interface ProofReference {
  readonly proposalId: string | null;
  /** Path to read the Proof with `proofs.get`. */
  readonly href?: string;
  readonly receiptId?: string;
  readonly executionId?: string;
}

interface ExecuteBase {
  readonly requestId: string;
  readonly humanSummary: string;
  readonly nextAction: string;
  readonly proof?: ProofReference;
}

/** Paid exactly once. */
export interface ExecuteCompleted extends ExecuteBase {
  readonly status: "COMPLETED";
  readonly decision: "ALLOW";
  readonly effectCount: 1;
}
/** Refused before any money moved. Read `reason`, `recoverable` and `nextAction`. */
export interface ExecuteDenied extends ExecuteBase {
  readonly status: "DENIED";
  readonly decision: "DENY";
  readonly effectCount: 0;
  readonly reason: string;
  readonly recoverable: boolean;
}
/** Above what the agent may do alone. Nothing moved; a human decides. */
export interface ExecuteNeedsApproval extends ExecuteBase {
  readonly status: "NEEDS_APPROVAL";
  readonly decision: "ESCALATE";
  readonly effectCount: 0;
  readonly reason: string;
}
/**
 * PayFlow cannot yet say whether money moved. `effectCount` is null, never 0.
 * Do not retry: PayFlow is confirming with the provider. Read the Proof later.
 */
export interface ExecuteUnresolved extends ExecuteBase {
  readonly status: "UNRESOLVED";
  readonly decision: "ALLOW";
  readonly effectCount: null;
  readonly reason?: string;
  readonly doNotRetry: true;
}
/** The request was refused at the door (bad credential, scope or shape). $0 moved. */
export interface ExecuteRejected extends ExecuteBase {
  readonly status: "REJECTED";
  readonly decision: "DENY";
  readonly effectCount: 0;
  readonly httpStatus: number;
  readonly reason: string;
  readonly recoverable: boolean;
}
/** Transport or server failure after the request may have been accepted. Effect unknown. */
export interface ExecuteIndeterminate extends ExecuteBase {
  readonly status: "INDETERMINATE";
  readonly decision: "UNKNOWN";
  readonly effectCount: null;
  readonly reason: string;
  readonly doNotRetry: true;
}
export type ExecuteResult =
  | ExecuteCompleted
  | ExecuteDenied
  | ExecuteNeedsApproval
  | ExecuteUnresolved
  | ExecuteRejected
  | ExecuteIndeterminate;

export interface ExecuteInput {
  /** Authority id. */
  readonly authority: string;
  /** The agent this credential acts for. */
  readonly agent: string;
  /** What to buy. Resolved against the merchant's trusted catalog. */
  readonly item: string;
  readonly quantity?: number;
  /** Amount in minor units (cents). Checked against the trusted price; never trusted. */
  readonly amount: number;
  readonly currency: string;
  readonly merchant: string;
  /**
   * Idempotency key. Reuse the same nonce to retry the SAME logical request; a repeat is denied
   * with REPLAY_DETECTED and never pays twice. Generated when omitted.
   */
  readonly nonce?: string;
  readonly requestId?: string;
}

const newNonce = (): string => `nonce_${crypto.randomUUID()}`;

const indeterminate = (
  reason: string,
  summary: string,
): ExecuteIndeterminate => ({
  requestId: "unknown",
  status: "INDETERMINATE",
  decision: "UNKNOWN",
  effectCount: null,
  reason,
  doNotRetry: true,
  humanSummary: summary,
  nextAction: "DO_NOT_RETRY_CHECK_PROOF",
});

export class PayFlowClient {
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: PayFlowClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
  }

  readonly actions = {
    /**
     * Ask PayFlow to perform a bounded purchase. Never throws for a PayFlow outcome:
     * switch on `result.status`. The Authority, not the caller, decides what is allowed.
     */
    execute: async (input: ExecuteInput): Promise<ExecuteResult> => {
      const body = {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        authority: input.authority,
        agentId: input.agent,
        action: "purchase",
        query: { text: input.item, quantity: input.quantity ?? 1 },
        amount: { minor: input.amount, currency: input.currency },
        merchant: { id: input.merchant },
        nonce: input.nonce ?? newNonce(),
      };
      let response: Response;
      try {
        response = await this.request(
          new URL("/v1/actions/execute", this.options.baseUrl),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
          },
        );
      } catch {
        // The request may have reached PayFlow. Never claim zero effect.
        return indeterminate(
          "TRANSPORT_FAILURE",
          "We couldn't confirm the result. Don't retry yet; check the Proof.",
        );
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        return indeterminate(
          "UNREADABLE_RESPONSE",
          "We couldn't read the result. Don't retry yet; check the Proof.",
        );
      }
      if (response.status === 200) return parsed as unknown as ExecuteResult;
      if ([400, 401, 403, 404].includes(response.status))
        return {
          ...(parsed as object),
          status: "REJECTED",
          decision: "DENY",
          effectCount: 0,
          httpStatus: response.status,
        } as ExecuteRejected;
      const text = (value: unknown, fallback: string): string =>
        typeof value === "string" ? value : fallback;
      return indeterminate(
        text(parsed.reason, "SERVER_ERROR"),
        text(
          parsed.humanSummary,
          "We're confirming whether money moved. Don't retry yet.",
        ),
      );
    },
  };

  readonly proofs = {
    /** Read the durable Proof for an operation this credential's agent owns. */
    get: async (proposalId: string): Promise<unknown> =>
      this.json(`/v1/proofs/${encodeURIComponent(proposalId)}`, {
        method: "GET",
      }),
  };

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      authorization: `Bearer ${this.options.accessToken}`,
      "content-type": "application/json",
      ...(extra as Record<string, string> | undefined),
    };
  }

  async readAuthority(authorityId: string): Promise<unknown> {
    return this.json(`/v1/authorities/${encodeURIComponent(authorityId)}`, {
      method: "GET",
    });
  }

  async requestAuthorizedAction(action: unknown): Promise<unknown> {
    return this.json("/v1/actions", {
      method: "POST",
      body: JSON.stringify(action),
    });
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const error = new Error(
        `PayFlow API request failed with ${response.status}`,
      );
      Object.assign(error, { status: response.status, body });
      throw error;
    }
    return body;
  }
}
