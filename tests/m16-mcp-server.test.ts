import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { handleMcpMessage } from "../src/protocols/mcp-server.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
import { PAYFLOW_MCP_TOOLS } from "../src/protocols/mcp.js";
import { requestBody } from "../src/network/live-fault-injector.js";

const now = () => "2026-10-28T03:00:00.000Z";
const call = (
  authenticated: boolean,
  name: string,
  args: unknown,
  services = createSandboxMcpServices(now),
) =>
  handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { services, authenticated },
  ) as Promise<{
    result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: { text: string }[];
    };
  }>;

describe("M16 MCP server (JSON-RPC handler)", () => {
  it("initializes and lists exactly the five-tool vocabulary with read/execute separation", async () => {
    const services = createSandboxMcpServices(now);
    const init = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { services, authenticated: false },
    );
    expect(
      (init as { result: { serverInfo: { name: string } } }).result.serverInfo
        .name,
    ).toBe("payflow-financial-authority");
    const list = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { services, authenticated: false },
    )) as {
      result: {
        tools: { name: string; annotations: { readOnlyHint: boolean } }[];
      };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(
      PAYFLOW_MCP_TOOLS.map((tool) => tool.name),
    );
    const readOnly = list.result.tools
      .filter((tool) => tool.annotations.readOnlyHint)
      .map((tool) => tool.name);
    expect(readOnly).toEqual([
      "check_financial_authority",
      "verify_authority",
      "verify_financial_proof",
    ]);
  });

  it("refuses every tool call when the transport did not authenticate the caller", async () => {
    for (const tool of PAYFLOW_MCP_TOOLS) {
      const reply = await call(false, tool.name, {});
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0]?.text).toBe("MCP_AUTHENTICATION_REQUIRED");
    }
  });

  it("check_financial_authority is read-only: it never consumes the replay key or issues a capability", async () => {
    const services = createSandboxMcpServices(now);
    const body = requestBody();
    const first = await call(
      true,
      "check_financial_authority",
      { authorityId: "benchmark-authority", proposedAction: body },
      services,
    );
    const second = await call(
      true,
      "check_financial_authority",
      { authorityId: "benchmark-authority", proposedAction: body },
      services,
    );
    expect(first.result.structuredContent?.fits).toBe(true);
    expect(second.result.structuredContent?.fits).toBe(true);
    const real = await call(
      true,
      "request_authorized_action",
      { action: body },
      services,
    );
    expect(real.result.structuredContent?.decision).toBe("ALLOW");
  });

  it("request_authorized_action allows once, denies drift, denies replay, and exposes no secrets", async () => {
    const services = createSandboxMcpServices(now);
    const ok = await call(
      true,
      "request_authorized_action",
      { action: requestBody() },
      services,
    );
    expect(ok.result.structuredContent?.decision).toBe("ALLOW");
    const replay = await call(
      true,
      "request_authorized_action",
      { action: requestBody() },
      services,
    );
    expect(replay.result.structuredContent?.decision).toBe("DENY");
    expect(replay.result.structuredContent?.reasonCodes).toContain(
      "REPLAY_DETECTED",
    );
    const drift = await call(
      true,
      "request_authorized_action",
      {
        action: requestBody({
          nonce: "drift-nonce-0000001",
          amount: { currency: "USD", minor: 99_999 },
        }),
      },
      services,
    );
    expect(drift.result.structuredContent?.decision).toBe("DENY");
    expect(drift.result.structuredContent?.executionCapability).toBeNull();
    expect(JSON.stringify([ok, replay, drift])).not.toMatch(
      /secret|private|password|access_token/iu,
    );
  });

  it("fails closed on verification without trusted keys and keeps reconciliation lookup-only", async () => {
    const verify = await call(true, "verify_authority", {
      presentation: {},
      audience: "a",
      challenge: "c".repeat(16),
    });
    expect(verify.result.structuredContent?.verdict).toBe("INVALID");
    const proof = await call(true, "verify_financial_proof", { proof: {} });
    expect(proof.result.structuredContent?.valid).toBe(false);
    const reconcile = await call(true, "reconcile_financial_action", {
      attemptId: "attempt-never-executed",
    });
    expect(reconcile.result.structuredContent).toMatchObject({
      state: "UNKNOWN",
      effectCount: null,
    });
  });

  it("rejects unknown tools and methods with protocol errors", async () => {
    const services = createSandboxMcpServices(now);
    const unknownTool = (await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "transfer_funds", arguments: {} },
      },
      { services, authenticated: true },
    )) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
      { services, authenticated: true },
    )) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
    expect(
      await handleMcpMessage("garbage", { services, authenticated: true }),
    ).toMatchObject({ error: { code: -32600 } });
  });
});

describe("M16 MCP server over stdio (real subprocess client)", () => {
  async function session(env: Record<string, string>) {
    const child = spawn("npx", ["tsx", "packages/mcp-server/src/stdio.ts"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown> & {
        id: number;
      };
      pending.get(message.id)?.(message);
    });
    let nextId = 1;
    const request = (method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    return { request, close: () => child.kill() };
  }

  it("speaks MCP over stdio: initialize, list, authenticated call; unauthenticated call refused", async () => {
    const authed = await session({ PAYFLOW_MCP_ACCESS_TOKEN: "local-sandbox" });
    try {
      const init = (await authed.request("initialize", {})) as {
        result: { protocolVersion: string };
      };
      expect(init.result.protocolVersion).toBeTruthy();
      const list = (await authed.request("tools/list")) as {
        result: { tools: unknown[] };
      };
      expect(list.result.tools).toHaveLength(5);
      const reply = (await authed.request("tools/call", {
        name: "check_financial_authority",
        arguments: {
          authorityId: "benchmark-authority",
          proposedAction: requestBody(),
        },
      })) as {
        result: { isError: boolean; structuredContent: { fits: boolean } };
      };
      expect(reply.result.isError).toBe(false);
      expect(reply.result.structuredContent.fits).toBe(true);
      const malformed = (await authed.request("tools/call", {
        name: "check_financial_authority",
        arguments: { authorityId: "benchmark-authority", proposedAction: {} },
      })) as { result: { isError: boolean; content: { text: string }[] } };
      expect(malformed.result.isError).toBe(true);
      expect(malformed.result.content[0]?.text).toBe("REQUEST_MALFORMED");
    } finally {
      authed.close();
    }
    const anonymous = await session({ PAYFLOW_MCP_ACCESS_TOKEN: "" });
    try {
      const reply = (await anonymous.request("tools/call", {
        name: "request_authorized_action",
        arguments: { action: {} },
      })) as { result: { isError: boolean } };
      expect(reply.result.isError).toBe(true);
    } finally {
      anonymous.close();
    }
  }, 60_000);
});
