import { describe, expect, it } from "vitest";
import { handleMcpMessage } from "../src/protocols/mcp-server.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
import {
  DECISION_WIDGET_HTML,
  DECISION_WIDGET_URI,
  MCP_APP_MIME,
  protectedResourceMetadata,
  wwwAuthenticate,
} from "../src/protocols/chatgpt-app.js";
import { MCP_TOOL_SCOPES, PAYFLOW_MCP_TOOLS } from "../src/protocols/mcp.js";

const services = createSandboxMcpServices(() => "2026-10-28T03:00:00.000Z");
type Meta = Record<string, unknown>;
interface Listed {
  name: keyof typeof MCP_TOOL_SCOPES;
  title: string;
  _meta: Meta & { ui?: { resourceUri: string }; securitySchemes: unknown };
}
const ask = (method: string, params?: unknown) =>
  handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
    { services, authenticated: false },
  ) as Promise<{
    result: {
      tools: Listed[];
      resources: unknown[];
      contents: { text: string; mimeType: string }[];
    };
    error?: { code: number };
  }>;

describe("M17 ChatGPT / MCP Apps tool contract", () => {
  it("declares auth per tool, with exactly the scope the server enforces, and a human title", async () => {
    const { result } = await ask("tools/list");
    expect(result.tools).toHaveLength(PAYFLOW_MCP_TOOLS.length);
    for (const tool of result.tools) {
      expect(tool.title.length).toBeGreaterThan(3);
      expect(tool._meta.securitySchemes).toEqual([
        { type: "oauth2", scopes: [MCP_TOOL_SCOPES[tool.name]] },
      ]);
      expect(tool._meta["openai/toolInvocation/invoking"]).toBeTruthy();
      // Descriptions stay short enough to be read, and no tool claims it is read-only while able to move money.
      expect(tool.name).toBeTruthy();
    }
  });

  it("attaches the result card only to the tools that return a decision or Proof verdict", async () => {
    const { result } = await ask("tools/list");
    const withUi = result.tools
      .filter((tool) => tool._meta.ui)
      .map((tool) => tool.name)
      .sort();
    expect(withUi).toEqual([
      "request_authorized_action",
      "verify_financial_proof",
    ]);
    for (const tool of result.tools)
      if (tool._meta.ui) {
        expect(tool._meta.ui.resourceUri).toBe(DECISION_WIDGET_URI);
        expect(tool._meta["openai/outputTemplate"]).toBe(DECISION_WIDGET_URI);
      }
  });

  it("serves the card as an MCP Apps resource and refuses any other URI", async () => {
    const list = await ask("resources/list");
    expect(list.result.resources).toEqual([
      expect.objectContaining({
        uri: DECISION_WIDGET_URI,
        mimeType: MCP_APP_MIME,
      }),
    ]);
    const read = await ask("resources/read", { uri: DECISION_WIDGET_URI });
    expect(read.result.contents[0]?.text).toBe(DECISION_WIDGET_HTML);
    expect(read.result.contents[0]?.mimeType).toBe(MCP_APP_MIME);
    expect(
      (await ask("resources/read", { uri: "ui://widget/other.html" })).error
        ?.code,
    ).toBe(-32602);
  });

  it("the card never uses innerHTML or the network and is self-contained", () => {
    expect(DECISION_WIDGET_HTML).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/u,
    );
    expect(DECISION_WIDGET_HTML).not.toMatch(
      /fetch\(|XMLHttpRequest|WebSocket|<link |src=["']http/u,
    );
    expect(DECISION_WIDGET_HTML).toContain("UNKNOWN");
  });

  it("publishes honest protected-resource metadata and a challenge ChatGPT can follow", () => {
    const meta = protectedResourceMetadata({
      resource: "https://payflow.example/v1/mcp",
      authorizationServers: [],
      documentation: "https://payflow.example/docs/",
    });
    expect(meta.resource).toBe("https://payflow.example/v1/mcp");
    // No authorization server is invented: it is empty until one is commissioned.
    expect(meta.authorization_servers).toEqual([]);
    expect(meta.scopes_supported.sort()).toEqual(
      [...new Set(Object.values(MCP_TOOL_SCOPES))].sort(),
    );
    expect(wwwAuthenticate("https://payflow.example/v1/mcp")).toBe(
      'Bearer resource_metadata="https://payflow.example/.well-known/oauth-protected-resource"',
    );
  });
});
