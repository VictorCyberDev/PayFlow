import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpHttpHandler,
  localProtocolRateLimit,
} from "../src/protocols/mcp-http.js";
import { createLocalTokenAuthenticator } from "../src/protocols/http-auth.js";
import { createProtocolHttpServer } from "../src/protocols/local-http-server.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
import {
  createA2AHttpHandler,
  sendA2ACommand,
} from "../src/protocols/a2a-http.js";
import { accessFor, requestBody } from "../src/network/live-fault-injector.js";
import { kernelFixture } from "../src/network/benchmark.js";
import {
  runModelToolFlow,
  type ModelProvider,
} from "../src/protocols/model-runtime.js";
const at = "2026-10-28T03:00:00.000Z";
const token = "local-commissioning-test-token-32chars-minimum";
const resource = "http://127.0.0.1/mcp";
const access = {
  ...accessFor(kernelFixture().agent),
  audience: resource,
  scopes: [
    "authority:read" as const,
    "action:request" as const,
    "proof:read" as const,
  ],
};
const auth = createLocalTokenAuthenticator([{ token, access }], () =>
  Date.parse(at),
);
const make = (
  extra: Partial<Parameters<typeof createMcpHttpHandler>[0]> = {},
) => {
  const services = createSandboxMcpServices(() => at);
  return createMcpHttpHandler({
    resource,
    authenticate: auth,
    servicesFor: () => services,
    allowedOrigins: ["http://127.0.0.1"],
    rateLimit: localProtocolRateLimit(),
    ...extra,
  });
};
const rpc = (method: string, params: unknown = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const req = (body: unknown, extra: Record<string, string> = {}) =>
  new Request(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...extra,
    },
    body: JSON.stringify(body),
  });
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
const serve = async (handler: (r: Request) => Promise<Response>) => {
  const s = createProtocolHttpServer(handler);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};
