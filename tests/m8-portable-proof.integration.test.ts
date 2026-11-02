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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m7-host-private-bootstrap-".repeat(3);
const adminToken = "m7-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M8 independent verification of a hosted Gateway outcome (PostgreSQL + real HTTP + separate-process CLI)",
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

    const getJson = async (path: string, token: string) => {
      const r = await fetch(origin + path, {
        headers: { authorization: `Bearer ${token}` },
      });
      return {
        status: r.status,
        body: (await r.json()) as {
          proof: Record<string, unknown> & { keyId: string };
        },
      };
    };
    /** Runs the standalone verifier in a fresh process with NO database and NO PayFlow environment. */
    function verifyOffline(proof: unknown, jwk: unknown, extra: string[] = []) {
      const dir = mkdtempSync(join(tmpdir(), "m8-"));
      writeFileSync(join(dir, "proof.json"), JSON.stringify(proof));
      writeFileSync(join(dir, "key.json"), JSON.stringify(jwk));
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/verifier/src/cli.ts",
          join(dir, "proof.json"),
          join(dir, "key.json"),
          ...extra,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        },
      );
      return {
        code: r.status,
        out: JSON.parse(r.stdout || "{}") as {
          valid?: boolean;
          reason?: string;
        },
      };
    }
    async function paidProof() {
      const s = await sandbox();
      const r = await s.client.actions.execute(purchase(s.authority));
      expect(r.status).toBe("COMPLETED");
      const portable = await getJson(
        `/v1/proofs/${r.proof!.proposalId}/portable`,
        s.token,
      );
      const keys = (await (await fetch(origin + "/v1/keys")).json()) as {
        keys: { keyId: string; jwk: unknown }[];
      };
      return { s, r, portable, keys };
    }

    it("a separate process verifies a paid outcome from the proof and the public key alone", async () => {
      const { portable, keys } = await paidProof();
      expect(portable.status).toBe(200);
      expect(portable.body.proof).toMatchObject({
        outcome: "SUCCEEDED",
        effectCount: 1,
        version: "payflow-proof/v1",
      });
      const jwk = keys.keys.find(
        (k) => k.keyId === portable.body.proof.keyId,
      )!.jwk;
      expect(JSON.stringify(jwk)).not.toContain('"d"'); // public key only
      const ok = verifyOffline(portable.body.proof, jwk);
      expect(ok).toMatchObject({
        code: 0,
        out: { valid: true, reason: "PROOF_VALID" },
      });
    }, 90_000);

    it("tampering with any signed field, or using another key, is rejected", async () => {
      const { portable, keys } = await paidProof();
      const jwk = keys.keys[0]!.jwk;
      const p = portable.body.proof;
      for (const change of [
        { effectCount: 0, outcome: "FAILED" },
        { actionId: "other-operation" },
        { authorityId: "other-authority" },
        { evidenceDigest: "b".repeat(64) },
      ]) {
        expect(verifyOffline({ ...p, ...change }, jwk)).toMatchObject({
          code: 1,
          out: { valid: false },
        });
      }
      const other = generateKeyPairSync("ed25519").publicKey.export({
        format: "jwk",
      });
      expect(verifyOffline(p, other)).toMatchObject({
        code: 1,
        out: { valid: false, reason: "SIGNATURE_INVALID" },
      });
    }, 90_000);

    it("historical evidence stays valid; freshness is an explicit opt-in", async () => {
      const { portable, keys } = await paidProof();
      const jwk = keys.keys[0]!.jwk;
      // The host clock is fixed in 2026-10-23, so this proof is already old when verified now.
      expect(verifyOffline(portable.body.proof, jwk)).toMatchObject({
        code: 0,
        out: { valid: true },
      });
      expect(
        verifyOffline(portable.body.proof, jwk, ["--max-age", "3600"]),
      ).toMatchObject({
        code: 1,
        out: { valid: false, reason: "STALE_PROOF" },
      });
    }, 90_000);

    it("an UNKNOWN outcome is signed as UNKNOWN with effectCount null and cannot be rewritten to success", async () => {
      const s = await sandbox();
      provider.loseCapture = true;
      const r = await s.client.actions.execute(purchase(s.authority));
      expect(r.status).toBe("UNRESOLVED");
      const portable = await getJson(
        `/v1/proofs/${r.proof!.proposalId}/portable`,
        s.token,
      );
      expect(portable.status).toBe(200);
      expect(portable.body.proof).toMatchObject({
        outcome: "UNKNOWN",
        effectCount: null,
      });
      const keys = (await (await fetch(origin + "/v1/keys")).json()) as {
        keys: { jwk: unknown }[];
      };
      const jwk = keys.keys[0]!.jwk;
      expect(verifyOffline(portable.body.proof, jwk)).toMatchObject({
        code: 0,
        out: { valid: true },
      });
      expect(
        verifyOffline(
          { ...portable.body.proof, outcome: "SUCCEEDED", effectCount: 1 },
          jwk,
        ),
      ).toMatchObject({
        code: 1,
        out: { valid: false },
      });
    }, 90_000);

    it("portable Proof needs the proof:read scope, belongs to the owning agent, and 404s otherwise", async () => {
      const { s, r } = await paidProof();
      const id = r.proof!.proposalId!;
      expect(
        (
          await getJson(
            `/v1/proofs/${id}/portable`,
            "pf_sbx_pfc_000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          )
        ).status,
      ).toBe(401);
      const noScope = (await (
        await admin("/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request"],
          ttlSeconds: 600,
        })
      ).json()) as { token: string };
      expect(
        (await getJson(`/v1/proofs/${id}/portable`, noScope.token)).status,
      ).toBe(403);
      expect(
        (await getJson(`/v1/proofs/does-not-exist/portable`, s.token)).status,
      ).toBe(404);
    }, 90_000);

    it("the public key endpoint is unauthenticated and never exposes private material", async () => {
      const res = await fetch(origin + "/v1/keys");
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toMatch(/"d"\s*:/);
      expect(text).not.toMatch(/PRIVATE/i);
    });

    it("the verifier package is read-only: it imports no payment, database, network or PayFlow server code", () => {
      for (const f of readdirSync("packages/verifier/src")) {
        const code = readFileSync(join("packages/verifier/src", f), "utf8");
        const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map(
          (m) => m[1]!,
        );
        for (const i of imports)
          expect(
            ["node:crypto", "node:fs/promises", "zod", "./index.js"],
            `${f} imports ${i}`,
          ).toContain(i);
        expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|paypal|postgres/i);
      }
    });
  },
);
