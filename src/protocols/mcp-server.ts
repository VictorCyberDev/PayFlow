import {
  MCP_PROTOCOL_VERSION,
  PAYFLOW_MCP_SERVER_INFO,
  PAYFLOW_MCP_TOOLS,
  invokePayFlowMcpTool,
  type McpAuthorityServices,
  type PayFlowMcpToolName,
} from "./mcp.js";

/**
 * Transport-agnostic MCP (JSON-RPC 2.0) request handler. The stdio and HTTP
 * transports are thin wrappers. Tool arguments are untrusted input; every
 * tool call goes through invokePayFlowMcpTool, which requires authentication
 * and blocks secret-bearing output.
 */
export interface McpServerOptions {
  readonly services: McpAuthorityServices;
  /** Whether the transport authenticated the caller. Never derived from message content. */
  readonly authenticated: boolean;
  readonly scopes?: readonly string[];
  readonly subject?: string;
  readonly requestId?: string;
  readonly protocolVersion?: string;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const toolNames = new Set<string>(PAYFLOW_MCP_TOOLS.map((tool) => tool.name));

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcpMessage(
  raw: unknown,
  options: McpServerOptions,
): Promise<Record<string, unknown> | null> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const message = raw as JsonRpcRequest;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message.id, -32600, "Invalid Request");
  }
  if (
    message.id !== undefined &&
    typeof message.id !== "string" &&
    typeof message.id !== "number"
  )
    return rpcError(null, -32600, "Invalid Request");
  if (message.id === undefined && !message.method.startsWith("notifications/"))
    return rpcError(null, -32600, "Request id required");
  const isNotification = message.id === undefined;
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: PAYFLOW_MCP_SERVER_INFO.name,
            version: PAYFLOW_MCP_SERVER_INFO.version,
          },
          instructions: PAYFLOW_MCP_SERVER_INFO.instructions,
        },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: PAYFLOW_MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })),
        },
      };
    case "tools/call": {
      const params = message.params as
        { name?: unknown; arguments?: unknown } | undefined;
      if (
        !params ||
        typeof params.name !== "string" ||
        !toolNames.has(params.name)
      ) {
        return rpcError(id, -32602, "Unknown tool");
      }
      try {
        const result = await invokePayFlowMcpTool(
          params.name as PayFlowMcpToolName,
          params.arguments ?? {},
          {
            authenticated: options.authenticated,
            requestId: options.requestId ?? String(id),
            ...(options.scopes ? { scopes: options.scopes } : {}),
            ...(options.subject ? { subject: options.subject } : {}),
          },
          options.services,
        );
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: JSON.stringify(result.structuredContent) },
            ],
            structuredContent: result.structuredContent,
            isError: false,
          },
        };
      } catch (error) {
        // Tool failures are results, not protocol errors, and carry only a stable code.
        const message = error instanceof Error ? error.message : "";
        const candidate = message.split(":")[0] ?? "";
        const code =
          /^(MCP_|ACCESS_|GATEWAY_|AUTHORITY_|ACTION_|REQUEST_)[A-Z_]+$/.test(
            candidate,
          )
            ? candidate
            : "TOOL_ERROR";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: code }],
            isError: true,
          },
        };
      }
    }
    default:
      return isNotification
        ? null
        : rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