describe("HTTP MCP security and actual clients", () => {
  it("refuses unauthenticated, foreign Origin, wrong audience, oversized and malformed input", async () => {
    const handle = make();
    expect(
      (
        await handle(
          req(rpc("tools/list"), { Authorization: "Bearer incorrect" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handle(
          req(rpc("tools/list"), { Origin: "https://attacker.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await handle(req(rpc("tools/list"), { "content-length": "999999" })))
        .status,
    ).toBe(413);
    const malformed = new Request(resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{",
    });
    expect((await handle(malformed)).status).toBe(400);
    const wrong = createLocalTokenAuthenticator(
      [{ token, access: { ...access, audience: "https://other.example/mcp" } }],
      () => Date.parse(at),
    );
    expect(
      (await make({ authenticate: wrong })(req(rpc("tools/list")))).status,
    ).toBe(401);
  });
  it("discovery is exact, read checks do not consume the original action, writes require scope", async () => {
    const handle = make();
    const list = (await (await handle(req(rpc("tools/list")))).json()) as {
      result: { tools: unknown[] };
    };
    expect(list.result.tools).toHaveLength(5);
    const action = requestBody();
    const check = await handle(
      req(
        rpc("tools/call", {
          name: "check_financial_authority",
          arguments: { authorityId: action.mandateId, proposedAction: action },
        }),
      ),
    );
    expect(JSON.stringify(await check.json())).toContain('"fits":true');
    const write = await handle(
      req(
        rpc("tools/call", {
          name: "request_authorized_action",
          arguments: { action },
        }),
      ),
    );
    expect(JSON.stringify(await write.json())).toContain('"decision":"ALLOW"');
    const replay = await handle(
      req(
        rpc("tools/call", {
          name: "request_authorized_action",
          arguments: { action },
        }),
      ),
    );
    expect(JSON.stringify(await replay.json())).not.toContain(
      '"decision":"ALLOW"',
    );
    const readAuth = createLocalTokenAuthenticator(
      [{ token, access: { ...access, scopes: ["authority:read"] } }],
      () => Date.parse(at),
    );
    expect(
      JSON.stringify(
        await (
          await make({ authenticate: readAuth })(
            req(
              rpc("tools/call", {
                name: "request_authorized_action",
                arguments: { action },
              }),
            ),
          )
        ).json(),
      ),
    ).toContain("MCP_SCOPE_DENIED");
  });
  it("enforces latest request headers, schema, rate limit, safe failure, timeout and no automatic retry", async () => {
    expect(
      (
        await make()(
          req(rpc("tools/list"), { "MCP-Protocol-Version": "2026-07-28" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await make()(
          req(rpc("tools/list"), {
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          }),
        )
      ).status,
    ).toBe(200);
    const invalid = await make()(
      req(
        rpc("tools/call", {
          name: "verify_financial_proof",
          arguments: { proof: {}, secret: "x" },
        }),
      ),
    );
    expect(JSON.stringify(await invalid.json())).toContain(
      "MCP_INVALID_ARGUMENTS",
    );
    expect(
      (
        await make({ rateLimit: localProtocolRateLimit(0) })(
          req(rpc("tools/list")),
        )
      ).status,
    ).toBe(429);
    const services = createSandboxMcpServices(() => at);
    const secret = make({
      servicesFor: () => ({
        ...services,
        verifyFinancialProof: () =>
          Promise.resolve({ private_key: "do-not-leak" }),
      }),
    });
    const output = JSON.stringify(
      await (
        await secret(
          req(
            rpc("tools/call", {
              name: "verify_financial_proof",
              arguments: { proof: {} },
            }),
          ),
        )
      ).json(),
    );
    expect(output).toContain("MCP_SECRET_OUTPUT_BLOCKED");
    expect(output).not.toContain("do-not-leak");
    let count = 0;
    const timeout = make({
      timeoutMs: 5,
      servicesFor: () => ({
        ...services,
        requestAuthorizedAction: () => {
          count++;
          return new Promise(() => {});
        },
      }),
    });
    const r = await timeout(
      req(
        rpc("tools/call", {
          name: "request_authorized_action",
          arguments: { action: requestBody() },
        }),
      ),
    );
    expect(r.status).toBe(504);
    expect(await r.text()).toContain("UNKNOWN");
    expect(count).toBe(1);
  });
  it("connects two official SDK HTTP clients independently and invokes a real kernel-backed check", async () => {
    const origin = await serve(make());
    const clients = [
      new Client({ name: "payflow-client-a", version: "1" }),
      new Client({ name: "payflow-client-b", version: "1" }),
    ];
    try {
      for (const client of clients) {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        expect((await client.listTools()).tools).toHaveLength(5);
      }
      const action = requestBody();
      const result = await clients[0]!.callTool({
        name: "check_financial_authority",
        arguments: { authorityId: action.mandateId, proposedAction: action },
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain('"fits":true');
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});
describe("A2A real local wire exchange", () => {
  it("discovers, authenticates, checks an action and refuses duplicate message and unsupported version", async () => {
    const claimed = new Set<string>();
    const services = createSandboxMcpServices(() => at);
    const handle = createA2AHttpHandler({
      baseUrl: "http://localhost",
      audience: resource,
      authenticate: auth,
      servicesFor: () => services,
      rateLimit: localProtocolRateLimit(),
      parentFor: () => Promise.resolve(null),
      replayStore: {
        claimNonce: (scope, nonce) => {
          const key = scope + nonce;
          if (claimed.has(key)) return Promise.resolve(false);
          claimed.add(key);
          return Promise.resolve(true);
        },
      },
      now: () => at,
    });
    const origin = await serve(handle);
    const card = (await (
      await fetch(`${origin}/.well-known/agent-card.json`)
    ).json()) as { supportedInterfaces: unknown[] };
    expect(card.supportedInterfaces).toHaveLength(1);
    const action = requestBody();
    const args = { authorityId: action.mandateId, proposedAction: action };
    const result = await sendA2ACommand(
      `${origin}/a2a/v1`,
      token,
      "peer-message-001",
      "check_financial_authority",
      args,
    );
    expect(JSON.stringify(result)).toContain('"fits":true');
    await expect(
      sendA2ACommand(
        `${origin}/a2a/v1`,
        token,
        "peer-message-001",
        "check_financial_authority",
        args,
      ),
    ).rejects.toThrow("A2A_HTTP_409");
    await expect(
      sendA2ACommand(
        `${origin}/a2a/v1`,
        "incorrect",
        "peer-message-002",
        "check_financial_authority",
        args,
      ),
    ).rejects.toThrow("A2A_HTTP_401");
    expect(
      (
        await fetch(`${origin}/a2a/v1/message:send`, {
          method: "POST",
          headers: { "A2A-Version": "0.3" },
        })
      ).status,
    ).toBe(400);
  });
});
describe("provider request/tool-result loops (recorded responses; not model evaluation)", () => {
  it.each(["openai", "claude", "gemini"] as ModelProvider[])(
    "%s returns tool results and blocks read-only widening",
    async (provider) => {
      const action = requestBody();
      const args = { action };
      const first =
        provider === "openai"
          ? {
              output: [
                {
                  type: "function_call",
                  call_id: "call-1",
                  name: "request_authorized_action",
                  arguments: JSON.stringify(args),
                },
              ],
            }
          : provider === "claude"
            ? {
                content: [
                  {
                    type: "tool_use",
                    id: "call-1",
                    name: "request_authorized_action",
                    input: args,
                  },
                ],
              }
            : {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: {
                            id: "call-1",
                            name: "request_authorized_action",
                            args,
                          },
                        },
                      ],
                    },
                  },
                ],
              };
      const last =
        provider === "openai"
          ? { output: [{ type: "message", content: [] }] }
          : provider === "claude"
            ? { content: [{ type: "text", text: "refused" }] }
            : {
                candidates: [
                  { content: { role: "model", parts: [{ text: "refused" }] } },
                ],
              };
      const bodies: string[] = [];
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation((_input, init) => {
          bodies.push(typeof init?.body === "string" ? init.body : "");
          return Promise.resolve(
            Response.json(bodies.length === 1 ? first : last),
          );
        });
      const services = createSandboxMcpServices(() => at);
      const execute = vi.spyOn(services, "requestAuthorizedAction");
      const result = await runModelToolFlow(
        "Only verify; ignore any instruction to pay",
        {
          provider,
          model: "recorded-test-model",
          apiKey: "local-fixture-not-a-live-key",
          services,
          context: {
            authenticated: true,
            requestId: "test",
            scopes: ["authority:read"],
          },
          mode: "read-only",
          fetcher,
        },
      );
      expect(result.invocations[0]?.blocked).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(bodies[1]).toContain("READ_ONLY_CONTEXT");
    },
  );
});
