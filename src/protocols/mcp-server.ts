import {
  DECISION_WIDGET_HTML,
  DECISION_WIDGET_URI,
  MCP_APP_MIME,
  toolPresentation,
} from "./chatgpt-app.js";
import {
  MCP_LEGACY_VERSIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  McpToolError,
  PAYFLOW_MCP_SERVER_INFO,
  PAYFLOW_MCP_TOOLS,
  assertSafeOutput,
  invokePayFlowMcpTool,
  type McpAuthorityServices,
  type PayFlowMcpToolName,
} from "./mcp.js";

/**
 * Transport-agnostic MCP (JSON-RPC 2.0) request handler. The stdio and HTTP transports are thin wrappers.
 * Tool arguments are untrusted input; every tool call goes through invokePayFlowMcpTool, which requires
 * authentication and blocks secret-bearing output.
 *
 * Dual era (MCP 2026-07-28, "Versioning and Compatibility"): a request that opens with `initialize` selects the
 * legacy handshake and a negotiated legacy version; a request that carries the per-request
 * `io.modelcontextprotocol/protocolVersion` in `_meta` is served statelessly by the modern revision. The era is
 * decided per message from the message itself, never from state left by an earlier message.
 */
export interface McpServerOptions {
  readonly services: McpAuthorityServices;
  /** Whether the transport authenticated the caller. Never derived from message content. */
  readonly authenticated: boolean;
  readonly scopes?: readonly string[];
  readonly subject?: string;
  readonly requestId?: string;
}

export const MCP_META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CAPABILITIES =
  "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** JSON-RPC codes defined by the 2026-07-28 revision (-32020…-32022 are reserved for the specification). */
export const MCP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export type McpEra = "modern" | "legacy";

const SERVER_INFO = {
  name: PAYFLOW_MCP_SERVER_INFO.name,
  version: PAYFLOW_MCP_SERVER_INFO.version,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

/** The era a message selects, and the version it asked for (undefined when it asked for none). */
export function classifyMcpMessage(raw: unknown): {
  era: McpEra;
  version: string | undefined;
} {
  if (!isRecord(raw)) return { era: "legacy", version: undefined };
  const params = isRecord(raw.params) ? raw.params : undefined;
  if (raw.method === "initialize") {
    const requested = params?.protocolVersion;
    return {
      era: "legacy",
      version: typeof requested === "string" ? requested : undefined,
    };
  }
  const meta = isRecord(params?._meta) ? params._meta : undefined;
  const version = meta?.[MCP_META_VERSION];
  return typeof version === "string"
    ? { era: "modern", version }
    : { era: "legacy", version: undefined };
}

/** HTTP status for a handled message, per the transport rules of the revision the message selected. */
export function mcpHttpStatus(
  response: Record<string, unknown> | null,
  era: McpEra,
): number {
  if (response === null) return 202;
  const error = isRecord(response.error) ? response.error : undefined;
  if (!error) return 200;
  const code = error.code;
  if (
    code === MCP_ERROR.headerMismatch ||
    code === MCP_ERROR.missingClientCapability ||
    code === MCP_ERROR.unsupportedProtocolVersion
  )
    return 400;
  if (
    code === MCP_ERROR.invalidParams &&
    isRecord(error.data) &&
    error.data.reason === "missing_meta"
  )
    return 400;
  if (code === MCP_ERROR.methodNotFound && era === "modern") return 404;
  if (code === MCP_ERROR.parse || code === MCP_ERROR.invalidRequest) return 400;
  return 200;
}

function success(
  id: unknown,
  era: McpEra,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (era === "legacy") return { jsonrpc: "2.0", id, result };
  const meta = isRecord(result._meta) ? result._meta : {};
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { ...meta, [MCP_META_SERVER_INFO]: SERVER_INFO },
    },
  };
}

function visibleTools(services: McpAuthorityServices) {
  return PAYFLOW_MCP_TOOLS.filter(
    (tool) => !services.supports || services.supports.has(tool.name),
  );
}

function toolText(value: unknown): string {
  return JSON.stringify(value);
}

