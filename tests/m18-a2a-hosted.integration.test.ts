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
import { PostgresDelegationRegistry } from "../src/network/delegation.js";
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

(url ? describe : describe.skip)(
  "M18 A2A delegation over the real hosted Gateway (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date("2026-10-23T10:00:00.000Z");

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
        }),
        { clock, paymentProvider: provider },
      );
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    let registry: PostgresDelegationRegistry;
    let msg = 0;
    const NOW = "2026-10-23T09:00:00.000Z";
    const EXP = "2026-10-24T09:00:00.000Z";
    const scope = (parent: string, child: string, max: number) => ({
      principalId: "p",
      parentAgentId: parent,
      childAgentId: child,
      audience: "payflow-gateway-v1",
      actionKinds: ["PURCHASE"],
      currencies: ["USD"],
      counterpartyIds: ["payflow.demo.merchant"],
      maxAmountMinor: max,
      issuedAt: NOW,
      expiresAt: EXP,
      nonce: `a2a-deleg-nonce-${String(++seq).padStart(8, "0")}`,
    });
    /** orchestrator → "a" (the credential's agent), with the given caps at each hop. */
    async function chain(rootCap: number, leafCap: number) {
      const root = await registry.issueRoot(
        scope("principal", "orchestrator", rootCap),
        NOW,
      );
      if (!root.ok) throw new Error(root.reason);
      const leaf = await registry.delegate(
        root.delegationId,
        scope("orchestrator", "a", leafCap),
        NOW,
      );
      if (!leaf.ok) throw new Error(leaf.reason);
      return { root: root.delegationId, leaf: leaf.delegationId };
    }
    const send = (
      token: string,
      args: Record<string, unknown>,
      delegation?: unknown,
      messageId = `m18-msg-${String(++msg).padStart(6, "0")}`,
    ) =>
      fetch(`${origin}/v1/a2a/message:send`, {
        method: "POST",
        headers: {
          "content-type": "application/a2a+json",
          "A2A-Version": "1.0",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: {
            messageId,
            role: "ROLE_USER",
            parts: [
              {
                data: {
                  tool: "request_authorized_action",
                  arguments: args,
                  ...(delegation === undefined ? {} : { delegation }),
                },
              },
            ],
          },
        }),
      });
    const result = async (r: Response) =>
      (
        (await r.json()) as {
          message?: { parts: { data: { result: Record<string, unknown> } }[] };
        }
      ).message?.parts[0]?.data.result;

    it("publishes an agent card that points at the hosted interface", async () => {
      const card = (await (
        await fetch(`${origin}/v1/a2a/agent-card.json`)
      ).json()) as {
        supportedInterfaces: { url: string }[];
      };
      expect(card.supportedInterfaces[0]?.url).toBe("http://127.0.0.1/v1/a2a");
    });

    it("a delegated purchase pays once, charges the whole chain, and the next one is refused by the shared budget", async () => {
      registry = new PostgresDelegationRegistry(repo.sql);
      const s = await sandbox();
      const c = await chain(10_000, 10_000);
      const first = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: c.leaf },
      );
      expect(first.status).toBe(200);
      expect(await result(first)).toMatchObject({
        status: "COMPLETED",
        effectCount: 1,
      });
      expect(await registry.remaining(c.root)).toBe(1_600);
      expect(await registry.remaining(c.leaf)).toBe(1_600);
      const second = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: c.leaf },
      );
      expect(second.status).toBe(403);
      expect(provider.captureCalls).toBe(1);
      expect(await registry.remaining(c.root)).toBe(1_600);
    });

    it("a known-zero-effect DENY gives the budget back; an UNKNOWN outcome keeps it", async () => {
      registry = new PostgresDelegationRegistry(repo.sql);
      const s = await sandbox();
      const c = await chain(50_000, 50_000);
      const denied = await send(
        s.token,
        {
          action: action(s.authority, {
            amount: { minor: 18_400, currency: "USD" },
          }),
        },
        { delegationId: c.leaf },
      );
      expect(await result(denied)).toMatchObject({
        status: "DENIED",
        effectCount: 0,
      });
      expect(await registry.remaining(c.root)).toBe(50_000);
      provider.loseCapture = true;
      const unknown = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: c.leaf },
      );
      expect(await result(unknown)).toMatchObject({
        status: "UNRESOLVED",
        effectCount: null,
      });
      expect(await registry.remaining(c.root)).toBe(50_000 - 8_400);
    });

    it("revocation stops the next delegated request before the Gateway or the provider is touched", async () => {
      registry = new PostgresDelegationRegistry(repo.sql);
      const s = await sandbox();
      const c = await chain(10_000, 10_000);
      await registry.revoke(c.root, "orchestrator compromised", NOW);
      const refused = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: c.leaf },
      );
      expect(refused.status).toBe(403);
      expect(JSON.stringify(await refused.json())).toContain("REVOKED");
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("a replayed message id is a 409 and is not charged twice", async () => {
      registry = new PostgresDelegationRegistry(repo.sql);
      const s = await sandbox();
      const c = await chain(50_000, 50_000);
      const body = { action: action(s.authority) };
      const once = await send(
        s.token,
        body,
        { delegationId: c.leaf },
        "m18-fixed-message-id",
      );
      expect(once.status).toBe(200);
      const after = await registry.remaining(c.root);
      const replay = await send(
        s.token,
        body,
        { delegationId: c.leaf },
        "m18-fixed-message-id",
      );
      expect(replay.status).toBe(409);
      expect(await registry.remaining(c.root)).toBe(after);
      expect(provider.captureCalls).toBe(1);
    });

    it("a delegation cannot be borrowed: another agent's credential, a made-up id and an inline scope all fail closed", async () => {
      registry = new PostgresDelegationRegistry(repo.sql);
      const s = await sandbox();
      const root = await registry.issueRoot(
        scope("principal", "orchestrator", 10_000),
        NOW,
      );
      if (!root.ok) throw new Error(root.reason);
      const notMine = await registry.delegate(
        root.delegationId,
        scope("orchestrator", "someone-else", 10_000),
        NOW,
      );
      if (!notMine.ok) throw new Error(notMine.reason);
      const borrowed = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: notMine.delegationId },
      );
      expect(borrowed.status).toBe(403);
      expect(JSON.stringify(await borrowed.json())).toContain("AGENT_MISMATCH");
      const invented = await send(
        s.token,
        { action: action(s.authority) },
        { delegationId: "dlg_000000000000000000000000" },
      );
      expect(invented.status).toBe(403);
      const inline = await send(
        s.token,
        { action: action(s.authority) },
        scope("principal", "a", 99_999),
      );
      expect(inline.status).toBe(403);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });
  },
);
