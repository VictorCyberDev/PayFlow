import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
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
import {
  IntentActivationService,
  HumanConfirmationBoundary,
} from "../src/intent-activation.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m6-host-private-bootstrap-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

(url ? describe : describe.skip)(
  "M6 hosted composition: demo Shopping Agent on the durable host (PostgreSQL + HTTP)",
  () => {
    let repo: PostgresTrustRepository,
      server: Server,
      origin: string,
      host: ReturnType<typeof createHostedConsole> | undefined;
    const time = new Date("2026-10-23T10:00:00.000Z");
    const clock = () => new Date(time);
    const env = (over: Record<string, string | undefined> = {}) => ({
      PAYFLOW_M5_DEMO: "true",
      DATABASE_URL: url,
      PAYFLOW_M5_PRINCIPAL_ID: "p",
      PAYFLOW_M5_AGENT_ID: "a",
      PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
      PAYFLOW_M5_ORIGIN: origin,
      PAYFLOW_M6_DEMO_AGENT: "true",
      PAYFLOW_M6_SIGNING_KEY: pem,
      ...over,
    });
    type Auth = { cookie: string; csrf: string };
    const call = (path: string, init: { body?: unknown; auth?: Auth } = {}) =>
      fetch(origin + path, {
        method: init.body !== undefined ? "POST" : "GET",
        headers: {
          origin,
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(init.auth
            ? { cookie: init.auth.cookie, "x-payflow-csrf": init.auth.csrf }
            : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    async function login(): Promise<Auth> {
      const r = await call("/api/activation/session", {
        body: { bootstrapCode: bootstrap },
      });
      const v = (await r.json()) as { csrfToken: string };
      return {
        cookie: r.headers.get("set-cookie")!.split(";")[0]!,
        csrf: v.csrfToken,
      };
    }
    async function authority(auth: Auth): Promise<string> {
      const sample = (
        (await (await call("/api/intent-review/sample", { auth })).json()) as {
          sample: string;
        }
      ).sample;
      const p = (await (
        await call("/api/activation/reviews", {
          auth,
          body: { source: sample },
        })
      ).json()) as { reviewId: string; displayHash: string };
      const r = await call("/api/activation/confirm", {
        auth,
        body: {
          action: "CONFIRM_EXACT_TERMS",
          reviewId: p.reviewId,
          displayHash: p.displayHash,
        },
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { mandateId: string }).mandateId;
    }
    const rows = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            "transaction_proposals",
            "authorization_reservations",
            "execution_grants",
            "payment_attempts",
          ].map(
            async (t) =>
              [
                t,
                Number(
                  (await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n,
                ),
              ] as const,
          ),
        ),
      );
    const start = (
      over?: Record<string, string | undefined>,
      payment?: VerticalProvider | null,
    ) => {
      host = createHostedConsole(parseHostedConfig(env(over)), {
        clock,
        ...(payment !== undefined ? { paymentProvider: payment } : {}),
      });
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
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
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      await repo.sql`truncate console_demo_sessions cascade`;
      await repo.sql`update console_demo_login_window set window_started_at='epoch', attempts=0`;
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
      await new IntentActivationService(
        repo,
        new HumanConfirmationBoundary(
          { verify: () => Promise.reject(new Error("NO_TEST_AUTH_BYPASS")) },
          clock,
        ),
        clock,
      ).provisionPolicy("p", {
        version: "payflow.activation-policy.v1",
        maximumMinor: 10000,
        maximumQuantity: 1,
        currencies: ["USD"],
        capabilities,
        merchantIds: ["payflow.demo.merchant"],
        merchantRiskCeiling: "LOW",
        maximumLifetimeSeconds: 86400 * 30,
      });
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    it("without the M6 setting the host offers no demo agent route", async () => {
      start({
        PAYFLOW_M6_DEMO_AGENT: undefined,
        PAYFLOW_M6_SIGNING_KEY: undefined,
      });
      const auth = await login();
      expect((await call("/api/demo-agent/status", { auth })).status).toBe(405);
      expect(
        (
          await call("/api/demo-agent/attempt", {
            auth,
            body: { scenario: "PRICE_DRIFT", mandateId: "x" },
          })
        ).status,
      ).toBe(404);
    });

    it("fails closed: enabled without a signing key, or with a non-Ed25519 key, never starts", () => {
      expect(() =>
        parseHostedConfig(env({ PAYFLOW_M6_SIGNING_KEY: undefined })),
      ).toThrow();
      expect(() =>
        parseHostedConfig(env({ PAYFLOW_M6_SIGNING_KEY: "short" })),
      ).toThrow();
      expect(() =>
        parseHostedConfig(env({ PAYFLOW_M6_DEMO_AGENT: "yes" })),
      ).toThrow();
      expect(() => start({ PAYFLOW_M6_SIGNING_KEY: rsa })).toThrow(
        "PAYFLOW_M6_SIGNING_KEY_INVALID",
      );
    });

    it("requires a session: the demo agent is not reachable anonymously", async () => {
      start(undefined, null);
      expect((await call("/api/demo-agent/status")).status).toBe(400);
      const anon = await call("/api/demo-agent/attempt", {
        body: { scenario: "PRICE_DRIFT", mandateId: "x" },
      });
      expect(anon.status).toBe(400);
      expect(await rows()).toEqual({
        transaction_proposals: 0,
        authorization_reservations: 0,
        execution_grants: 0,
        payment_attempts: 0,
      });
    });

    it("no payment rail: blocked case runs and shows $0 moved; the purchase is refused before anything is written", async () => {
      start(undefined, null);
      const auth = await login();
      const id = await authority(auth);
      expect(
        await (await call("/api/demo-agent/status", { auth })).json(),
      ).toMatchObject({ payment: "NOT_CONNECTED" });
      const refused = (await (
        await call("/api/demo-agent/attempt", {
          auth,
          body: { scenario: "VALID_PURCHASE", mandateId: id },
        })
      ).json()) as { code: string };
      expect(refused.code).toBe("PAYMENT_RAIL_NOT_CONNECTED");
      expect(await rows()).toEqual({
        transaction_proposals: 0,
        authorization_reservations: 0,
        execution_grants: 0,
        payment_attempts: 0,
      });
      const drift = (await (
        await call("/api/demo-agent/attempt", {
          auth,
          body: { scenario: "PRICE_DRIFT", mandateId: id },
        })
      ).json()) as { status: string; operationId: string };
      expect(drift.status).toBe("REFUSED");
      const act = (await (
        await call("/api/activation/activity", { auth })
      ).json()) as { items: { moneyMoved: string; operationId: string }[] };
      expect(act.items[0]).toMatchObject({
        moneyMoved: "NO",
        operationId: drift.operationId,
      });
    });

    it("connected rail: the hero purchase completes once, a second cannot, and the history verifies from a fresh host instance", async () => {
      const provider = new VerticalProvider();
      provider.payer = false;
      start(undefined, provider);
      const auth = await login();
      const id = await authority(auth);
      const ok = (await (
        await call("/api/demo-agent/attempt", {
          auth,
          body: { scenario: "VALID_PURCHASE", mandateId: id },
        })
      ).json()) as { status: string };
      expect(ok.status).toBe("COMPLETED");
      const again = (await (
        await call("/api/demo-agent/attempt", {
          auth,
          body: { scenario: "VALID_PURCHASE", mandateId: id },
        })
      ).json()) as { status: string };
      expect(again.status).not.toBe("COMPLETED");
      expect(provider.captureCalls).toBe(1);
      // A brand-new host instance (new pool, same persistent signing key) verifies the old grant.
      await host?.close();
      start(undefined, provider);
      const auth2 = await login();
      const act = (await (
        await call("/api/activation/activity", { auth: auth2 })
      ).json()) as {
        items: { status: string; verification: string; delegated: boolean }[];
      };
      const done = act.items.find((i) => i.status === "COMPLETED");
      expect(done).toMatchObject({ verification: "VERIFIED", delegated: true });
    });

    it("another owner's Authority and malformed requests are refused; no response leaks keys or provider details", async () => {
      const provider = new VerticalProvider();
      provider.payer = false;
      start(undefined, provider);
      const auth = await login();
      await authority(auth);
      for (const body of [
        { scenario: "VALID_PURCHASE", mandateId: "not-mine" },
        { scenario: "VALID_PURCHASE" },
        { scenario: "X", mandateId: "a" },
        { scenario: "VALID_PURCHASE", mandateId: "m", principalId: "other" },
      ])
        expect(
          (await call("/api/demo-agent/attempt", { auth, body })).status,
        ).toBe(400);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      const everything = JSON.stringify(
        await (await call("/api/demo-agent/status", { auth })).json(),
      );
      expect(everything).not.toMatch(
        /BEGIN|PRIVATE|VAULT|client_secret|VERTICAL/,
      );
    });
  },
);