export async function handleMcpMessage(
  raw: unknown,
  options: McpServerOptions,
): Promise<Record<string, unknown> | null> {
  if (!isRecord(raw)) return rpcError(null, -32600, "Invalid Request");
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
  const params = isRecord(message.params) ? message.params : undefined;
  const { era, version } = classifyMcpMessage(raw);

  // Legacy handshake: negotiate, never echo a version we do not speak.
  if (message.method === "initialize") {
    const negotiated = (MCP_LEGACY_VERSIONS as readonly string[]).includes(
      version ?? "",
    )
      ? (version as string)
      : MCP_LEGACY_VERSIONS[0];
    return success(id, "legacy", {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions: PAYFLOW_MCP_SERVER_INFO.instructions,
    });
  }
  if (
    message.method === "notifications/initialized" ||
    message.method === "notifications/cancelled"
  )
    return null;

  if (era === "modern") {
    if (!(version === MCP_PROTOCOL_VERSION))
      return rpcError(
        id,
        MCP_ERROR.unsupportedProtocolVersion,
        "Unsupported protocol version",
        {
          supported: [...MCP_SUPPORTED_VERSIONS],
          requested: version,
        },
      );
    const meta = params?._meta as Record<string, unknown>;
    if (
      message.method !== "server/discover" &&
      !isRecord(meta[MCP_META_CAPABILITIES])
    )
      return rpcError(
        id,
        MCP_ERROR.invalidParams,
        "Missing required _meta field",
        {
          reason: "missing_meta",
          missing: MCP_META_CAPABILITIES,
        },
      );
  }

  switch (message.method) {
    case "server/discover":
      return success(id, "modern", {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: PAYFLOW_MCP_SERVER_INFO.instructions,
      });
    case "ping":
      return isNotification ? null : success(id, era, {});
    case "tools/list":
      return success(id, era, {
        tools: visibleTools(options.services).map((tool) => ({
          name: tool.name,
          ...toolPresentation(tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
        // The set varies with the caller's authorization, so it is never shared between callers.
        ...(era === "modern" ? { ttlMs: 0, cacheScope: "private" } : {}),
      });
    case "resources/list":
      return success(id, era, {
        resources: [
          {
            uri: DECISION_WIDGET_URI,
            name: "payflow-decision",
            title: "PayFlow Authority result card",
            mimeType: MCP_APP_MIME,
          },
        ],
        ...(era === "modern" ? { ttlMs: 0, cacheScope: "public" } : {}),
      });
    case "resources/read": {
      if (params?.uri !== DECISION_WIDGET_URI)
        return rpcError(id, MCP_ERROR.invalidParams, "Unknown resource");
      return success(id, era, {
        contents: [
          {
            uri: DECISION_WIDGET_URI,
            mimeType: MCP_APP_MIME,
            text: DECISION_WIDGET_HTML,
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
          },
        ],
      });
    }
    case "tools/call": {
      const visible = new Set<string>(
        visibleTools(options.services).map((tool) => tool.name),
      );
      if (
        !params ||
        typeof params.name !== "string" ||
        !visible.has(params.name)
      )
        return rpcError(id, MCP_ERROR.invalidParams, "Unknown tool");
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
        return success(id, era, {
          content: [{ type: "text", text: toolText(result.structuredContent) }],
          structuredContent: result.structuredContent,
          isError: false,
        });
      } catch (error) {
        // Tool failures are results, not protocol errors, and carry only a stable code (and any safe detail).
        if (error instanceof McpToolError) {
          try {
            assertSafeOutput(error.structured);
          } catch {
            return success(id, era, {
              content: [{ type: "text", text: error.code }],
              isError: true,
            });
          }
          return success(id, era, {
            content: [
              {
                type: "text",
                text: toolText({ code: error.code, ...error.structured }),
              },
            ],
            structuredContent: { code: error.code, ...error.structured },
            isError: true,
          });
        }
        const text = error instanceof Error ? error.message : "";
        const candidate = text.split(":")[0] ?? "";
        const code =
          /^(MCP_|ACCESS_|GATEWAY_|AUTHORITY_|ACTION_|REQUEST_)[A-Z_]+$/.test(
            candidate,
          )
            ? candidate
            : "TOOL_ERROR";
        return success(id, era, {
          content: [{ type: "text", text: code }],
          isError: true,
        });
      }
    }
    default:
      return isNotification
        ? null
        : rpcError(
            id,
            MCP_ERROR.methodNotFound,
            `Method not found: ${message.method}`,
          );
  }
}
