import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HumanConfirmationBoundary,
  IntentActivationService,
  reviewHash,
  type HumanActionBinding,
} from "./intent-activation.js";
import { interpretIntent, type IntentModelProvider } from "./intent-model.js";
import type { IntentCompileContext, MandateDraft } from "./intent.js";
import type { PostgresTrustRepository } from "./persistence.js";
import { AuthorityViewService } from "./authority-projection.js";
import { PostgresAuthorityViewReader } from "./authority-postgres.js";
import type { ConsoleSessions } from "./console-session.js";
import { type ConsoleRequest } from "./console-session.js";
const term = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(2000),
  })
  .strict();
export const PendingAuthoritySchema = z
  .object({
    status: z.literal("PENDING_REVIEW"),
    authority: z.literal("NOT_YET_AUTHORIZED"),
    mode: z.literal("NON_PRODUCTION_DEMO"),
    reviewId: z.string().max(128),
    displayHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().max(2000),
    agentName: z.string().max(120),
    expiresAt: z.string().datetime(),
    terms: z.array(term).max(12),
  })
  .strict();
type PendingAuthority = z.infer<typeof PendingAuthoritySchema>;
type Pending = {
  owner: object;
  view: PendingAuthority;
  request: {
    action: "CONFIRM_EXACT_TERMS";
    reviewId: string;
    agentId: string;
    draftFingerprint: string;
    reviewedHash: string;
    challenge: string;
  };
};
/** Host orchestration only. Every durable creation/confirmation delegates to M3C. */
export class ConsoleActivation {
  readonly #pending = new Map<string, Pending>();
  #preparing = 0;
  readonly #boundary: HumanConfirmationBoundary;
  readonly #activation: IntentActivationService;
  readonly #authority: AuthorityViewService;
  constructor(
    private readonly repo: PostgresTrustRepository,
    readonly sessions: ConsoleSessions,
    private readonly config: {
      agentId: string;
      provider: IntentModelProvider;
      bounds: (now: Date) => IntentCompileContext["reviewBounds"];
    },
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#boundary = new HumanConfirmationBoundary(sessions, clock);
    this.#activation = new IntentActivationService(repo, this.#boundary, clock);
    this.#authority = new AuthorityViewService(
      sessions,
      new PostgresAuthorityViewReader(repo, clock),
    );
  }
  async prepare(req: ConsoleRequest, raw: unknown): Promise<PendingAuthority> {
    const owner = this.sessions.mutation(req);
    for (const [id, p] of this.#pending)
      if (Date.parse(p.view.expiresAt) <= this.clock().getTime())
        this.#pending.delete(id);
    if (this.#pending.size + this.#preparing >= 128)
      throw new Error("REVIEW_LIMIT");
    this.#preparing++;
    try {
      const request = z
        .object({ source: z.string().min(1).max(2000) })
        .strict()
        .parse(raw);
      const context: IntentCompileContext = {
        source: { reference: randomUUID(), text: request.source },
        now: this.clock().toISOString(),
        reviewBounds: this.config.bounds(this.clock()),
      };
      // The injected provider is still untrusted and has no identity, auth or DB capability.
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await (async () => {
        try {
          return await Promise.race([
            interpretIntent(this.config.provider, context, abort.signal),
            new Promise<{ status: "MODEL_TIMEOUT" }>((resolve) => {
              timer = setTimeout(() => {
                abort.abort();
                resolve({ status: "MODEL_TIMEOUT" });
              }, 15000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      if (
        result.status !== "INTERPRETED" ||
        result.compilation.status !== "VALID_DRAFT"
      )
        throw new Error("REVIEW_NOT_VALID");
      const binding: HumanActionBinding = {
        action: "CREATE_INTENT_REVIEW",
        agentId: this.config.agentId,
      };
      const authenticated = await this.#boundary.authenticate(
        this.sessions.seal(req, binding),
        binding,
      );
      const r = await this.#activation.createReview(
        authenticated,
        this.config.agentId,
        result.compilation.draft.provenance.interpretation,
        context,
      );
      if (r.draftFingerprint !== result.compilation.draft.fingerprint)
        throw new Error("REVIEW_NOT_VALID");
      const agent = await this.repo.getAgent(
        this.config.agentId,
        undefined,
        false,
      );
      if (!agent) throw new Error("REVIEW_NOT_VALID");
      const draft = r.draft as MandateDraft,
        t = draft.proposedMandateTerms;
      const money = (n: number) =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: t.currency,
        }).format(n / (t.currency === "JPY" ? 1 : 100));
      const capabilities: Record<string, string> = {
        SEARCH_PRODUCTS: "Find products",
        EVALUATE_PRODUCTS: "Compare products",
        CREATE_ORDER: "Create purchase orders",
        CAPTURE_PAYMENT: "Pay for purchases",
        REQUEST_REFUND: "Request refunds",
        CREATE_SUBSCRIPTION: "Create subscriptions",
        OPEN_DISPUTE: "Open disputes",
      };
      const display = {
        status: "PENDING_REVIEW" as const,
        authority: "NOT_YET_AUTHORIZED" as const,
        mode: "NON_PRODUCTION_DEMO" as const,
        reviewId: r.reviewId,
        source: request.source,
        agentName: agent.displayName,
        expiresAt: r.expiresAt,
        terms: [
          { label: "Purpose", value: t.purpose },
          { label: "Maximum spend", value: money(t.maxSingleTransactionMinor) },
          { label: "Cumulative limit", value: money(t.cumulativeLimitMinor) },
          { label: "Quantity", value: String(draft.quantity) },
          {
            label: "Merchants",
            value:
              draft.merchants.mode === "ONLY"
                ? `Only ${draft.merchants.ids.join(", ")}`
                : "Any merchant, subject to existing policy",
          },
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
            label: "Capabilities",
            value: t.allowedCapabilities.map((v) => capabilities[v]).join(", "),
          },
          {
            label: "Without asking again",
            value: `Up to ${money(t.autonomousPurchaseThresholdMinor)}`,
          },
          {
            label: "Human approval threshold",
            value: money(t.humanApprovalThresholdMinor),
          },
          { label: "Authority expires", value: t.expiresAt },
        ],
      };
      const view = PendingAuthoritySchema.parse({
        ...display,
        displayHash: reviewHash(display),
      });
      this.#pending.set(r.reviewId, {
        owner,
        view,
        request: {
          action: "CONFIRM_EXACT_TERMS",
          reviewId: r.reviewId,
          agentId: this.config.agentId,
          draftFingerprint: r.draftFingerprint,
          reviewedHash: r.reviewedHash,
          challenge: r.challenge,
        },
      });
      return view;
    } finally {
      this.#preparing--;
    }
  }
  async confirm(
    req: ConsoleRequest,
    raw: unknown,
  ): Promise<
    { status: "ACTIVATED"; mandateId: string } | { status: "REJECTED" }
  > {
    const owner = this.sessions.mutation(req);
    const q = z
      .object({
        action: z.literal("CONFIRM_EXACT_TERMS"),
        reviewId: z.string().min(1).max(128),
        displayHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(raw);
    const p = this.#pending.get(q.reviewId);
    if (
      !p ||
      !this.sessions.sameSession(owner, p.owner) ||
      p.view.displayHash !== q.displayHash
    )
      return { status: "REJECTED" };
    const { challenge, ...rest } = p.request;
    const binding = { ...rest, challengeHash: reviewHash(challenge) };
    const result = await this.#activation.confirmReviewedIntent(
      p.request,
      this.sessions.seal(req, binding),
    );
    return result.status === "ACTIVATED"
      ? { status: "ACTIVATED", mandateId: result.mandate.id }
      : { status: "REJECTED" };
  }
  async authority(req: ConsoleRequest, raw: unknown) {
    return this.#authority.read(this.sessions.read(req), raw);
  }
}
