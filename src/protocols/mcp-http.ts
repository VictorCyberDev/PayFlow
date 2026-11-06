import { randomUUID } from "node:crypto";
import {
  MCP_ERROR,
  classifyMcpMessage,
  handleMcpMessage,
  mcpHttpStatus,
  rpcError,
} from "./mcp-server.js";
import { MCP_SUPPORTED_VERSIONS, type McpAuthorityServices } from "./mcp.js";
import type { ProtocolAuthenticator, ProtocolIdentity } from "./http-auth.js";

export const SUPPORTED_MCP_VERSIONS = MCP_SUPPORTED_VERSIONS;
export interface McpHttpOptions {
  readonly resource: string;
  /** Audience a credential must carry. Defaults to `resource` (OAuth); the Gateway's own credentials use its fixed audience. */
  readonly audience?: string;
  readonly allowedOrigins: readonly string[];
  readonly authenticate: ProtocolAuthenticator;
  /** Must construct services bound to this verified tenant/agent. Never use arguments as identity. */
  readonly servicesFor: (identity: ProtocolIdentity) => McpAuthorityServices;
  readonly rateLimit: (identity: ProtocolIdentity) => Promise<boolean>;
  readonly timeoutMs?: number;
}

export async function readBoundedJson(
  request: Request,
  limit = 64 * 1024,
  timeoutMs = 3000,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new Error("BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + timeoutMs;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          readTimer = setTimeout(
            () => reject(new Error("BODY_READ_TIMEOUT")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
      clearTimeout(readTimer);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(readTimer);
    reader.releaseLock();
  }
}

/** `Mcp-Name` may be sent as `=?base64?<value>?=` when it is not header-safe. */
function decodeMcpName(value: string | null): string | null {
  const match = value?.match(/^=\?base64\?([A-Za-z0-9+/=]*)\?=$/);
  return match ? Buffer.from(match[1] ?? "", "base64").toString("utf8") : value;
}

export function createMcpHttpHandler(options: McpHttpOptions) {
  const resource = new URL(options.resource);
  if (
    resource.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(resource.hostname)
  )
    throw new Error("MCP_TLS_REQUIRED");
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const headers = {
      "X-Request-Id": requestId,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const json = (body: unknown, status = 200, extra = {}) =>
      Response.json(body, { status, headers: { ...headers, ...extra } });
    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins.includes(origin))
      return json({ error: "ORIGIN_DENIED" }, 403);
    let identity: ProtocolIdentity | null;
    try {
      identity = await options.authenticate(request);
    } catch {
      identity = null;
    }
    if (
      !identity ||
      identity.access.audience !== (options.audience ?? options.resource)
    )
      return json({ error: "AUTHENTICATION_REQUIRED" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource"`,
      });
    if (request.method !== "POST")
      return json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
    if (!(await options.rateLimit(identity)))
      return json({ error: "RATE_LIMITED" }, 429, { "Retry-After": "60" });
    const accept = request.headers.get("accept") ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    )
      return json({ error: "MCP_ACCEPT_REQUIRED" }, 406);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return json({ error: "JSON_REQUIRED" }, 415);
    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch (error) {
      return json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON body" },
        },
        error instanceof Error && error.message === "BODY_TOO_LARGE"
          ? 413
          : 400,
      );
    }
    const message = (body !== null && typeof body === "object" ? body : {}) as {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown };
    };
    const { era, version } = classifyMcpMessage(body);
    if (era === "modern") {
      // 2026-07-28: every POST repeats the version and method in headers, and they must agree with the body.
      const fail = (
        code: number,
        text: string,
        data?: Record<string, unknown>,
      ) => json(rpcError(message.id, code, text, data), 400);
      if (version !== SUPPORTED_MCP_VERSIONS[0])
        return fail(
          MCP_ERROR.unsupportedProtocolVersion,
          "Unsupported protocol version",
          {
            supported: [...SUPPORTED_MCP_VERSIONS],
            requested: version,
          },
        );
      if (request.headers.get("MCP-Protocol-Version") !== version)
        return fail(
          MCP_ERROR.headerMismatch,
          "Header mismatch: MCP-Protocol-Version is missing or does not match the request body",
        );
      if (request.headers.get("Mcp-Method") !== message.method)
        return fail(
          MCP_ERROR.headerMismatch,
          "Header mismatch: Mcp-Method is missing or does not match the request body",
        );
      if (
        message.method === "tools/call" &&
        decodeMcpName(request.headers.get("Mcp-Name")) !== message.params?.name
      )
        return fail(
          MCP_ERROR.headerMismatch,
          "Header mismatch: Mcp-Name is missing or does not match the request body",
        );
    } else {
      const header = request.headers.get("MCP-Protocol-Version");
      // The modern header must be matched by the same version in the body's `_meta`.
      if (header === SUPPORTED_MCP_VERSIONS[0])
        return json(
          rpcError(
            message.id,
            MCP_ERROR.headerMismatch,
            "Header mismatch: the body does not carry the same protocol version in _meta",
          ),
          400,
        );
      // A legacy header names a legacy revision we speak (or is absent); anything else is refused, not guessed.
      if (
        header &&
        !(SUPPORTED_MCP_VERSIONS as readonly string[]).includes(header)
      )
        return json(
          rpcError(
            message.id,
            MCP_ERROR.unsupportedProtocolVersion,
            "Unsupported protocol version",
            {
              supported: [...SUPPORTED_MCP_VERSIONS],
              requested: header,
            },
          ),
          400,
        );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handleMcpMessage(body, {
          services: options.servicesFor(identity),
          authenticated: true,
          scopes: identity.scopes,
          subject: identity.subject,
          requestId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("MCP_TIMEOUT")),
            options.timeoutMs ?? 8000,
          );
        }),
      ]);
      return result === null
        ? new Response(null, { status: 202, headers })
        : json(result, mcpHttpStatus(result, era));
    } catch {
      // A timed-out mutation may still finish. Never retry it here or claim $0 moved.
      return json(
        {
          error: "MCP_TIMEOUT_OR_SERVICE_FAILURE",
          outcome: "UNKNOWN",
          nextSafeAction:
            "Reconcile the original attempt; do not submit a new action.",
        },
        504,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Local single-process limit; distributed deployments must inject an atomic shared limiter. */
export function localProtocolRateLimit(max = 60, now = () => Date.now()) {
  const counters = new Map<string, { until: number; count: number }>();
  return (identity: ProtocolIdentity): Promise<boolean> => {
    const at = now();
    for (const [key, value] of counters)
      if (value.until <= at) counters.delete(key);
    const key = `${identity.access.principalId}:${identity.subject}`;
    const value = counters.get(key) ?? { until: at + 60_000, count: 0 };
    value.count++;
    counters.set(key, value);
    return Promise.resolve(value.count <= max);
  };
}
