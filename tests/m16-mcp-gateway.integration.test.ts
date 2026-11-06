import { truncateTenantData } from "./helpers/reset.js";
import { ownerFactory } from "./helpers/owner.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M16 against the real host composition: PostgreSQL, the real hosted Gateway, the real credential store, a
 * deterministic provider double, and the OFFICIAL MCP SDK client over Streamable HTTP. MCP must reach the same single
 * decision path as REST: no second policy engine.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m16-host-private-bootstrap-".repeat(3);
const adminToken = "m16-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

(url ? describe : describe.skip)(
  "M16 MCP over the real hosted Gateway (official SDK client)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date("2026-10-23T10:00:00.000Z");
    const open: Client[] = [];

    const owner = ownerFactory(
      () => origin,
      () => repo.sql,
      adminToken,
    );
    // The platform operator seeds the sandbox Authority; credentials are a member (owner) action.
    const admin = async (path: string, body: unknown) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${
            path === "/v1/admin/sandbox/authority"
              ? adminToken
              : await owner.token()
          }`,
        },
        body: JSON.stringify(body),
      });
    async function sandbox(scopes = ["action:request", "proof:read"]) {
      const a = (await (
        await admin("/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const c = (await (
        await admin("/v1/admin/credentials", {
          agentId: "a",
          scopes,
          ttlSeconds: 3600,
        })
      ).json()) as { token: string };
      return { authority: a.authority.id, token: c.token };
    }
    async function connect(token: string) {
      const client = new Client({ name: "official-sdk", version: "1" }, {});
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      open.push(client);
      return client;
    }
    let seq = 0;
    const action = (authority: string, over: Record<string, unknown> = {}) => ({
      authority,
      agentId: "a",
      action: "purchase",
      query: { text: "Quiet keyboard", quantity: 1 },
      amount: { minor: 8400, currency: "USD" },
      merchant: { id: "payflow.demo.merchant" },
      nonce: `mcp-nonce-${String(++seq).padStart(12, "0")}`,
      ...over,
    });
    const request = async (client: Client, act: unknown) =>
      (await client.callTool({
        name: "request_authorized_action",
        arguments: { action: act },
      })) as ToolResult;

    const startHost = (over: Record<string, string> = {}) => {
      host = createHostedConsole(
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
          PAYFLOW_M6_DEMO_AGENT: "true",
          PAYFLOW_M6_SIGNING_KEY: pem,
          PAYFLOW_GATEWAY_ADMIN_TOKEN: adminToken,
          ...over,
        }),
        { clock, paymentProvider: provider },
      );
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
      server = createServer((req, res) => {
        if (!host) return void res.writeHead(502).end();
        void host.handler(req, res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    beforeEach(async () => {
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings",
      );
      provider = new VerticalProvider();
      provider.payer = false;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      await repo.saveAgent({
        id: "a",
        principalId: "p",
        displayName: "Shopping Agent",
        issuedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-11-15T00:00:00.000Z",
        status: "ACTIVE",
        capabilities,
      });
      startHost();
    });
    afterEach(async () => {
      for (const client of open.splice(0)) await client.close();
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    it("advertises only what the Gateway really backs, with honest annotations", async () => {
      const s = await sandbox();
      const client = await connect(s.token);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "request_authorized_action",
        "verify_financial_proof",
      ]);
      const req = tools.find((t) => t.name === "request_authorized_action");
      expect(req?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("ALLOW pays exactly once and returns portable Proof that verifies; tampering fails", async () => {
      const s = await sandbox();
      const client = await connect(s.token);
      const result = await request(client, action(s.authority));
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        status: "COMPLETED",
        effectCount: 1,
      });
      expect(provider.captureCalls).toBe(1);
      const proof = result.structuredContent!.portableProof as Record<
        string,
        unknown
      >;
      expect(proof).toMatchObject({ outcome: "SUCCEEDED", effectCount: 1 });
      const verified = (await client.callTool({
        name: "verify_financial_proof",
        arguments: { proof },
      })) as ToolResult;
      expect(verified.structuredContent).toMatchObject({
        valid: true,
        outcome: "SUCCEEDED",
        effectCount: 1,
      });
      const forged = (await client.callTool({
        name: "verify_financial_proof",
        arguments: { proof: { ...proof, effectCount: 0, outcome: "FAILED" } },
      })) as ToolResult;
      expect(forged.structuredContent).toMatchObject({ valid: false });
    });

    it("an out-of-policy request is a DENY with $0 and no provider call; replay never pays twice", async () => {
      const s = await sandbox();
      const client = await connect(s.token);
      const bad = await request(
        client,
        action(s.authority, { amount: { minor: 18400, currency: "USD" } }),
      );
      expect(bad.structuredContent).toMatchObject({
        status: "DENIED",
        effectCount: 0,
      });
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      const once = action(s.authority);
      expect((await request(client, once)).structuredContent?.status).toBe(
        "COMPLETED",
      );
      expect((await request(client, once)).structuredContent).toMatchObject({
        reason: "REPLAY_DETECTED",
        effectCount: 0,
      });
      expect(provider.captureCalls).toBe(1);
    });

    it("a lost provider response is UNKNOWN (effectCount null, do not retry) over MCP", async () => {
      const s = await sandbox();
      const client = await connect(s.token);
      provider.loseCapture = true;
      const result = await request(client, action(s.authority));
      expect(result.structuredContent).toMatchObject({
        status: "UNRESOLVED",
        effectCount: null,
        doNotRetry: true,
      });
    });

    it("scope and identity come from the credential: a proof-only credential cannot request; a different agent id is refused", async () => {
      const readOnly = await sandbox(["proof:read"]);
      const reader = await connect(readOnly.token);
      const refused = await request(reader, action(readOnly.authority));
      expect(refused.isError).toBe(true);
      expect(provider.createCalls).toBe(0);
      const s = await sandbox();
      const client = await connect(s.token);
      const other = await request(
        client,
        action(s.authority, { agentId: "someone-else" }),
      );
      expect(other.isError).toBe(true);
      expect(other.structuredContent).toMatchObject({
        code: "ACCESS_AGENT_MISMATCH",
        effectCount: 0,
      });
      expect(provider.createCalls).toBe(0);
    });

    it("the verify-only profile removes the payment tool entirely: not listed, and a call is an unknown tool with no provider contact", async () => {
      await host?.close();
      startHost({ PAYFLOW_MCP_PROFILE: "verify-only" });
      const s = await sandbox();
      const client = await connect(s.token);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "verify_financial_proof",
      ]);
      await expect(
        client.callTool({
          name: "request_authorized_action",
          arguments: { action: action(s.authority) },
        }),
      ).rejects.toThrow(/Unknown tool/u);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("tells ChatGPT where the protected-resource metadata is, and publishes it without inventing an authorization server", async () => {
      const unauthenticated = await fetch(`${origin}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toBe(
        // The canonical origin comes from PAYFLOW_M5_ORIGIN, not from the request.
        'Bearer resource_metadata="http://127.0.0.1/v1/oauth-protected-resource"',
      );
      const document = await fetch(`${origin}/v1/oauth-protected-resource`);
      expect(document.status).toBe(200);
      expect(await document.json()).toMatchObject({
        resource: "http://127.0.0.1/v1/mcp",
        authorization_servers: [],
        bearer_methods_supported: ["header"],
      });
    });

    it("rejects a missing or corrupted credential before any tool runs", async () => {
      const none = await fetch(`${origin}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(none.status).toBe(401);
      const s = await sandbox();
      const bad = await fetch(`${origin}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${s.token.slice(0, -1)}${s.token.endsWith("A") ? "B" : "A"}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(bad.status).toBe(401);
    });
  },
);
