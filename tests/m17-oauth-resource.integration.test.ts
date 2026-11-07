import { truncateTenantData } from "./helpers/reset.js";
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
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M17 OAuth resource-server behaviour against the real host: PostgreSQL, real HTTP, the official MCP SDK client, and access
 * tokens signed by a TEST identity provider key (a stand-in for a real IdP; PayFlow issues no OAuth tokens). This is not a
 * ChatGPT connection and proves nothing about any real identity provider's configuration.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m17-host-private-bootstrap-".repeat(3);
const adminToken = "m17-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const ISSUER = "https://idp.example";
const RESOURCE = "http://127.0.0.1/v1/mcp";
const NOW_S = Math.floor(Date.parse("2026-10-23T10:00:00.000Z") / 1000);

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

(url ? describe : describe.skip)(
  "M17 OAuth resource server over the real hosted Gateway",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date("2026-10-23T10:00:00.000Z");
    const open: Client[] = [];
    let idp: Awaited<ReturnType<typeof generateKeyPair>>;
    let otherIdp: Awaited<ReturnType<typeof generateKeyPair>>;
    let es384: Awaited<ReturnType<typeof generateKeyPair>>;
    let jwks: { keys: JWK[] };
    const owners = new Map<string, string>();
    let seq = 0;

    const call = (
      token: string | null,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ownerOf = async (organizationId = "payflow-sandbox") => {
      const cached = owners.get(organizationId);
      if (cached) return cached;
      await repo.sql`insert into organizations (id, display_name) values (${organizationId}, 'T') on conflict (id) do nothing`;
      const r = await call(adminToken, "POST", "/v1/admin/members", {
        organizationId,
        environment: "SANDBOX",
        displayName: "owner",
        role: "OWNER",
      });
      const t = ((await r.json()) as { token: string }).token;
      owners.set(organizationId, t);
      return t;
    };
    const roleToken = async (role: string) => {
      const r = await call(await ownerOf(), "POST", "/v1/admin/members", {
        displayName: `m17 ${role}`,
        role,
      });
      return ((await r.json()) as { token: string }).token;
    };
    async function authority() {
      const r = await call(
        adminToken,
        "POST",
        "/v1/admin/sandbox/authority",
        {},
      );
      return ((await r.json()) as { authority: { id: string } }).authority.id;
    }
    const map = (
      token: string,
      body: Record<string, unknown> = {},
    ): Promise<Response> =>
      call(token, "POST", "/v1/admin/org/oauth-identities", {
        subject: "user-123",
        agentId: "a",
        maxScopes: ["action:request", "authority:read"],
        ...body,
      });
    async function mapOk(body: Record<string, unknown> = {}) {
      const r = await map(await ownerOf(), body);
      expect(r.status).toBe(201);
      return ((await r.json()) as { identity: { mappingId: string } }).identity;
    }
    const jwt = async (
      claims: JWTPayload = {},
      over: {
        key?: CryptoKey | Uint8Array;
        alg?: string;
        iss?: string;
        aud?: string | string[];
        sub?: string | null;
        iat?: number;
        exp?: number;
        scope?: string;
      } = {},
    ) => {
      let b = new SignJWT({
        scope: over.scope ?? "action:request authority:read",
        ...claims,
      })
        .setProtectedHeader({
          alg: over.alg ?? "ES256",
          kid: over.alg === "ES384" ? "idp-2" : "idp-1",
        })
        .setIssuer(over.iss ?? ISSUER)
        .setAudience(over.aud ?? RESOURCE)
        .setIssuedAt(over.iat ?? NOW_S - 60)
        .setExpirationTime(over.exp ?? NOW_S + 3600);
      if (over.sub !== null) b = b.setSubject(over.sub ?? "user-123");
      return b.sign(over.key ?? idp.privateKey);
    };
    const ping = (token: string) =>
      fetch(`${origin}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    async function connect(token?: string) {
      const client = new Client({ name: "official-sdk", version: "1" }, {});
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`), {
          requestInit: token
            ? { headers: { Authorization: `Bearer ${token}` } }
            : {},
        }),
      );
      open.push(client);
      return client;
    }
    const action = (auth: string, over: Record<string, unknown> = {}) => ({
      authority: auth,
      agentId: "a",
      action: "purchase",
      query: { text: "Quiet keyboard", quantity: 1 },
      amount: { minor: 8400, currency: "USD" },
      merchant: { id: "payflow.demo.merchant" },
      nonce: `m17-nonce-${String(++seq).padStart(12, "0")}`,
      ...over,
    });
    const buy = (client: Client, act: unknown) =>
      client.callTool({
        name: "request_authorized_action",
        arguments: { action: act },
      }) as Promise<ToolResult>;

    const startHost = (over: Record<string, string> = {}, oauth = true) => {
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
          ...(oauth
            ? {
                PAYFLOW_OAUTH_ISSUER: ISSUER,
                PAYFLOW_OAUTH_JWKS_URL: `${ISSUER}/jwks.json`,
              }
            : {}),
          ...over,
        }),
        {
          clock,
          paymentProvider: provider,
          oauthKeys: createLocalJWKSet(jwks),
        },
      );
    };

    beforeAll(async () => {
      idp = await generateKeyPair("ES256");
      otherIdp = await generateKeyPair("ES256");
      es384 = await generateKeyPair("ES384");
      jwks = {
        keys: [
          {
            ...(await exportJWK(idp.publicKey)),
            kid: "idp-1",
            alg: "ES256",
            use: "sig",
          },
          {
            ...(await exportJWK(es384.publicKey)),
            kid: "idp-2",
            alg: "ES384",
            use: "sig",
          },
        ],
      };
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
      owners.clear();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,oauth_identity_mappings",
      );
      provider = new VerticalProvider();
      provider.payer = false;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      for (const id of ["a", "b"])
        await repo.saveAgent({
          id,
          principalId: "p",
          displayName: `Agent ${id}`,
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities,
        });
      startHost();
    });
    afterEach(async () => {
      for (const c of open.splice(0)) await c.close();
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    it("a mapped identity with a valid token completes a real governed purchase through the official MCP client", async () => {
      const auth = await authority();
      await ownerOf();
      await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
        values ('payflow-sandbox','b','SANDBOX','p') on conflict do nothing`;
      await mapOk();
      const client = await connect(await jwt());
      const r = await buy(client, action(auth));
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({
        status: "COMPLETED",
        effectCount: 1,
      });
      expect(provider.captureCalls).toBe(1);
    });

    it("refuses every bad token with a bare 401 and runs nothing", async () => {
      await authority();
      await mapOk();
      const wrongAlgNone = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: RESOURCE,
          sub: "user-123",
          iat: NOW_S - 60,
          exp: NOW_S + 3600,
          scope: "action:request",
        }),
      ).toString("base64url")}.`;
      const cases: Record<string, string> = {
        "wrong issuer": await jwt({}, { iss: "https://idp.example/" }),
        "issuer prefix": await jwt({}, { iss: "https://idp.example.evil" }),
        "other audience": await jwt({}, { aud: "https://other.example/mcp" }),
        "audience list without us": await jwt(
          {},
          { aud: ["https://a", "https://b"] },
        ),
        expired: await jwt({}, { exp: NOW_S - 10 }),
        "issued in the future": await jwt(
          {},
          { iat: NOW_S + 3600, exp: NOW_S + 7200 },
        ),
        "signed by another key": await jwt({}, { key: otherIdp.privateKey }),
        "no subject": await jwt({}, { sub: null }),
        "unmapped subject": await jwt({}, { sub: "stranger" }),
        "alg none": wrongAlgNone,
        // A key the issuer published, but an algorithm PayFlow does not accept.
        "algorithm outside the allowlist": await jwt(
          {},
          { key: es384.privateKey, alg: "ES384" },
        ),
        garbage: "aaa.bbb.ccc",
      };
      for (const [name, token] of Object.entries(cases)) {
        const r = await ping(token);
        expect(r.status, name).toBe(401);
        expect(await r.text(), name).not.toMatch(
          /idp|mapping|subject|signature/iu,
        );
      }
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("scopes only narrow: the token cannot exceed the stored mapping, and unknown scopes are dropped", async () => {
      const auth = await authority();
      await mapOk({ maxScopes: ["authority:read"] });
      // Token asks for more than the mapping allows: only authority:read survives, so the payment tool is refused.
      const client = await connect(
        await jwt({}, { scope: "action:request authority:read admin" }),
      );
      const denied = await buy(client, action(auth)).catch((e) => e as Error);
      expect(
        denied instanceof Error ? denied.message : JSON.stringify(denied),
      ).toMatch(/scope|denied|ACCESS/iu);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      // Nothing allowed remains: 401.
      expect(
        (await ping(await jwt({}, { scope: "action:request" }))).status,
      ).toBe(401);
      expect((await ping(await jwt({}, { scope: "" }))).status).toBe(401);
    });

    it("tenant, agent, principal and client id come from the mapping, never from token claims", async () => {
      const auth = await authority();
      await mapOk();
      const forged = await jwt({
        agent_id: "b",
        principal_id: "attacker",
        client_id: "forged",
        organization_id: "other-org",
        org: "other-org",
      });
      const client = await connect(forged);
      // The mapped agent is "a"; acting as the claimed "b" is refused, acting as "a" works.
      const asB = await buy(client, action(auth, { agentId: "b" })).catch(
        (e) => e as Error,
      );
      expect(
        asB instanceof Error ||
          asB.isError === true ||
          asB.structuredContent?.status !== "COMPLETED",
      ).toBe(true);
      expect(provider.captureCalls).toBe(0);
      const asA = await buy(client, action(auth));
      expect(asA.structuredContent).toMatchObject({ status: "COMPLETED" });
    });

    it("a revoked mapping or a suspended agent stops working at the next request", async () => {
      const auth = await authority();
      const m = await mapOk();
      const token = await jwt();
      expect((await ping(token)).status).toBe(200);
      const revoke = await call(
        await ownerOf(),
        "POST",
        `/v1/admin/org/oauth-identities/${m.mappingId}/revoke`,
        {},
      );
      expect(revoke.status).toBe(200);
      expect((await ping(token)).status).toBe(401);
      await mapOk();
      expect((await ping(token)).status).toBe(200);
      await repo.sql`update organization_agents set lifecycle = 'SUSPENDED' where agent_id = 'a'`;
      expect((await ping(token)).status).toBe(401);
      void auth;
    });

    it("mapping management is owner-only, tenant-scoped, validated, unique and audited", async () => {
      await authority();
      const owner = await ownerOf();
      for (const role of [
        "DEVELOPER",
        "FINANCE_ADMIN",
        "SECURITY_ADMIN",
        "AUDITOR",
        "VIEWER",
      ])
        expect((await map(await roleToken(role))).status, role).toBe(403);
      expect(
        (
          await call(
            await roleToken("AUDITOR"),
            "GET",
            "/v1/admin/org/oauth-identities",
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            await roleToken("DEVELOPER"),
            "GET",
            "/v1/admin/org/oauth-identities",
          )
        ).status,
      ).toBe(403);
      const first = await map(owner);
      expect(first.status).toBe(201);
      const id = ((await first.json()) as { identity: { mappingId: string } })
        .identity.mappingId;
      expect((await map(owner)).status).toBe(409);
      expect(
        (await map(owner, { subject: "u2", agentId: "ghost" })).status,
      ).toBe(400);
      expect(
        (await map(owner, { subject: "u3", maxScopes: ["root"] })).status,
      ).toBe(400);
      expect((await map(owner, { subject: "u4", maxScopes: [] })).status).toBe(
        400,
      );
      const theirs = await ownerOf("org-other");
      expect(
        (
          await call(
            theirs,
            "POST",
            `/v1/admin/org/oauth-identities/${id}/revoke`,
            {},
          )
        ).status,
      ).toBe(404);
      const seen = (await (
        await call(theirs, "GET", "/v1/admin/org/oauth-identities")
      ).json()) as { identities: unknown[] };
      expect(seen.identities).toEqual([]);
      const audit =
        await repo.sql`select action from organization_audit_events where subject_kind = 'OAUTH_IDENTITY'`;
      expect(audit.map((a) => String(a.action))).toContain(
        "OAUTH_IDENTITY_MAPPED",
      );
    });

    it("publishes the configured issuer in the protected-resource metadata, and still never invents one when none is configured", async () => {
      const doc = (await (
        await fetch(`${origin}/v1/oauth-protected-resource`)
      ).json()) as unknown;
      expect(doc).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
      });
      await host?.close();
      startHost({}, false);
      const none = (await (
        await fetch(`${origin}/v1/oauth-protected-resource`)
      ).json()) as unknown;
      expect(none).toMatchObject({ authorization_servers: [] });
      // With no issuer configured a JWT-shaped bearer is simply not accepted.
      expect((await ping(await jwt())).status).toBe(401);
    });

    it("verify-only + anonymous: the public verification tool works with no credential and nothing else is reachable", async () => {
      await host?.close();
      startHost(
        {
          PAYFLOW_MCP_PROFILE: "verify-only",
          PAYFLOW_MCP_ANONYMOUS_VERIFY: "true",
        },
        false,
      );
      const client = await connect();
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual([
        "verify_financial_proof",
      ]);
      const r = (await client.callTool({
        name: "verify_financial_proof",
        arguments: { proof: { not: "a proof" } },
      })) as ToolResult;
      expect(JSON.stringify(r)).not.toMatch(/"verified":true/u);
      await expect(
        client.callTool({
          name: "request_authorized_action",
          arguments: { action: {} },
        }),
      ).rejects.toThrow();
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("anonymous access is off by default and cannot be enabled outside the verify-only profile", async () => {
      await host?.close();
      startHost({ PAYFLOW_MCP_PROFILE: "verify-only" }, false);
      expect(
        (
          await fetch(`${origin}/v1/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
          })
        ).status,
      ).toBe(401);
      expect(() =>
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
          PAYFLOW_MCP_ANONYMOUS_VERIFY: "true",
        }),
      ).toThrow("REQUIRES_VERIFY_ONLY");
      expect(() =>
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
          PAYFLOW_OAUTH_ISSUER: ISSUER,
        }),
      ).toThrow("GO_TOGETHER");
    });

    it("an OAuth token with action:request still cannot reach a payment on a verify-only host", async () => {
      const auth = await authority();
      await mapOk();
      await host?.close();
      startHost({ PAYFLOW_MCP_PROFILE: "verify-only" });
      const client = await connect(await jwt());
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
        "request_authorized_action",
      );
      await expect(buy(client, action(auth))).rejects.toThrow();
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });
  },
);
