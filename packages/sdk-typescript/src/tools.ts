import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecuteResult, PayFlowClient } from "./index.js";

/**
 * Framework-neutral PayFlow tools. Every framework adapter wraps THESE specs and nothing else, so the same request
 * reaches the same Gateway decision path whichever framework the agent runs in. The adapters add no policy, no
 * retries and no second opinion.
 *
 * What the model may choose is deliberately small: what to buy, how many, the amount it believes it is paying, the
 * currency and the merchant. The Authority id and the agent id are fixed by the developer in `PayFlowToolkitConfig`;
 * the model can never name another Authority or act as another agent.
 */
export interface PayFlowToolkitConfig {
  readonly client: PayFlowClient;
  /** The Authority these tools act under. Fixed by the developer, never by the model. */
  readonly authority: string;
  /** The agent the credential acts for. */
  readonly agent: string;
}

/** The one shape every framework returns to its model, so outcomes can be compared across frameworks. */
export interface ToolOutcome {
  readonly decision: "ALLOW" | "DENY" | "ESCALATE" | "UNKNOWN";
  readonly status: string;
  /** 1 = paid once, 0 = nothing moved, null = UNKNOWN. Never 0 when the truth is unknown. */
  readonly effectCount: 0 | 1 | null;
  readonly reason?: string;
  readonly humanSummary: string;
  readonly nextAction: string;
  readonly doNotRetry?: true;
  readonly proposalId?: string;
}

export const PurchaseArgsSchema = z
  .object({
    item: z.string().min(1).max(200).describe("What to buy, in plain words."),
    quantity: z.number().int().positive().max(1000).optional(),
    amount: z
      .number()
      .int()
      .positive()
      .describe("Amount in minor units (cents) the agent expects to pay."),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    merchant: z.string().min(1).max(128),
  })
  .strict();
export type PurchaseArgs = z.infer<typeof PurchaseArgsSchema>;

export const VerifyProofArgsSchema = z
  .object({
    proof: z
      .record(z.string(), z.unknown())
      .describe("A signed PayFlow Proof object."),
  })
  .strict();
export type VerifyProofArgs = z.infer<typeof VerifyProofArgsSchema>;

export interface ToolRunContext {
  /**
   * The framework's own id for THIS tool call (OpenAI call_id, Anthropic tool_use id, LangChain/AI SDK toolCallId).
   * It becomes the idempotency key: a framework retrying the same call can never pay twice.
   */
  readonly callId?: string | undefined;
}

export interface PayFlowToolSpec<S extends z.ZodType> {
  readonly name: "payflow_purchase" | "payflow_verify_proof";
  readonly description: string;
  readonly schema: S;
  readonly run: (
    args: z.infer<S>,
    context: ToolRunContext,
  ) => Promise<ToolOutcome>;
}

export const toOutcome = (result: ExecuteResult): ToolOutcome => ({
  decision: result.decision,
  status: result.status,
  effectCount: result.effectCount,
  ...("reason" in result && result.reason ? { reason: result.reason } : {}),
  humanSummary: result.humanSummary,
  nextAction: result.nextAction,
  ...("doNotRetry" in result && result.doNotRetry
    ? { doNotRetry: true as const }
    : {}),
  ...(result.proof?.proposalId ? { proposalId: result.proof.proposalId } : {}),
});

/** Deterministic per tool call, so the same call id always means the same logical request. */
export function nonceForCall(
  config: Pick<PayFlowToolkitConfig, "authority" | "agent">,
  callId: string | undefined,
): string {
  if (!callId) return `nonce_${randomUUID()}`;
  const digest = createHash("sha256")
    .update(
      `payflow-tool-call\0${config.authority}\0${config.agent}\0${callId}`,
    )
    .digest("hex")
    .slice(0, 40);
  return `call_${digest}`;
}

export function createPayFlowToolkit(config: PayFlowToolkitConfig) {
  const purchase: PayFlowToolSpec<typeof PurchaseArgsSchema> = {
    name: "payflow_purchase",
    description:
      "Buy one item within the spending Authority this agent has been given. PayFlow decides; this tool cannot raise the limit. A refusal moves $0. If the result says the outcome is UNKNOWN, do not retry: check the Proof.",
    schema: PurchaseArgsSchema,
    run: async (args, context) =>
      toOutcome(
        await config.client.actions.execute({
          authority: config.authority,
          agent: config.agent,
          item: args.item,
          ...(args.quantity === undefined ? {} : { quantity: args.quantity }),
          amount: args.amount,
          currency: args.currency,
          merchant: args.merchant,
          nonce: nonceForCall(config, context.callId),
        }),
      ),
  };
  const verifyProof: PayFlowToolSpec<typeof VerifyProofArgsSchema> = {
    name: "payflow_verify_proof",
    description:
      "Check a signed PayFlow Proof and say whether it is authentic and what it shows about whether money moved. Read-only.",
    schema: VerifyProofArgsSchema,
    run: async (args) => {
      const verdict = await config.client.proofs.verify(args.proof);
      // An unverified Proof says nothing about what happened, so its effect is UNKNOWN, never 0.
      return {
        decision: verdict.verified ? "ALLOW" : "UNKNOWN",
        status: verdict.verified ? "PROOF_VERIFIED" : "PROOF_NOT_VERIFIED",
        effectCount:
          verdict.verified && verdict.proof ? verdict.proof.effectCount : null,
        reason: verdict.reason,
        humanSummary: verdict.summary.join(" "),
        nextAction: verdict.verified ? "NONE" : "DO_NOT_RELY_ON_THIS_PROOF",
      };
    },
  };
  return { purchase, verifyProof, all: [purchase, verifyProof] as const };
}
export type PayFlowToolkit = ReturnType<typeof createPayFlowToolkit>;

/** What a model sees. Plain JSON so every framework presents the same text. */
export const toModelText = (outcome: ToolOutcome): string =>
  JSON.stringify(outcome);
