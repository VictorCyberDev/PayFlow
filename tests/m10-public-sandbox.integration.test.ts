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
import { truncateTenantData } from "./helpers/reset.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { SimulatedPaymentProvider } from "../src/simulated-rail.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";
import { createRequire } from "node:module";
import { parse } from "yaml";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m10-host-private-bootstrap-".repeat(3);
const adminToken = "m10-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M10 public self-serve sandbox on the SIMULATED rail (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let realRail: VerticalProvider;
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
      PAYFLOW_PUBLIC_SANDBOX: "true",
      ...over,
    });
    const start = (ip = "203.0.113.7") =>
      fetch(origin + "/v1/sandbox/start", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
      });
    type Started = {
      token: string;
      authority: {
        id: string;
        agentId: string;
        merchant: string;
        priceMinor: number;
      };
      sandbox: { rail: string };
    };
    async function sandbox(ip?: string) {
      const r = await start(ip);
      expect(r.status).toBe(201);
      const b = (await r.json()) as Started;
      return {
        ...b,
        client: new PayFlowClient({ baseUrl: origin, accessToken: b.token }),
      };
    }
    let seq = 0;
    const buy = (s: Started, over: Record<string, unknown> = {}) => ({
      authority: s.authority.id,
      agent: s.authority.agentId,
      item: "Quiet keyboard",
      amount: s.authority.priceMinor,
      currency: "USD",
      merchant: s.authority.merchant,
      nonce: `pubsbx-nonce-${String(++seq).padStart(12, "0")}`,
      ...over,
    });
    const boot = (over?: Record<string, string | undefined>) => {
      host = createHostedConsole(parseHostedConfig(env(over)), {
        clock,
        paymentProvider: realRail,
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
      await repo.sql`delete from rate_limit_windows`;
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,simulated_provider_orders",
      );
      realRail = new VerticalProvider();
      realRail.payer = false;
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
      boot();
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    }, 60_000);

    it("a stranger gets a credential and an Authority with no account, labelled simulated", async () => {
      // The real response must conform to the published OpenAPI schema.
      const nodeRequire = createRequire(import.meta.url);
      type Validator = ((d: unknown) => boolean) & { errors?: unknown };
      const Ajv2020 = (
        nodeRequire("ajv/dist/2020") as {
          default: new (o: object) => { compile: (s: object) => Validator };
        }
      ).default;
      const addFormats = (
        nodeRequire("ajv-formats") as { default: (a: unknown) => void }
      ).default;
      const spec = parse(await readFile("openapi/payflow-v1.yaml", "utf8")) as {
        components: object;
      };
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile({
        $ref: "#/components/schemas/SandboxStarted",
        components: spec.components,
      });
      const raw: unknown = await (await start("198.51.100.77")).json();
      expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
      const s = await sandbox();
      expect(s.sandbox.rail).toBe("SIMULATED");
      expect(s.token).toMatch(/^pf_sbx_pfc_[a-f0-9]{24}\./);
      expect(s.authority).toMatchObject({
        priceMinor: 8400,
        merchant: "payflow.demo.merchant",
      });
    });

    it("ALLOW then DENY then replay then overrun, all on the simulated rail, never touching the real one", async () => {
      const s = await sandbox();
      const paid = await s.client.actions.execute(buy(s));
      expect(paid).toMatchObject({
        status: "COMPLETED",
        effectCount: 1,
        rail: "SIMULATED",
      });
      expect(realRail.createCalls + realRail.captureCalls).toBe(0);
      const drift = await s.client.actions.execute(buy(s, { amount: 18400 }));
      expect(drift).toMatchObject({ status: "DENIED", effectCount: 0 });
      const once = buy(s);
      expect((await s.client.actions.execute(once)).status).not.toBe(
        "COMPLETED",
      ); // budget used
      expect(await s.client.actions.execute(once)).toMatchObject({
        reason: "REPLAY_DETECTED",
        effectCount: 0,
      });
      const [orders] =
        await repo.sql`select count(*)::int n, count(capture_request_id)::int c from simulated_provider_orders`;
      expect(orders).toMatchObject({ n: 1, c: 1 });
      expect(realRail.createCalls + realRail.captureCalls).toBe(0);
    });

    it("the Proof is real and verifiable offline, and says SIMULATED", async () => {
      const s = await sandbox();
      const paid = await s.client.actions.execute(buy(s));
      const proof = (await s.client.proofs.get(paid.proof!.proposalId!)) as {
        proof: {
          status: string;
          financialOutcome: string;
          references: { providerOrderId: string };
        };
      };
      expect(proof.proof).toMatchObject({
        status: "VERIFIED",
        financialOutcome: "CAPTURED",
      });
      expect(proof.proof.references.providerOrderId).toMatch(/^SIM-/);
      const portable = (await (
        await fetch(origin + `/v1/proofs/${paid.proof!.proposalId}/portable`, {
          headers: { authorization: `Bearer ${s.token}` },
        })
      ).json()) as { proof: { subject: { rail: string } } };
      expect(portable.proof.subject.rail).toBe("SIMULATED");
      const verified = await s.client.proofs.verify(portable.proof);
      expect(verified).toMatchObject({ verified: true });
      expect(verified.summary.join("\n")).toContain(
        "Simulated (no real money)",
      );
    });

    it("each sandbox is an isolated tenant: another sandbox's Authority and Proof are unreachable", async () => {
      const a = await sandbox("198.51.100.1");
      const b = await sandbox("198.51.100.2");
      const cross = await a.client.actions.execute(buy(b));
      expect(cross).toMatchObject({ status: "REJECTED", effectCount: 0 });
      const paidB = await b.client.actions.execute(buy(b));
      const peek = await fetch(
        origin + `/v1/proofs/${paidB.proof!.proposalId}`,
        { headers: { authorization: `Bearer ${a.token}` } },
      );
      expect(peek.status).toBe(404);
      const orgs =
        await repo.sql`select count(*)::int n from organizations where id like 'sbx_%'`;
      expect(orgs[0]!.n).toBe(2);
    });

    it("a sandbox credential cannot use admin routes or the operator provisioning route", async () => {
      const s = await sandbox();
      for (const path of [
        "/v1/admin/credentials",
        "/v1/admin/org/finance",
        "/v1/admin/sandbox/authority",
      ]) {
        const r = await fetch(origin + path, {
          method: path.endsWith("authority") ? "POST" : "GET",
          headers: { authorization: `Bearer ${s.token}` },
        });
        expect(r.status).toBe(401);
      }
    });

    it("a real organization still uses the real rail and is never routed to the simulated one", async () => {
      const a = (await (
        await fetch(origin + "/v1/admin/sandbox/authority", {
          method: "POST",
          headers: { authorization: `Bearer ${adminToken}` },
          body: "{}",
        })
      ).json()) as { authority: { id: string } };
      const c = (await (
        await fetch(origin + "/v1/admin/credentials", {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agentId: "a",
            scopes: ["action:request"],
            ttlSeconds: 600,
          }),
        })
      ).json()) as { token: string };
      const client = new PayFlowClient({
        baseUrl: origin,
        accessToken: c.token,
      });
      const r = await client.actions.execute({
        authority: a.authority.id,
        agent: "a",
        item: "Quiet keyboard",
        amount: 8400,
        currency: "USD",
        merchant: "payflow.demo.merchant",
        nonce: "real-org-nonce-000001",
      });
      expect(r).toMatchObject({ status: "COMPLETED", rail: "PAYPAL_SANDBOX" });
      expect(realRail.createCalls).toBe(1);
      expect(realRail.captureCalls).toBe(1);
      const [sim] =
        await repo.sql`select count(*)::int n from simulated_provider_orders`;
      expect(sim!.n).toBe(0);
    });

    it("starting sandboxes is rate limited per address and fails closed", async () => {
      for (let i = 0; i < 5; i++)
        expect((await start("192.0.2.9")).status).toBe(201);
      const sixth = await start("192.0.2.9");
      expect(sixth.status).toBe(429);
      expect(await sixth.json()).toMatchObject({
        reason: "SANDBOX_RATE_LIMITED",
        recoverable: true,
      });
      expect((await start("192.0.2.10")).status).toBe(201); // another address is unaffected
    });

    it("is disabled unless explicitly enabled, and a sandbox org can never reach the real rail", async () => {
      await host?.close();
      boot({ PAYFLOW_PUBLIC_SANDBOX: undefined });
      expect((await start()).status).toBe(404);
    });

    it("the simulated provider is idempotent: the same request id yields one order and one capture", async () => {
      const p = new SimulatedPaymentProvider(repo.sql);
      const commerce = {
        payee: { merchant_id: "DEMOACCOUNT01" },
        custom_id: "c",
        items: [],
        breakdown: {},
      } as never;
      const input = {
        amountValue: "84.00",
        currency: "USD",
        merchantReference: "ref",
        requestId: "req-1",
        commerce,
      };
      const o1 = await p.createOrder(input);
      const o2 = await p.createOrder(input);
      expect(o2.id).toBe(o1.id);
      expect(o1.id).toMatch(/^SIM-[A-F0-9]{24}$/);
      const c1 = await p.captureOrder(o1.id, "cap-1");
      const c2 = await p.captureOrder(o1.id, "cap-2");
      expect(c1.captures).toHaveLength(1);
      expect(c2.captures).toHaveLength(1);
      expect(c2.captures[0]!.id).toBe(c1.captures[0]!.id);
      await expect(p.getOrder("SIM-000000000000000000000000")).rejects.toThrow(
        "SIMULATED_ORDER_NOT_FOUND",
      );
      await expect(
        p.createOrder({
          ...input,
          requestId: "req-2",
          commerce: undefined as never,
        }),
      ).rejects.toThrow("SIMULATED_RAIL_REQUIRES_COMMERCE_TERMS");
    });
  },
);
