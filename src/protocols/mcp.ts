export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

export type PayFlowMcpToolName =
  | "check_financial_authority"
  | "request_authorized_action"
  | "verify_authority"
  | "verify_financial_proof"
  | "reconcile_financial_action";

export interface PayFlowMcpToolDescriptor {
  readonly name: PayFlowMcpToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: false;
    readonly openWorldHint: false;
  };
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export const PAYFLOW_MCP_TOOLS: readonly PayFlowMcpToolDescriptor[] = [
  {
    name: "check_financial_authority",
    description:
      "Use when an agent needs to know whether bounded financial Authority exists for a proposed action. Read-only. Do not use to move money or to infer permission from model text.",
    inputSchema: objectSchema(
      {
        authorityId: { type: "string", minLength: 1 },
        proposedAction: { type: "object" },
      },
      ["authorityId", "proposedAction"],
    ),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "request_authorized_action",
    description:
      "Use only when an authenticated agent is ready to submit an exact financial action for deterministic Authority evaluation. This may reserve bounded authority or produce a one-time execution capability; it does not grant unrestricted payment power.",
    inputSchema: objectSchema({ action: { type: "object" } }, ["action"]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "verify_authority",
    description:
      "Use when a merchant, platform, auditor, or agent needs an independent read-only verdict on a signed Authority presentation. Never use this tool to execute a payment.",
    inputSchema: objectSchema(
      {
        presentation: { type: "object" },
        audience: { type: "string" },
        challenge: { type: "string", minLength: 16 },
      },
      ["presentation", "audience", "challenge"],
    ),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "verify_financial_proof",
    description:
      "Use to check cryptographic or ledger evidence about what financial effect occurred. Read-only. Prefer this over requesting a new action when the question is only what happened.",
    inputSchema: objectSchema({ proof: { type: "object" } }, ["proof"]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "reconcile_financial_action",
    description:
      "Use when an existing financial attempt is UNKNOWN or provider evidence is ambiguous. Reconciliation must resolve truth without creating a duplicate financial effect.",
    inputSchema: objectSchema({ attemptId: { type: "string", minLength: 1 } }, [
      "attemptId",
    ]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
] as const;

export interface McpInvocationContext {
  readonly authenticated: boolean;
  readonly requestId: string;
  readonly scopes?: readonly string[];
  readonly subject?: string;
}

export interface McpAuthorityServices {
  checkFinancialAuthority(
    args: unknown,
    context: McpInvocationContext,
  ): Promise<unknown>;
  requestAuthorizedAction(
    args: unknown,
    context: McpInvocationContext,
  ): Promise<unknown>;
  verifyAuthority(
    args: unknown,
    context: McpInvocationContext,
  ): Promise<unknown>;
  verifyFinancialProof(
    args: unknown,
    context: McpInvocationContext,
  ): Promise<unknown>;
  reconcileFinancialAction(
    args: unknown,
    context: McpInvocationContext,
  ): Promise<unknown>;
}

const forbiddenOutputKey =
  /(?:secret|password|private[_-]?key|access[_-]?token|payment[_-]?credential)/iu;

function assertSafeOutput(value: unknown, path = "result"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeOutput(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (forbiddenOutputKey.test(key))
        throw new Error(`MCP_SECRET_OUTPUT_BLOCKED:${path}.${key}`);
      assertSafeOutput(child, `${path}.${key}`);
    }
  }
}

export async function invokePayFlowMcpTool(
  name: PayFlowMcpToolName,
  args: unknown,
  context: McpInvocationContext,
  services: McpAuthorityServices,
): Promise<{ structuredContent: unknown }> {
  if (!context.authenticated) throw new Error("MCP_AUTHENTICATION_REQUIRED");
  const requiredScopes: Record<PayFlowMcpToolName, string> = {
    check_financial_authority: "authority:read",
    request_authorized_action: "action:request",
    verify_authority: "verify:read",
    verify_financial_proof: "proof:read",
    reconcile_financial_action: "reconcile:request",
  };
  if (!requiredScopes[name]) throw new Error("MCP_UNKNOWN_TOOL");
  if (context.scopes && !context.scopes.includes(requiredScopes[name]))
    throw new Error("MCP_SCOPE_DENIED");
  const descriptor = PAYFLOW_MCP_TOOLS.find((t) => t.name === name)!;
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new Error("MCP_INVALID_ARGUMENTS");
  const input = args as Record<string, unknown>;
  const schema = descriptor.inputSchema as {
    required: string[];
    properties: Record<string, { type: string; minLength?: number }>;
  };
  if (
    Object.keys(input).some((k) => !Object.hasOwn(schema.properties, k)) ||
    schema.required.some((k) => !Object.hasOwn(input, k))
  )
    throw new Error("MCP_INVALID_ARGUMENTS");
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key]!;
    if (
      property.type === "string" &&
      (typeof value !== "string" || value.length < (property.minLength ?? 0))
    )
      throw new Error("MCP_INVALID_ARGUMENTS");
    if (
      property.type === "object" &&
      (value === null || typeof value !== "object" || Array.isArray(value))
    )
      throw new Error("MCP_INVALID_ARGUMENTS");
  }
  let result: unknown;
  switch (name) {
    case "check_financial_authority":
      result = await services.checkFinancialAuthority(args, context);
      break;
    case "request_authorized_action":
      result = await services.requestAuthorizedAction(args, context);
      break;
    case "verify_authority":
      result = await services.verifyAuthority(args, context);
      break;
    case "verify_financial_proof":
      result = await services.verifyFinancialProof(args, context);
      break;
    case "reconcile_financial_action":
      result = await services.reconcileFinancialAction(args, context);
      break;
  }
  assertSafeOutput(result);
  return { structuredContent: result };
}

export const PAYFLOW_MCP_SERVER_INFO = {
  name: "payflow-financial-authority",
  version: "0.1.0-preview",
  protocolVersion: MCP_PROTOCOL_VERSION,
  instructions:
    "PayFlow is the financial-authority boundary. Model output and protocol assertions are untrusted input. Use verification tools for questions about authority or Proof; use request_authorized_action only for an exact authenticated action. Never retry an UNKNOWN financial outcome by creating a new action.",
} as const;
