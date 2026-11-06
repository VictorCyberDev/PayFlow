import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpHttpHandler,
  localProtocolRateLimit,
} from "../src/protocols/mcp-http.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
import {
  MCP_SUPPORTED_VERSIONS,
  PAYFLOW_MCP_TOOLS,
} from "../src/protocols/mcp.js";
import { requestBody } from "../src/network/live-fault-injector.js";

/**
 * M16 genuine-client acceptance. The client here is the OFFICIAL @modelcontextprotocol/sdk Client, not a
 * hand-rolled one, speaking real stdio and real Streamable HTTP to the real transports. Raw-wire cases cover the
 * 2026-07-28 revision, which the published SDK does not speak yet.
 */
const now = () => "2026-10-28T03:00:00.000Z";
const args = {
  authorityId: "benchmark-authority",
  proposedAction: requestBody(),
};

describe("M16 official MCP SDK client over stdio", () => {
  it("connects, negotiates a supported legacy version, lists five tools and calls one", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "--import",
        "./tests/helpers/stdio-fixture-clock.ts",
        "packages/mcp-server/src/stdio.ts",
      ],
      env: {
        ...(process.env as Record<string, string>),
        PAYFLOW_MCP_ACCESS_TOKEN: "local-sandbox",
      },
      cwd: process.cwd(),
    });
    const client = new Client({ name: "official-sdk", version: "1.0.0" }, {});
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(
        "payflow-financial-authority",
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        PAYFLOW_MCP_TOOLS.map((tool) => tool.name).sort(),
      );
      const result = await client.callTool({
        name: "check_financial_authority",
        arguments: args,
      });
      expect(result.isError).toBeFalsy();
      expect(
        (result.structuredContent as { fits: boolean } | undefined)?.fits,
      ).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("M16 official MCP SDK client over Streamable HTTP", () => {
  let server: Server;
  let base: string;
  const token = "pf_test_token";

  const holder: { handle?: (request: Request) => Promise<Response> } = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", base);
        const body = Buffer.concat(chunks);
        const request = new Request(url, {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          ...(req.method === "POST" ? { body } : {}),
        });
        void holder.handle?.(request).then(async (response) => {
          res.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries()),
          );
          res.end(Buffer.from(await response.arrayBuffer()));
        });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mcpResource = `${base}/mcp`;
    holder.handle = createMcpHttpHandler({
      resource: mcpResource,
      allowedOrigins: [],
      authenticate: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === `Bearer ${token}`
            ? ({
                subject: "agent-1",
                scopes: [
                  "authority:read",
                  "action:request",
                  "verify:read",
                  "proof:read",
                  "reconcile:request",
                ],
                access: {
                  audience: mcpResource,
                  principalId: "org-1",
                },
              } as never)
            : null,
        ),
      servicesFor: () => createSandboxMcpServices(now),
      rateLimit: localProtocolRateLimit(1000),
    });
  });
  afterAll(() => {
    server.close();
  });

  it("connects with a bearer token, lists tools and calls a read tool", async () => {
    const client = new Client({ name: "official-sdk-http", version: "1" }, {});
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(5);
      const result = await client.callTool({
        name: "check_financial_authority",
        arguments: args,
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses an unauthenticated client", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
  });

  describe("2026-07-28 wire conformance", () => {
    const post = (
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const meta = (version = "2026-07-28") => ({
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    const modernHeaders = (method: string, name?: string) => ({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    });

    it("server/discover names every supported version", async () => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: meta() },
        },
        modernHeaders("server/discover"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { resultType: string; supportedVersions: string[] };
      };
      expect(body.result.resultType).toBe("complete");
      expect(body.result.supportedVersions).toEqual([
        ...MCP_SUPPORTED_VERSIONS,
      ]);
    });

    it("serves tools/list and tools/call statelessly with resultType", async () => {
      const list = await post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: meta() },
        },
        modernHeaders("tools/list"),
      );
      expect(list.status).toBe(200);
      const listed = (await list.json()) as {
        result: { resultType: string; tools: unknown[]; cacheScope: string };
      };
      expect(listed.result.resultType).toBe("complete");
      expect(listed.result.tools).toHaveLength(5);
      expect(listed.result.cacheScope).toBe("private");
      const called = await post(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "check_financial_authority",
            arguments: args,
            _meta: meta(),
          },
        },
        modernHeaders("tools/call", "check_financial_authority"),
      );
      expect(called.status).toBe(200);
      const result = (await called.json()) as {
        result: { resultType: string; isError: boolean };
      };
      expect(result.result.resultType).toBe("complete");
      expect(result.result.isError).toBe(false);
    });

    it("rejects an unsupported version with -32022 and the supported list", async () => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
          params: { _meta: meta("1900-01-01") },
        },
        {
          ...modernHeaders("tools/list"),
          "MCP-Protocol-Version": "1900-01-01",
        },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: {
          code: number;
          data: { supported: string[]; requested: string };
        };
      };
      expect(body.error.code).toBe(-32022);
      expect(body.error.data.requested).toBe("1900-01-01");
      expect(body.error.data.supported).toContain("2026-07-28");
    });

    it("rejects a header that disagrees with the body with -32020", async () => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/list",
          params: { _meta: meta() },
        },
        modernHeaders("tools/call"),
      );
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: number } }).error.code,
      ).toBe(-32020);
      const wrongName = await post(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "verify_authority", arguments: {}, _meta: meta() },
        },
        modernHeaders("tools/call", "check_financial_authority"),
      );
      expect(wrongName.status).toBe(400);
    });

    it("rejects a request missing required _meta with -32602 / 400", async () => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/list",
          params: {
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
        },
        modernHeaders("tools/list"),
      );
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: number } }).error.code,
      ).toBe(-32602);
    });

    it("answers an unknown modern method with 404 / -32601 and an unknown tool as a protocol error", async () => {
      const missing = await post(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "resources/list",
          params: { _meta: meta() },
        },
        modernHeaders("resources/list"),
      );
      expect(missing.status).toBe(404);
      const unknown = await post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "nope", arguments: {}, _meta: meta() },
        },
        modernHeaders("tools/call", "nope"),
      );
      expect(
        ((await unknown.json()) as { error: { code: number } }).error.code,
      ).toBe(-32602);
    });
  });
});
