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
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M21 against the real host composition: PostgreSQL, the real hosted Gateway and a deterministic provider double.
 * The Proofs verified here are real signed Proofs of real (sandbox) payments made through the Gateway.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m21-host-private-bootstrap-".repeat(3);
const adminToken = "m21-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M21 hosted Verify: anonymous, read-only, abuse-protected (PostgreSQL + real HTTP)",
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

    const buy = {
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: "m21-verify-nonce-0000000001",
    };
    /** A real signed Proof for a real payment made through the hosted Gateway. */
    async function realProof() {
      const s = await sandbox();
      const client = new PayFlowClient({
        baseUrl: origin,
        accessToken: s.token,
      });
      const paid = await client.actions.execute({
        ...buy,
        authority: s.authority,
        agent: "a",
      });
      if (paid.status !== "COMPLETED") throw new Error("setup payment failed");
      const portable = (await (
        await fetch(`${origin}/v1/proofs/${paid.proof?.proposalId}/portable`, {
          headers: { authorization: `Bearer ${s.token}` },
        })
      ).json()) as { proof: Record<string, unknown> };
      return { proof: portable.proof, authority: s.authority };
    }
    // Anonymous: no Authorization header at all.
    const verify = (
      body: unknown,
      headers: Record<string, string> = {},
      raw?: string,
    ) =>
      fetch(`${origin}/v1/verify/proofs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: raw ?? JSON.stringify(body),
      });
    const json = async (r: Response) =>
      (await r.json()) as Record<string, unknown>;

    it("verifies a real Proof anonymously, with a plain-language summary and the facts it signs", async () => {
      const { proof } = await realProof();
      const r = await verify({ proof });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await json(r)).toMatchObject({
        verified: true,
        authentic: true,
        reason: "PROOF_VALID",
        outcome: "SUCCEEDED",
        effectCount: 1,
        mismatches: [],
      });
    });

    it("checks what the relying party expects, and says exactly what did not match", async () => {
      const { proof, authority } = await realProof();
      const ok = await json(
        await verify({
          proof,
          expect: {
            authorityId: authority,
            amountMinor: 8400,
            currency: "USD",
            merchantId: "payflow.demo.merchant",
            agentId: "a",
          },
        }),
      );
      expect(ok).toMatchObject({ verified: true });
      const wrong = await json(
        await verify({
          proof,
          expect: { amountMinor: 100, merchantId: "someone.else" },
        }),
      );
      expect(wrong).toMatchObject({ verified: false, authentic: true });
      expect(wrong.mismatches).toEqual(["amountMinor", "merchantId"]);
    });

    it("rejects a forged, re-signed-by-nobody, wrong-issuer or unknown-key Proof, and never turns an unverifiable Proof into 'nothing moved'", async () => {
      const { proof } = await realProof();
      const forged = await json(
        await verify({
          proof: { ...proof, effectCount: 0, outcome: "FAILED" },
        }),
      );
      expect(forged).toMatchObject({
        verified: false,
        authentic: false,
        reason: "SIGNATURE_INVALID",
      });
      expect(forged).not.toHaveProperty("effectCount");
      expect(
        await json(await verify({ proof: { ...proof, issuer: "evil" } })),
      ).toMatchObject({ verified: false, reason: "UNKNOWN_ISSUER" });
      expect(
        await json(await verify({ proof: { ...proof, keyId: "nope" } })),
      ).toMatchObject({ verified: false, reason: "UNKNOWN_KEY" });
      expect(
        await json(await verify({ proof: { issuer: "payflow-sandbox" } })),
      ).toMatchObject({ verified: false, reason: "MALFORMED_PROOF" });
    });

    it("refuses malformed requests without checking anything", async () => {
      for (const body of [
        {},
        { proof: "text" },
        { proof: {}, extra: 1 },
        { proof: {}, maxAgeSeconds: 1 },
        { proof: {}, expect: { amountMinor: -1 } },
      ]) {
        const r = await verify(body);
        expect(r.status).toBe(400);
        expect(await json(r)).toMatchObject({
          verified: false,
          reason: "MALFORMED_VERIFY_REQUEST",
        });
      }
      expect((await verify(undefined, {}, "{not json")).status).toBe(400);
      const huge = await verify({ proof: { pad: "x".repeat(40_000) } });
      expect(huge.status).toBe(400);
    });

    it("is read-only: it creates no records, whatever it is sent", async () => {
      const { proof } = await realProof();
      const tables = [
        "evidence_events",
        "replay_keys",
        "payment_attempts",
        "authorization_reservations",
        "agent_credentials",
        "organizations",
        "organization_audit_events",
      ];
      const count = async () =>
        Object.fromEntries(
          await Promise.all(
            tables.map(async (t) => {
              const [row] = await repo.sql.unsafe<{ n: number }[]>(
                `select count(*)::int n from ${t}`,
              );
              return [t, row?.n] as const;
            }),
          ),
        );
      const before = await count();
      await verify({ proof });
      await verify({ proof: { ...proof, effectCount: 0 } });
      await verify({ proof: { ...proof, issuer: "evil" } });
      await verify({ nonsense: true });
      expect(await count()).toEqual(before);
    });

    it("limits each address, and one address cannot lock out another", async () => {
      const { proof } = await realProof();
      const loud = { "x-forwarded-for": "203.0.113.7" };
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++)
        statuses.push((await verify({ proof }, loud)).status);
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
      const limited = await verify({ proof }, loud);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await json(limited)).toMatchObject({
        reason: "VERIFY_RATE_LIMITED",
      });
      // Someone else is unaffected, and the loud address checked nothing while limited.
      expect(
        (await verify({ proof }, { "x-forwarded-for": "198.51.100.9" })).status,
      ).toBe(200);
    });

    it("fails closed when the limiter is down: no unmetered anonymous verification", async () => {
      const { proof } = await realProof();
      await repo.sql`alter table rate_limit_windows rename to rate_limit_windows_off`;
      try {
        const r = await verify({ proof }, { "x-forwarded-for": "192.0.2.50" });
        expect(r.status).toBe(503);
        expect(r.headers.get("retry-after")).toBe("30");
      } finally {
        await repo.sql`alter table rate_limit_windows_off rename to rate_limit_windows`;
      }
    });
  },
);
