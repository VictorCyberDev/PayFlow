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
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { PostgresNetworkStore } from "../src/network/postgres-adapters.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m7-host-private-bootstrap-".repeat(3);
const adminToken = "m7-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M7 hosted Gateway on the real host composition (PostgreSQL + real HTTP + real SDK)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date("2026-10-23T10:00:00.000Z");
    const env = (over: Record<string, string | undefined> = {}) => ({
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
    });
    const admin = (
      path: string,
      body?: unknown,
      token: string | null = adminToken,
    ) =>
      fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    async function sandbox() {
      const a = (await (
        await admin("/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const c = (await (
        await admin("/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request", "proof:read"],
          ttlSeconds: 3600,
        })
      ).json()) as { token: string };
      return {
        authority: a.authority.id,
        token: c.token,
        client: new PayFlowClient({ baseUrl: origin, accessToken: c.token }),
      };
    }
    let seq = 0;
    const purchase = (
      authority: string,
      over: Record<string, unknown> = {},
    ) => ({
      authority,
      agent: "a",
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: `hosted-nonce-${String(++seq).padStart(10, "0")}`,
      ...over,
    });
    const start = (
      over?: Record<string, string | undefined>,
      payment: VerticalProvider | null = provider,
    ) => {
      host = createHostedConsole(parseHostedConfig(env(over)), {
        clock,
        paymentProvider: payment,
      });
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
      await repo.sql`truncate replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
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
      start();
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    it("provisions a Sandbox Authority, issues a credential, pays once over real HTTP and serves Proof", async () => {
      const s = await sandbox();
      const r = await s.client.actions.execute(purchase(s.authority));
      expect(r).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
      const proof = (await s.client.proofs.get(r.proof!.proposalId!)) as {
        proof: { status: string; financialOutcome: string };
      };
      expect(proof.proof).toMatchObject({
        status: "VERIFIED",
        financialOutcome: "CAPTURED",
      });
    });

    it("an out-of-policy request is a structured DENY with no provider call; replay never pays twice", async () => {
      const s = await sandbox();
      const bad = await s.client.actions.execute(
        purchase(s.authority, { amount: 18400 }),
      );
      expect(bad).toMatchObject({ status: "DENIED", effectCount: 0 });
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      const once = purchase(s.authority);
      expect((await s.client.actions.execute(once)).status).toBe("COMPLETED");
      expect(await s.client.actions.execute(once)).toMatchObject({
        reason: "REPLAY_DETECTED",
        effectCount: 0,
      });
      expect(provider.captureCalls).toBe(1);
    });

    it("a lost provider response is UNRESOLVED over the wire with effectCount null", async () => {
      const s = await sandbox();
      provider.loseCapture = true;
      const r = await s.client.actions.execute(purchase(s.authority));
      expect(r).toMatchObject({
        status: "UNRESOLVED",
        effectCount: null,
        doNotRetry: true,
      });
    });

    it("admin routes need the admin secret; a bad or missing credential is a structured 401", async () => {
      expect(
        (await admin("/v1/admin/credentials", undefined, "wrong")).status,
      ).toBe(401);
      expect(
        (await admin("/v1/admin/credentials", undefined, null)).status,
      ).toBe(401);
      expect(
        (await admin("/v1/admin/sandbox/authority", {}, "wrong")).status,
      ).toBe(401);
      const s = await sandbox();
      const bad = new PayFlowClient({
        baseUrl: origin,
        accessToken: s.token.replace(/.$/, "A"),
      });
      expect(await bad.actions.execute(purchase(s.authority))).toMatchObject({
        status: "REJECTED",
        httpStatus: 401,
        effectCount: 0,
      });
      expect(provider.createCalls).toBe(0);
    });

    it("without PAYFLOW_GATEWAY_ADMIN_TOKEN no administrative route exists", async () => {
      await host?.close();
      start({ PAYFLOW_GATEWAY_ADMIN_TOKEN: undefined });
      expect((await admin("/v1/admin/credentials")).status).toBe(404);
    });

    it("with no payment rail connected the Gateway refuses before any record is written", async () => {
      await host?.close();
      start({}, null);
      const s = await sandbox();
      const r = await s.client.actions.execute(purchase(s.authority));
      expect(r).toMatchObject({
        status: "DENIED",
        reason: "PAYMENT_RAIL_NOT_CONNECTED",
        effectCount: 0,
      });
      const [n] =
        await repo.sql`select count(*)::int n from authorization_reservations`;
      expect(n!.n).toBe(0);
    });

    it("also serves under the /api prefix and rejects oversized or invalid bodies", async () => {
      const s = await sandbox();
      const res = await fetch(origin + "/api/v1/actions/execute", {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
        body: "x".repeat(40_000),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ effectCount: 0 });
    });

    it("rejects a too-short admin token at configuration time", () => {
      expect(() =>
        parseHostedConfig(env({ PAYFLOW_GATEWAY_ADMIN_TOKEN: "short" })),
      ).toThrow();
    });

    describe("metering (GOVERNED_ACTION)", () => {
      const usage = () =>
        repo.sql`select meter, quantity::int q, metadata from usage_events order by occurred_at, id`;

      it("meters one governed action per evaluated request, with outcome metadata and no secrets", async () => {
        const s = await sandbox();
        const paid = await s.client.actions.execute(purchase(s.authority));
        expect(paid.status).toBe("COMPLETED");
        const denied = await s.client.actions.execute(
          purchase(s.authority, { amount: 5000 }),
        );
        expect(denied.status).toBe("DENIED");
        const rows = await usage();
        expect(rows).toHaveLength(2);
        expect(
          rows.every((r) => r.meter === "GOVERNED_ACTION" && r.q === 1),
        ).toBe(true);
        expect(
          rows.map((r) => (r.metadata as { status: string }).status).sort(),
        ).toEqual(["COMPLETED", "DENIED"]);
        const text = JSON.stringify(rows);
        expect(text).not.toContain(s.token.split(".")[1]!);
        expect(text).not.toMatch(/nonce|hosted-nonce/i);
      });

      it("a replayed request, a bad credential and a malformed request are not metered", async () => {
        const s = await sandbox();
        const once = purchase(s.authority);
        await s.client.actions.execute(once);
        await s.client.actions.execute(once); // replay
        const bad = new PayFlowClient({
          baseUrl: origin,
          accessToken: s.token.replace(/.$/, "A"),
        });
        await bad.actions.execute(purchase(s.authority));
        await fetch(origin + "/v1/actions/execute", {
          method: "POST",
          headers: { authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ nope: true }),
        });
        expect(await usage()).toHaveLength(1);
      });

      it("counts active agents as a distinct count, not a sum", async () => {
        const s = await sandbox();
        await s.client.actions.execute(purchase(s.authority, { amount: 5000 }));
        await s.client.actions.execute(purchase(s.authority, { amount: 5001 }));
        await s.client.actions.execute(purchase(s.authority, { amount: 5002 }));
        const n = await new PostgresNetworkStore(repo.sql).activeAgentCount(
          "payflow-sandbox",
          "SANDBOX",
          "2000-01-01T00:00:00Z",
          "2100-01-01T00:00:00Z",
        );
        expect(n).toBe(1);
        expect(await usage()).toHaveLength(3);
      });

      it("a metering failure never changes the financial result", async () => {
        const s = await sandbox();
        await repo.sql`drop table usage_events cascade`;
        try {
          const r = await s.client.actions.execute(purchase(s.authority));
          expect(r).toMatchObject({ status: "COMPLETED", effectCount: 1 });
          expect(provider.captureCalls).toBe(1);
        } finally {
          await repo.migrate(
            (
              await readFile(
                "db/migrations/013_m7_m15_network_control_plane.sql",
                "utf8",
              )
            )
              .split(";")
              .map((x) => x.replace(/--[^\n]*/g, "").trim())
              .filter((x) =>
                /create (table|index) (usage_events|usage_events_org_time)/i.test(
                  x,
                ),
              )
              .join(";\n") + ";",
          );
        }
      });
    });
  },
);
