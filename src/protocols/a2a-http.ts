import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createPayFlowAgentCard,
  evaluateDelegatedRequest,
  type DelegatedFinancialScope,
  type DelegationReplayStore,
} from "./a2a.js";
import {
  invokePayFlowMcpTool,
  PAYFLOW_MCP_TOOLS,
  type McpAuthorityServices,
  type PayFlowMcpToolName,
} from "./mcp.js";
import type { ProtocolAuthenticator, ProtocolIdentity } from "./http-auth.js";
import { readBoundedJson } from "./mcp-http.js";
import { McpToolError } from "./mcp.js";
import type { DelegationSpend, ReserveRefusal } from "../network/delegation.js";

const command = z
  .object({
    tool: z.enum(
      PAYFLOW_MCP_TOOLS.map((t) => t.name) as [
        PayFlowMcpToolName,
        ...PayFlowMcpToolName[],
      ],
    ),
    arguments: z.record(z.string(), z.unknown()),
    delegation: z.unknown().optional(),
  })
  .strict();
const send = z
  .object({
    message: z
      .object({
        messageId: z.string().min(1).max(128),
        role: z.literal("ROLE_USER"),
        parts: z
          .array(z.object({ data: z.record(z.string(), z.unknown()) }).strict())
          .length(1),
      })
      .strict(),
  })
  .strict();

/** The durable delegation ledger the handler needs. `PostgresDelegationRegistry` implements it. */
export interface DelegationLedger {
  reserve(
    leafId: string,
    spend: DelegationSpend,
  ): Promise<{ ok: true } | { ok: false; reason: ReserveRefusal }>;
  release(leafId: string, amountMinor: number): Promise<void>;
}

const delegationRef = z
  .object({ delegationId: z.string().regex(/^dlg_[a-f0-9]{24}$/u) })
  .strict();

/**
 * What a payment tool call would spend, read from its arguments. If it cannot be read exactly the call is refused:
 * a delegation never guesses an amount. Only the one purchase shape the Gateway executes is understood.
 */
export function delegatedSpendFacts(
  tool: PayFlowMcpToolName,
  args: Record<string, unknown>,
): Omit<DelegationSpend, "agentId" | "now"> | null {
  if (tool !== "request_authorized_action") return null;
  const action = args.action;
  if (action === null || typeof action !== "object") return null;
  const a = action as {
    action?: unknown;
    authority?: unknown;
    amount?: { minor?: unknown; currency?: unknown };
    merchant?: { id?: unknown };
  };
  if (
    a.action !== "purchase" ||
    typeof a.amount?.minor !== "number" ||
    typeof a.amount.currency !== "string" ||
    typeof a.merchant?.id !== "string" ||
    typeof a.authority !== "string"
  )
    return null;
  return {
    actionKind: "PURCHASE",
    currency: a.amount.currency,
    counterpartyId: a.merchant.id,
    amountMinor: a.amount.minor,
    // The delegation must be bound to exactly the stored Authority this action is for.
    authorityId: a.authority,
  };
}

