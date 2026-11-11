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
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * R6: the customer application does not depend on the M6 demonstration financial agent.
 *
 * Until this change `createHostedConsole` built the hosted Gateway only when
 * PAYFLOW_M6_DEMO_AGENT=true, so a deployment that did not want a fictional shopping agent got 404
 * for every /v1 route, the customer application included. The host signing key (a real
 * cryptographic requirement for Proof) is now a property of the HOST, and the financial agent is a
 * separate, explicit switch.
 *
 * Every assertion here runs against the real composition over real HTTP and real PostgreSQL. The
 * refusal cases are paired with a positive control on an otherwise identical host WITH the agent, so
 * a refusal cannot pass by accident (for example because the route was simply missing).
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "r6-host-private-bootstrap-".repeat(3);
const adminToken = "r6-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const PASSWORD = "r6-customer-password-long-enough";
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "R6 customer host with no financial mode (PostgreSQL + real HTTP)",
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
      PAYFLOW_M5_ORIGIN: origin,
      PAYFLOW_M6_SIGNING_KEY: pem,
      PAYFLOW_GATEWAY_ADMIN_TOKEN: adminToken,
      PAYFLOW_APP_ORIGINS: origin,
      ...over,
    });
    const owner = ownerFactory(
      () => origin,
      () => repo.sql,
      adminToken,
    );
    /** A customer host: host signing key, NO financial agent. This is the new deployment shape. */
    const startCustomerOnly = () => {
      host = createHostedConsole(parseHostedConfig(env()), { clock });
    };
    /** The same host with financial mode on. The positive control for every refusal below. */
    const startWithFinancialMode = () => {
      host = createHostedConsole(
        parseHostedConfig(env({ PAYFLOW_M6_DEMO_AGENT: "true" })),
        { clock, paymentProvider: provider },
      );
    };
    const restart = async (how: () => void) => {
      await host?.close();
      host = undefined;
      how();
    };
    const send = (
      method: "GET" | "POST",
      path: string,
      o: {
        body?: unknown;
        cookie?: string;
        csrf?: string;
        token?: string;
      } = {},
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          origin,
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...(o.csrf ? { "x-pf-csrf": o.csrf } : {}),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      });
    let who = 0;
    /** A real customer: signup over HTTP, then a real session cookie and CSRF token. */
    const customer = async () => {
      const email = `r6-user-${++who}@example.com`;
      const up = await send("POST", "/v1/app/signup", {
        body: {
          email,
          password: PASSWORD,
          displayName: "Sam",
          organizationName: "Sam Studio",
        },
      });
      expect(up.status, JSON.stringify(await up.clone().json())).toBe(201);
      const inn = await send("POST", "/v1/app/login", {
        body: { email, password: PASSWORD },
      });
      expect(inn.status).toBe(200);
      const body = (await inn.json()) as {
        csrfToken: string;
        member: { organizationId: string };
      };
      return {
        email,
        cookie: inn.headers.get("set-cookie")!.split(";")[0]!,
        csrf: body.csrfToken,
        organizationId: body.member.organizationId,
      };
    };
    /** An Authority and an agent credential, provisioned the way a deployment does. */
    const sandbox = async () => {
      const a = (await (
        await send("POST", "/v1/admin/sandbox/authority", {
          body: {},
          token: adminToken,
        })
      ).json()) as { authority?: { id: string } };
      await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
        values ('payflow-sandbox', 'a', 'SANDBOX', 'p') on conflict do nothing`;
      const cr = await send("POST", "/v1/admin/credentials", {
        body: {
          agentId: "a",
          scopes: ["action:request", "proof:read"],
          ttlSeconds: 3600,
        },
        token: await owner.token(),
      });
      const c = (await cr.json()) as { token?: string };
      if (!c.token)
        throw new Error(`credential: ${cr.status} ${JSON.stringify(c)}`);
      return { authority: a.authority!, token: c.token };
    };
    const contract = () => ({
      objective: "Find and buy equipment for the studio",
      intendedOutcome: "Equipment delivered within budget",
      successCriteria: ["Three comparable quotes", "Purchase under budget"],
      currency: "USD",
      totalBudgetMinor: 150_000,
      maxCommitmentMinor: 60_000,
      spendingCategories: ["EQUIPMENT"],
      approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      merchantRestrictions: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
      approvalConditions: { humanApprovalAboveMinor: 30_000 },
      expiresAt: "2026-11-23T10:00:00.000Z",
    });
    let seq = 0;
    const purchase = (authority: string) => ({
      authority,
      agent: "a",
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: `r6-nonce-${String(++seq).padStart(10, "0")}`,
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
        void host.handler(req, res).catch(() => undefined);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    beforeEach(async () => {
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,proof_signing_keys,rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts,missions,mission_versions,mission_agent_grants,mission_transitions",
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
      startCustomerOnly();
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    it("mounts the customer application: a person signs up, signs in, is recognised and signs out", async () => {
      const me = await customer();
      const view = await send("GET", "/v1/app/me", { cookie: me.cookie });
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({
        user: { email: me.email },
      });
      const out = await send("POST", "/v1/app/logout", {
        cookie: me.cookie,
        csrf: me.csrf,
        body: {},
      });
      expect(out.status).toBeLessThan(300);
      // The session is really gone, not just forgotten by the client.
      expect(
        (await send("GET", "/v1/app/me", { cookie: me.cookie })).status,
      ).toBe(401);
    });

    it("state a customer creates is durable across a host restart with no financial agent", async () => {
      const me = await customer();
      const made = await send("POST", "/v1/admin/org/missions", {
        cookie: me.cookie,
        csrf: me.csrf,
        body: { contract: contract(), idempotencyKey: "r6-mission-idem-0001" },
      });
      expect(made.status, JSON.stringify(await made.clone().json())).toBe(201);
      await restart(startCustomerOnly);
      const again = await send("POST", "/v1/app/login", {
        body: { email: me.email, password: PASSWORD },
      });
      expect(again.status).toBe(200);
      const list = await send("GET", "/v1/admin/org/missions", {
        cookie: again.headers.get("set-cookie")!.split(";")[0]!,
      });
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as { missions: unknown[] }).missions.length,
      ).toBeGreaterThan(0);
    });

    it("refuses every economic request before a provider is reached, and writes nothing", async () => {
      const s = await sandbox();
      const client = new PayFlowClient({
        baseUrl: origin,
        accessToken: s.token,
      });
      const r = await client.actions.execute(purchase(s.authority.id));
      expect(r).toMatchObject({
        status: "DENIED",
        reason: "PAYMENT_RAIL_NOT_CONNECTED",
        effectCount: 0,
      });
      // And the response does not label a rail this host has not got: saying "PAYPAL_SANDBOX" next
      // to "no payment rail is connected" would describe a provider that is not mounted.
      expect(r).not.toHaveProperty("rail");
      const count = async (table: string): Promise<number> => {
        const rows = (await repo.sql`select count(*)::int n from ${repo.sql(
          table,
        )}`) as unknown as readonly { n: number }[];
        return rows[0]!.n;
      };
      expect({
        reservations: await count("authorization_reservations"),
        proposals: await count("transaction_proposals"),
      }).toEqual({ reservations: 0, proposals: 0 });
    });

    it("positive control: the identical request on the same host WITH financial mode completes", async () => {
      await restart(startWithFinancialMode);
      const s = await sandbox();
      const client = new PayFlowClient({
        baseUrl: origin,
        accessToken: s.token,
      });
      const r = await client.actions.execute(purchase(s.authority.id));
      // Proves the refusal above is caused by the absent financial agent, not by a missing route,
      // an unprovisioned Authority or a rejected credential.
      expect(r).toMatchObject({ status: "COMPLETED", rail: "PAYPAL_SANDBOX" });
    });

    it("the public sandbox's simulated rail no longer needs the demonstration agent", async () => {
      await restart(() => {
        host = createHostedConsole(
          parseHostedConfig(env({ PAYFLOW_PUBLIC_SANDBOX: "true" })),
          { clock },
        );
      });
      const r = await send("POST", "/v1/sandbox/start", { body: {} });
      // Reachable and answering on its own merits, not 404 for want of a fictional agent.
      expect(r.status).not.toBe(404);
      // And it is really off when not asked for, on the same host shape.
      await restart(startCustomerOnly);
      expect(
        (await send("POST", "/v1/sandbox/start", { body: {} })).status,
      ).toBe(404);
    });

    it("fails closed: financial mode cannot be enabled without the host signing key", () => {
      expect(() =>
        parseHostedConfig(
          env({
            PAYFLOW_M6_DEMO_AGENT: "true",
            PAYFLOW_M6_SIGNING_KEY: undefined,
          }),
        ),
      ).toThrow("PAYFLOW_M6_DEMO_AGENT_REQUIRES_PAYFLOW_M6_SIGNING_KEY");
      // And the flag is still exactly "true" or absent: no truthy-looking value turns it on.
      expect(() =>
        parseHostedConfig(env({ PAYFLOW_M6_DEMO_AGENT: "yes" })),
      ).toThrow();
    });

    it("the demonstration agent's own routes stay absent on a customer host", async () => {
      // Sign in to the console first: anonymously every one of these answers 400, which would make
      // "absent" indistinguishable from "unauthenticated".
      const r = await send("POST", "/api/activation/session", {
        body: { bootstrapCode: bootstrap },
      });
      expect(r.status).toBe(200);
      const auth = {
        cookie: r.headers.get("set-cookie")!.split(";")[0]!,
        csrf: ((await r.json()) as { csrfToken: string }).csrfToken,
      };
      const attempt = await fetch(origin + "/api/demo-agent/attempt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: auth.cookie,
          "x-payflow-csrf": auth.csrf,
        },
        body: JSON.stringify({ scenario: "PRICE_DRIFT", mandateId: "x" }),
      });
      expect(attempt.status).toBe(404);
      // Positive control: with financial mode the same signed-in call is served.
      await restart(startWithFinancialMode);
      const on = await send("POST", "/api/activation/session", {
        body: { bootstrapCode: bootstrap },
      });
      const live = await fetch(origin + "/api/demo-agent/attempt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: on.headers.get("set-cookie")!.split(";")[0]!,
          "x-payflow-csrf": ((await on.json()) as { csrfToken: string })
            .csrfToken,
        },
        body: JSON.stringify({ scenario: "PRICE_DRIFT", mandateId: "x" }),
      });
      expect(live.status).not.toBe(404);
    });
  },
);
