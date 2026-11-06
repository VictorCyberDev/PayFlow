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
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import {
  hostedProofVerifier,
  MerchantVerifier,
} from "../packages/merchant-sdk/src/verifier.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M23 against the real host composition: PostgreSQL, the real hosted Gateway and a deterministic provider double.
 * The Proofs verified here are real signed Proofs of real (sandbox) payments made through the Gateway.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m23-host-private-bootstrap-".repeat(3);
const adminToken = "m23-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M23 merchant SDK against the real hosted Verify (PostgreSQL + real HTTP)",
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
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    const order = {
      orderId: "order-1",
      amountMinor: 8400,
      currency: "USD",
      merchantId: "payflow.demo.merchant",
    };
    let n = 0;
    async function pay(lose = false) {
      const s = await sandbox();
      const client = new PayFlowClient({
        baseUrl: origin,
        accessToken: s.token,
      });
      provider.loseCapture = lose;
      const result = await client.actions.execute({
        item: "Quiet keyboard",
        amount: 8400,
        currency: "USD",
        merchant: "payflow.demo.merchant",
        nonce: `m23-nonce-${String(++n).padStart(12, "0")}`,
        authority: s.authority,
        agent: "a",
      });
      provider.loseCapture = false;
      const proposalId = result.proof?.proposalId;
      const portable = (await (
        await fetch(`${origin}/v1/proofs/${proposalId}/portable`, {
          headers: { authorization: `Bearer ${s.token}` },
        })
      ).json()) as { proof?: Record<string, unknown> };
      return { result, proof: portable.proof ?? {} };
    }
    const merchant = () =>
      new MerchantVerifier({
        audience: "https://shop.example",
        env: {
          issuerKey: () => null,
          trust: () => null,
          statusList: () => null,
        },
        proofVerifier: hostedProofVerifier(origin),
      });

    it("a real Proof of a real payment fulfils the matching order, once", async () => {
      const { proof } = await pay();
      const m = merchant();
      expect(await m.associateProof(proof, order)).toMatchObject({
        verdict: "FULFIL",
        reason: "PAID_ONCE_MATCHES_ORDER",
      });
      // The same payment cannot also pay for a second order.
      expect(
        await m.associateProof(proof, { ...order, orderId: "order-2" }),
      ).toMatchObject({
        verdict: "REFUSE",
        reason: "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER",
      });
    });

    it("a genuine Proof for a different amount or merchant is refused, naming what differs", async () => {
      const { proof } = await pay();
      const r = await merchant().associateProof(proof, {
        ...order,
        amountMinor: 100,
        merchantId: "someone.else",
      });
      expect(r).toMatchObject({
        verdict: "REFUSE",
        reason: "PROOF_DOES_NOT_MATCH_ORDER",
      });
      expect(r.mismatches).toEqual(["amountMinor", "merchantId"]);
    });

    it("a forged Proof claiming 'nothing moved' or 'paid' is refused as not authentic", async () => {
      const { proof } = await pay();
      for (const forged of [
        { ...proof, effectCount: 0, outcome: "FAILED" },
        { ...proof, signature: "AAAA".repeat(20) },
      ])
        expect(await merchant().associateProof(forged, order)).toMatchObject({
          verdict: "REFUSE",
          reason: "PROOF_NOT_AUTHENTIC",
        });
    });

    it("a payment whose outcome is UNKNOWN holds the order: not shipped, not cancelled", async () => {
      const { result, proof } = await pay(true);
      expect(result).toMatchObject({ status: "UNRESOLVED", effectCount: null });
      expect(await merchant().associateProof(proof, order)).toMatchObject({
        verdict: "HOLD",
        reason: "OUTCOME_UNKNOWN",
      });
    });

    it("if Verify is unavailable the order holds; an outage is never read as 'no payment'", async () => {
      const { proof } = await pay();
      await repo.sql`alter table rate_limit_windows rename to rate_limit_windows_off`;
      try {
        expect(await merchant().associateProof(proof, order)).toMatchObject({
          verdict: "HOLD",
          reason: "VERIFIER_UNAVAILABLE",
        });
      } finally {
        await repo.sql`alter table rate_limit_windows_off rename to rate_limit_windows`;
      }
    });
  },
);