export interface A2AHttpOptions {
  /** Where the interface lives under the base URL. Default "/a2a/v1". */
  readonly basePath?: string;
  /** When set, `delegation: { delegationId }` refers to a stored chain whose budget is shared and conserved. */
  readonly delegations?: DelegationLedger;
  readonly baseUrl: string;
  readonly audience: string;
  readonly authenticate: ProtocolAuthenticator;
  readonly servicesFor: (identity: ProtocolIdentity) => McpAuthorityServices;
  readonly rateLimit: (identity: ProtocolIdentity) => Promise<boolean>;
  readonly replayStore: DelegationReplayStore;
  /** Parent delegation comes from trusted server state, never the requesting peer. */
  readonly parentFor: (
    identity: ProtocolIdentity,
  ) => Promise<DelegatedFinancialScope | null>;
  readonly now?: () => string;
}
/** v1.0 synchronous HTTP+JSON profile. No streaming/push/task persistence is advertised. */
export function createA2AHttpHandler(options: A2AHttpOptions) {
  const basePath = options.basePath ?? "/a2a/v1";
  const card = createPayFlowAgentCard(options.baseUrl, basePath);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const headers = {
      "Cache-Control": "no-store",
      "X-Request-Id": randomUUID(),
    };
    const problem = (type: string, title: string, status = 400) =>
      Response.json(
        { type: `https://a2a-protocol.org/errors/${type}`, title, status },
        {
          status,
          headers: { ...headers, "Content-Type": "application/problem+json" },
        },
      );
    if (
      (path === "/.well-known/agent-card.json" ||
        path === `${basePath}/agent-card.json`) &&
      request.method === "GET"
    )
      return Response.json(card, { headers });
    if (path !== `${basePath}/message:send`)
      return problem("not-found", "Not found", 404);
    if (request.method !== "POST")
      return problem("method-not-allowed", "POST required", 405);
    if (request.headers.get("A2A-Version") !== "1.0")
      return problem("version-not-supported", "Supported version: 1.0");
    let identity: ProtocolIdentity | null;
    try {
      identity = await options.authenticate(request);
    } catch {
      identity = null;
    }
    if (!identity || identity.access.audience !== options.audience)
      return problem("authentication-required", "Authentication required", 401);
    if (!(await options.rateLimit(identity)))
      return problem("rate-limited", "Rate limited", 429);
    if (
      !request.headers.get("content-type")?.startsWith("application/a2a+json")
    )
      return problem("invalid-request", "application/a2a+json required", 415);
    let raw: unknown;
    try {
      raw = await readBoundedJson(request);
    } catch {
      return problem("invalid-request", "Invalid JSON");
    }
    const parsed = send.safeParse(raw);
    if (!parsed.success)
      return problem("invalid-request", "Invalid SendMessageRequest");
    const input = command.safeParse(parsed.data.message.parts[0]?.data);
    if (!input.success)
      return problem(
        "invalid-request",
        "One structured PayFlow command required",
      );
    const at = options.now?.() ?? new Date().toISOString();
    let charged: { leafId: string; amountMinor: number } | undefined;
    const stored = delegationRef.safeParse(input.data.delegation);
    if (stored.success && options.delegations) {
      const facts = delegatedSpendFacts(input.data.tool, input.data.arguments);
      if (!facts)
        return problem(
          "invalid-request",
          "A delegation can only accompany an exact purchase request",
        );
      const reserved = await options.delegations.reserve(
        stored.data.delegationId,
        { ...facts, agentId: identity.access.agentId, now: at },
      );
      if (!reserved.ok)
        return problem(
          "authorization-failed",
          `Delegation ${reserved.reason}`,
          403,
        );
      charged = {
        leafId: stored.data.delegationId,
        amountMinor: facts.amountMinor,
      };
    } else if (input.data.delegation !== undefined) {
      const parent = await options.parentFor(identity);
      if (!parent || parent.childAgentId !== identity.subject)
        return problem(
          "authorization-failed",
          "No trusted delegation parent",
          403,
        );
      const result = await evaluateDelegatedRequest(
        input.data.delegation,
        parent,
        { audience: identity.access.audience, now: at },
        options.replayStore,
      );
      if (result.verdict !== "ACCEPTED")
        return problem(
          "authorization-failed",
          `Delegation ${result.verdict}`,
          403,
        );
      // This profile does not use presented delegation to replace server-owned access or widen Authority.
    }
    if (
      !(await options.replayStore.claimNonce(
        `a2a-message:${identity.access.principalId}:${identity.subject}`,
        parsed.data.message.messageId,
      ))
    ) {
      // A replay never reaches the tool, so nothing was spent: give back what this duplicate just reserved.
      if (charged)
        await options.delegations?.release(charged.leafId, charged.amountMinor);
      return problem(
        "invalid-request",
        "Message already processed; reconcile original action",
        409,
      );
    }
    try {
      const result = await invokePayFlowMcpTool(
        input.data.tool,
        input.data.arguments,
        {
          authenticated: true,
          subject: identity.subject,
          scopes: identity.scopes,
          requestId: headers["X-Request-Id"],
        },
        options.servicesFor(identity),
      );
      // Budget goes back only when the outcome is KNOWN to be zero effect. UNKNOWN and completed keep the charge.
      if (
        charged &&
        (result.structuredContent as { effectCount?: unknown } | null)
          ?.effectCount === 0
      )
        await options.delegations?.release(charged.leafId, charged.amountMinor);
      return Response.json(
        {
          message: {
            messageId: randomUUID(),
            role: "ROLE_AGENT",
            parts: [{ data: { result: result.structuredContent } }],
          },
        },
        { headers: { ...headers, "Content-Type": "application/a2a+json" } },
      );
    } catch (error) {
      // Refused by the MCP front door (bad arguments, missing scope) before any service ran: zero effect.
      const frontDoor =
        error instanceof Error && /^MCP_[A-Z_]+$/u.test(error.message);
      if (
        charged &&
        (frontDoor ||
          (error instanceof McpToolError && error.structured.effectCount === 0))
      )
        await options.delegations?.release(charged.leafId, charged.amountMinor);
      return problem(
        "authorization-failed",
        "Tool refused; no new Authority was granted",
        403,
      );
    }
  };
}

export async function sendA2ACommand(
  endpoint: string,
  token: string,
  messageId: string,
  tool: PayFlowMcpToolName,
  args: Record<string, unknown>,
  fetcher = fetch,
): Promise<unknown> {
  const root = new URL(endpoint);
  if (
    root.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(root.hostname)
  )
    throw new Error("A2A_HTTPS_REQUIRED");
  const response = await fetcher(
    new URL(
      "./message:send",
      root.href.endsWith("/") ? root.href : `${root.href}/`,
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/a2a+json",
        "A2A-Version": "1.0",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: "ROLE_USER",
          parts: [{ data: { tool, arguments: args } }],
        },
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`A2A_HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}
