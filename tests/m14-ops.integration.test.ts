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
import postgres from "postgres";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import {
  selectKey,
  verifyPortableProof,
} from "../packages/verifier/src/index.js";
import { AlertEngine } from "../src/network/alerts.js";
import { SigningKeyRegistry } from "../src/network/signing-keys.js";
import {
  interpretOrder,
  reconciliationMetrics,
  UnknownReconciler,
} from "../src/network/unknown-reconciler.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m14-host-private-bootstrap-".repeat(3);
const operator = "m14-platform-operator-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const newPem = () =>
  generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
const PEM1 = newPem();
const PEM2 = newPem();
const NOW = "2026-10-23T10:00:00.000Z";
const at = (offsetSeconds: number) =>
  new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString();

(url ? describe : describe.skip)(
  "M14 reconciliation, alerts, key lifecycle and least privilege (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date(NOW);
    const env = (over: Record<string, unknown> = {}) => ({
      PAYFLOW_M5_DEMO: "true",
      DATABASE_URL: url,
      PAYFLOW_M5_PRINCIPAL_ID: "p",
      PAYFLOW_M5_AGENT_ID: "a",
      PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
      PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
      PAYFLOW_M6_DEMO_AGENT: "true",
      PAYFLOW_M6_SIGNING_KEY: PEM1,
      PAYFLOW_GATEWAY_ADMIN_TOKEN: operator,
      ...over,
    });
    const start = (over: Record<string, unknown> = {}) => {
      host = createHostedConsole(parseHostedConfig(env(over)), {
        clock,
        paymentProvider: provider,
      });
    };
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
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    let seq = 0;
    const buy = (authority: string, over: Record<string, unknown> = {}) => ({
      authority,
      agent: "a",
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: `m14-nonce-${String(++seq).padStart(12, "0")}`,
      ...over,
    });
    /** Sandbox Authority + a member-issued agent credential. */
    async function sandbox() {
      const a = (await (
        await call(operator, "POST", "/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const boot = await call(operator, "POST", "/v1/admin/members", {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX",
        displayName: "m14 owner",
        role: "OWNER",
      });
      const owner = ((await boot.json()) as { token: string }).token;
      const c = (await (
        await call(owner, "POST", "/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request", "proof:read"],
          ttlSeconds: 3600,
        })
      ).json()) as { token: string };
      return {
        authority: a.authority.id,
        owner,
        token: c.token,
        client: new PayFlowClient({ baseUrl: origin, accessToken: c.token }),
      };
    }
    const attempts = async () =>
      repo.sql`select id, status, provider_order_id, provider_capture_id, updated_at from payment_attempts order by id`;

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
      await repo.sql`delete from execution_controls`;
      await repo.sql`delete from rate_limit_windows`;
      await repo.sql`delete from operational_alerts`;
      await repo.sql`delete from proof_signing_keys`;
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
        displayName: "Procurement Agent",
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
    }, 60_000);

    describe("scheduled UNKNOWN reconciliation (observation only)", () => {
      const reconciler = (p: VerticalProvider = provider) =>
        new UnknownReconciler(repo.sql, () => ({
          getOrder: (id: string) => p.getOrder(id),
        }));

      it("a lost capture is enrolled, looked up read-only, and recorded as captured at the provider without any new provider call", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        expect(await s.client.actions.execute(buy(s.authority))).toMatchObject({
          status: "UNRESOLVED",
          effectCount: null,
          doNotRetry: true,
        });
        const before = await attempts();
        const calls = { c: provider.createCalls, k: provider.captureCalls };
        const tick = await reconciler().tick(NOW);
        expect(tick).toMatchObject({
          enrolled: 1,
          examined: 1,
          capturedAtProvider: 1,
          lookupErrors: 0,
        });
        const row = (await repo.sql`select * from reconciliation_lookups`)[0]!;
        expect(row).toMatchObject({
          state: "PROVIDER_CAPTURED",
          last_result: "PROVIDER_CAPTURED",
          organization_id: "payflow-sandbox",
        });
        expect(row.resolved_at).not.toBeNull();
        // The reconciler observed. It created and captured nothing, and rewrote no attempt.
        expect({ c: provider.createCalls, k: provider.captureCalls }).toEqual(
          calls,
        );
        expect(await attempts()).toEqual(before);
        // A resolved row is not looked up again.
        expect(await reconciler().tick(at(7200))).toMatchObject({
          examined: 0,
        });
      });

      it("while the provider is still ambiguous it backs off, then looks again; it never re-executes", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        // The provider still shows an approved, uncaptured order.
        provider.order = {
          ...provider.order!,
          status: "APPROVED",
          captures: [],
        };
        const calls = provider.createCalls + provider.captureCalls;
        const r = reconciler();
        expect(await r.tick(NOW)).toMatchObject({ stillUnknown: 1 });
        const first = (
          await repo.sql`select * from reconciliation_lookups`
        )[0]!;
        expect(first).toMatchObject({ state: "STILL_UNKNOWN", retry_count: 1 });
        expect(
          new Date(first.next_lookup_at as string).getTime(),
        ).toBeGreaterThan(Date.parse(NOW));
        // Not due yet.
        expect(await r.tick(at(5))).toMatchObject({ examined: 0 });
        // Due after the backoff; the delay grows.
        const t2 = at(3 * 3600);
        expect(await r.tick(t2)).toMatchObject({
          examined: 1,
          stillUnknown: 1,
        });
        const second = (
          await repo.sql`select * from reconciliation_lookups`
        )[0]!;
        expect(second.retry_count).toBe(2);
        expect(
          new Date(second.next_lookup_at as string).getTime() - Date.parse(t2),
        ).toBeGreaterThan(
          new Date(first.next_lookup_at as string).getTime() - Date.parse(NOW),
        );
        expect(provider.createCalls + provider.captureCalls).toBe(calls);
      });

      it("an order the provider voided is a recorded failure at the provider, not a retry", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        provider.order = { ...provider.order!, status: "VOIDED", captures: [] };
        expect(await reconciler().tick(NOW)).toMatchObject({
          failedAtProvider: 1,
        });
        expect(
          (await repo.sql`select state from reconciliation_lookups`)[0]!.state,
        ).toBe("PROVIDER_FAILED");
      });

      it("a lost order creation has no provider reference: it stays unknown and is never recreated", async () => {
        const s = await sandbox();
        provider.loseCreate = true;
        const r = await s.client.actions.execute(buy(s.authority));
        expect(r).toMatchObject({ effectCount: null, doNotRetry: true });
        const calls = provider.createCalls;
        const tick = await reconciler().tick(NOW);
        expect(tick).toMatchObject({ noProviderRef: 1 });
        expect(
          (
            await repo.sql`select state, resolved_at from reconciliation_lookups`
          )[0],
        ).toMatchObject({ state: "NO_PROVIDER_REF", resolved_at: null });
        expect(provider.createCalls).toBe(calls);
      });

      it("provider failures are retried with backoff, counted, and sanitized", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        const failing = new UnknownReconciler(repo.sql, () => ({
          getOrder: () => {
            throw new Error(
              "Bearer SUPERSECRET-TOKEN-123 postgres://u:pw@host/db rejected",
            );
          },
        }));
        expect(await failing.tick(NOW)).toMatchObject({ lookupErrors: 1 });
        const row = (await repo.sql`select * from reconciliation_lookups`)[0]!;
        expect(row).toMatchObject({
          consecutive_errors: 1,
          lookup_errors_total: 1,
          last_result: "LOOKUP_ERROR",
          last_error: "Error",
        });
        expect(JSON.stringify(row)).not.toMatch(/SUPERSECRET|postgres:\/\//u);
        // A later success clears the consecutive-error run.
        await reconciler().tick(at(2 * 3600));
        const healed = (
          await repo.sql`select * from reconciliation_lookups`
        )[0]!;
        expect(healed).toMatchObject({
          consecutive_errors: 0,
          state: "PROVIDER_CAPTURED",
        });
      });

      it("a second worker running at the same instant cannot look up the same attempt twice", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        let lookups = 0;
        const slow = new UnknownReconciler(repo.sql, () => ({
          getOrder: async (id: string) => {
            lookups++;
            await new Promise((r) => setTimeout(r, 50));
            return provider.getOrder(id);
          },
        }));
        const [a, b] = await Promise.all([slow.tick(NOW), slow.tick(NOW)]);
        expect(lookups).toBe(1);
        expect(a.examined + b.examined).toBe(1);
      });

      it("the reconciler cannot move money: it is typed to getOrder and its source never names create/capture/execute", async () => {
        const src = await readFile("src/network/unknown-reconciler.ts", "utf8");
        const code = src
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/\/\/.*$/gmu, "");
        expect(code).not.toMatch(
          /createOrder|captureOrder|\.execute\(|\.reconcile\(|ExecutionGrant|resume/iu,
        );
        expect(code).toMatch(/Pick<PaymentProvider, "getOrder">/u);
      });

      it("interprets only the provider's own terminal words", () => {
        const base = { id: "O", status: "APPROVED", purchaseUnits: [] };
        expect(
          interpretOrder({
            ...base,
            captures: [
              {
                id: "c",
                status: "COMPLETED",
                amountValue: "1",
                currency: "USD",
              },
            ],
          }),
        ).toBe("CAPTURED");
        expect(
          interpretOrder({
            ...base,
            captures: [
              { id: "c", status: "PENDING", amountValue: "1", currency: "USD" },
            ],
          }),
        ).toBe("UNKNOWN");
        expect(
          interpretOrder({
            ...base,
            captures: [
              {
                id: "c",
                status: "DECLINED",
                amountValue: "1",
                currency: "USD",
              },
            ],
          }),
        ).toBe("FAILED");
        expect(
          interpretOrder({ ...base, status: "VOIDED", captures: [] }),
        ).toBe("FAILED");
        expect(interpretOrder({ ...base, captures: [] })).toBe("UNKNOWN");
      });
    });

    describe("metrics and alerts", () => {
      async function unknownPending() {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        provider.order = {
          ...provider.order!,
          status: "APPROVED",
          captures: [],
        };
        return s;
      }
      const reconciler = () =>
        new UnknownReconciler(repo.sql, () => ({
          getOrder: (id: string) => provider.getOrder(id),
        }));

      it("exposes backlog, oldest age, buckets, still-unknown, failure and resolution rates", async () => {
        await unknownPending();
        await reconciler().tick(NOW);
        const m = await reconciliationMetrics(repo.sql, at(90 * 60));
        expect(m).toMatchObject({
          backlog: 1,
          oldestUnresolvedAgeSeconds: 5400,
          stillUnknown: 1,
          noProviderRef: 0,
          lookupFailureRate: 0,
          resolutionRate: 0,
          ageBuckets: { under5m: 0, under1h: 0, under24h: 1, over24h: 0 },
        });
        expect(
          await reconciliationMetrics(repo.sql, NOW, "another-org"),
        ).toMatchObject({
          backlog: 0,
          oldestUnresolvedAgeSeconds: null,
          lookupFailureRate: null,
          resolutionRate: null,
        });
      });

      it("raises a P1 when an UNKNOWN is too old, dedupes repeats, and auto-resolves it when the outcome is settled", async () => {
        await unknownPending();
        const alerts = new AlertEngine(repo.sql);
        await reconciler().tick(NOW);
        expect((await alerts.evaluate(at(60))).raised).toEqual([]);
        await alerts.evaluate(at(2 * 3600));
        await alerts.evaluate(at(2 * 3600 + 30));
        const open = await alerts.list({ state: "OPEN" });
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          severity: "P1",
          code: "UNKNOWN_TOO_OLD",
          occurrences: 2,
        });
        expect(JSON.stringify(open)).not.toMatch(/token|secret|password/iu);
        // The provider finally reports a capture.
        provider.order = {
          ...provider.order!,
          captures: [
            {
              id: "CAP-1",
              status: "COMPLETED",
              amountValue: "84.00",
              currency: "USD",
            },
          ],
        };
        await reconciler().tick(at(4 * 3600));
        const ev = await alerts.evaluate(at(4 * 3600 + 1));
        expect(ev.autoResolved).toBe(1);
        expect(await alerts.list({ state: "OPEN" })).toHaveLength(0);
      });

      it("repeated provider failure and a growing backlog raise P1; an active pause raises P2", async () => {
        await unknownPending();
        const alerts = new AlertEngine(repo.sql);
        const failing = new UnknownReconciler(
          repo.sql,
          () => ({
            getOrder: () => {
              throw new Error("down");
            },
          }),
          { baseDelaySeconds: 1, maxDelaySeconds: 1 },
        );
        for (let i = 0; i < 3; i++) await failing.tick(at(i * 10));
        await repo.sql`insert into execution_controls (scope, disabled, reason) values ('GLOBAL', true, 'drill')`;
        const ev = await alerts.evaluate(at(40), {
          unknownMaxAgeSeconds: 10 ** 9,
          backlogMax: 0,
          consecutiveProviderErrors: 3,
        });
        expect(new Set(ev.raised)).toEqual(
          new Set([
            "REPEATED_PROVIDER_FAILURE",
            "RECONCILIATION_BACKLOG",
            "EXECUTION_PAUSED",
          ]),
        );
        const list = await alerts.list();
        expect(list.map((a) => `${a.severity}:${a.code}`).sort()).toEqual([
          "P1:RECONCILIATION_BACKLOG",
          "P1:REPEATED_PROVIDER_FAILURE",
          "P2:EXECUTION_PAUSED",
        ]);
      });

      it("raises P0 for a duplicate economic effect and for captured money above the Authority limit, and never auto-resolves them", async () => {
        const s = await sandbox();
        expect((await s.client.actions.execute(buy(s.authority))).status).toBe(
          "COMPLETED",
        );
        const alerts = new AlertEngine(repo.sql);
        expect((await alerts.evaluate(NOW)).raised).toEqual([]);
        // Corrupt the ledger on purpose: a second captured attempt for the same proposal,
        // and a cumulative limit lower than what was captured.
        await repo.sql
          .begin(async (tx) => {
            await tx`alter table payment_attempts disable trigger user`;
            await tx`insert into payment_attempts select (jsonb_populate_record(null::payment_attempts,
            to_jsonb(a) || jsonb_build_object('id', a.id || '-dup', 'idempotency_key', a.idempotency_key || '-dup',
            'provider_order_id', a.provider_order_id || '-dup', 'provider_capture_id', a.provider_capture_id || '-dup',
            'reservation_id', a.reservation_id))).* from payment_attempts a where status = 'CAPTURED'`.catch(
              () => undefined,
            );
            await tx`alter table payment_attempts enable trigger user`;
          })
          .catch(() => undefined);
        const dup =
          await repo.sql`select count(*)::int n from payment_attempts where status = 'CAPTURED'`;
        if (Number(dup[0]!.n) > 1) {
          const ev = await alerts.evaluate(at(1));
          expect(ev.raised).toContain("DUPLICATE_ECONOMIC_EFFECT");
        }
        await repo.sql.begin(async (tx) => {
          await tx`alter table mandates disable trigger user`;
          await tx`update mandates set cumulative_limit_minor = 100 where id = ${s.authority}`;
          await tx`alter table mandates enable trigger user`;
        });
        const ev2 = await alerts.evaluate(at(2));
        expect(ev2.raised).toContain("CUMULATIVE_LIMIT_EXCEEDED");
        const p0 = (await alerts.list({ severity: "P0" })).filter(
          (a) => a.state === "OPEN",
        );
        expect(p0.length).toBeGreaterThan(0);
        // Even when the data is repaired the P0 stays open until a person resolves it.
        await repo.sql.begin(async (tx) => {
          await tx`alter table mandates disable trigger user`;
          await tx`update mandates set cumulative_limit_minor = 10000 where id = ${s.authority}`;
          await tx`alter table mandates enable trigger user`;
        });
        await alerts.evaluate(at(3));
        const stillOpen = (await alerts.list({ severity: "P0" })).filter(
          (a) => a.state === "OPEN",
        );
        expect(stillOpen.length).toBe(p0.length);
        expect(await alerts.resolve(stillOpen[0]!.alertId, at(4))).toBe(true);
      });

      it("alert details refuse secret-looking keys, and undelivered alerts are the hand-off for an external channel", async () => {
        const alerts = new AlertEngine(repo.sql);
        await expect(
          alerts.raise(
            {
              severity: "P1",
              code: "X_TEST",
              subjectKind: "T",
              subjectId: "1",
              detail: { apiToken: "x" },
            },
            NOW,
          ),
        ).rejects.toThrow("ALERT_DETAIL_FORBIDDEN_KEY");
        const { alertId } = await alerts.raise(
          {
            severity: "P1",
            code: "X_TEST",
            subjectKind: "T",
            subjectId: "1",
            detail: { n: 1 },
          },
          NOW,
        );
        expect((await alerts.undelivered()).map((a) => a.alertId)).toContain(
          alertId,
        );
        await alerts.markDelivered(alertId, NOW);
        expect(
          (await alerts.undelivered()).map((a) => a.alertId),
        ).not.toContain(alertId);
      });

      it("the operator can run a tick and read metrics and alerts over HTTP; a member or an anonymous caller cannot", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        await s.client.actions.execute(buy(s.authority));
        expect(
          (await call(null, "GET", "/v1/admin/ops/reconciliation")).status,
        ).toBe(401);
        expect(
          (await call(s.owner, "GET", "/v1/admin/ops/reconciliation")).status,
        ).toBe(403);
        expect(
          (await call(s.owner, "POST", "/v1/admin/ops/reconcile/tick")).status,
        ).toBe(403);
        const tick = await call(
          operator,
          "POST",
          "/v1/admin/ops/reconcile/tick",
        );
        expect(tick.status).toBe(200);
        expect(await tick.json()).toMatchObject({
          tick: { enrolled: 1, capturedAtProvider: 1 },
        });
        const metrics = (await (
          await call(operator, "GET", "/v1/admin/ops/reconciliation")
        ).json()) as { metrics: { backlog: number; resolutionRate: number } };
        expect(metrics.metrics).toMatchObject({
          backlog: 0,
          resolutionRate: 1,
        });
        expect(
          (await call(operator, "GET", "/v1/admin/ops/alerts")).status,
        ).toBe(200);
      });
    });

    describe("signing-key lifecycle", () => {
      async function paidAndProof(
        token: string,
        client: PayFlowClient,
        authority: string,
      ) {
        const r = (await client.actions.execute(buy(authority))) as {
          proof?: { proposalId: string };
        };
        const id = r.proof!.proposalId;
        const res = await fetch(`${origin}/v1/proofs/${id}/portable`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        return {
          id,
          proof: ((await res.json()) as { proof: Record<string, unknown> })
            .proof,
        };
      }
      const keysDoc = async () =>
        (await (await fetch(origin + "/v1/keys")).json()) as {
          keys: { keyId: string; jwk: object; status: string }[];
        };
      const verifies = (
        proof: Record<string, unknown>,
        doc: { keys: object[] },
      ) => {
        const jwk = selectKey(doc, String(proof.keyId));
        return jwk
          ? verifyPortableProof(proof, jwk, "2099-01-01T00:00:00.000Z", null)
              .valid
          : false;
      };

      it("rotation: old proof still verifies, new proof signs with the new key, rollback works, and a revoked key is withdrawn", async () => {
        const s = await sandbox();
        const old = await paidAndProof(s.token, s.client, s.authority);
        const k1 = String(old.proof.keyId);
        expect((await keysDoc()).keys).toMatchObject([
          { keyId: k1, status: "ACTIVE" },
        ]);
        expect(verifies(old.proof, await keysDoc())).toBe(true);

        // ---- rotate: restart with a new signing key; the old public key stays published.
        await host?.close();
        start({
          PAYFLOW_M6_SIGNING_KEY: PEM2,
          PAYFLOW_M6_SIGNING_KID: "m6-hosted-2",
        });
        // A fresh fake-provider order for the second purchase (the fixture holds one order at a time).
        delete (provider as { order?: unknown }).order;
        const s2 = await sandbox();
        const fresh = await paidAndProof(s2.token, s2.client, s2.authority);
        const k2 = String(fresh.proof.keyId);
        expect(k2).not.toBe(k1);
        const doc = await keysDoc();
        expect(doc.keys.map((k) => `${k.keyId}:${k.status}`)).toEqual([
          `${k2}:ACTIVE`,
          `${k1}:RETIRED`,
        ]);
        expect(verifies(old.proof, doc)).toBe(true); // historical proof, retired key
        expect(verifies(fresh.proof, doc)).toBe(true); // new proof, current key
        // A proof cannot be verified with the wrong key.
        const wrongJwk = selectKey(doc, k2)!;
        expect(
          verifyPortableProof(
            old.proof,
            wrongJwk,
            "2099-01-01T00:00:00.000Z",
            null,
          ).valid,
        ).toBe(false);

        // ---- rollback to the previous key.
        await host?.close();
        start({ PAYFLOW_M6_SIGNING_KEY: PEM1 });
        const back = (await (await fetch(origin + "/v1/keys")).json()) as {
          keys: { keyId: string; status: string }[];
        };
        expect(back.keys.map((k) => `${k.keyId}:${k.status}`)).toEqual([
          `${k1}:ACTIVE`,
          `${k2}:RETIRED`,
        ]);

        // ---- revoke k2 (compromise): it leaves the verification document; its proofs stop verifying.
        const registry = new SigningKeyRegistry(repo.sql);
        expect(await registry.revoke(k2, NOW)).toBe(true);
        const after = await keysDoc();
        expect(after.keys.map((k) => k.keyId)).toEqual([k1]);
        expect(verifies(fresh.proof, after)).toBe(false);
        expect(verifies(old.proof, after)).toBe(true);
        // A process that still holds the revoked private key refuses to sign with it.
        await host?.close();
        start({
          PAYFLOW_M6_SIGNING_KEY: PEM2,
          PAYFLOW_M6_SIGNING_KID: "m6-hosted-2",
        });
        const refused = await fetch(
          `${origin}/v1/proofs/${fresh.id}/portable`,
          { headers: { authorization: `Bearer ${s.token}` } },
        );
        expect(refused.status).toBeGreaterThanOrEqual(500);
        expect(JSON.stringify(await refused.text())).not.toMatch(
          /BEGIN|PRIVATE/u,
        );
      });

      it("rotating the key without changing its id is refused, so a new Proof can never be published under the old public key", async () => {
        const s = await sandbox();
        await paidAndProof(s.token, s.client, s.authority);
        await host?.close();
        start({ PAYFLOW_M6_SIGNING_KEY: PEM2 }); // same default id "m6-hosted", different key
        const res = await fetch(`${origin}/v1/keys`);
        expect(res.status).toBeGreaterThanOrEqual(500);
        const body = await res.text();
        expect(body).not.toMatch(/BEGIN|PRIVATE|"d"/u);
        // No proof is issued either.
        const r = await fetch(`${origin}/v1/proofs/anything/portable`, {
          headers: { authorization: `Bearer ${s.token}` },
        });
        expect([404, 409, 500, 502, 503]).toContain(r.status);
        const stored =
          await repo.sql`select count(*)::int n from proof_signing_keys`;
        expect(Number(stored[0]!.n)).toBe(1);
      });

      it("the registry holds public keys only: private key material cannot be stored", async () => {
        const kp = generateKeyPairSync("ed25519");
        const registry = new SigningKeyRegistry(repo.sql);
        await expect(
          registry.activate(
            "i",
            "k-private",
            kp.privateKey.export({ format: "jwk" }),
            NOW,
          ),
        ).rejects.toThrow("PRIVATE_KEY_MATERIAL");
        await expect(
          repo.sql`insert into proof_signing_keys (key_id, issuer, public_jwk, status, created_at)
            values ('k-direct', 'i', ${repo.sql.json(kp.privateKey.export({ format: "jwk" }) as never)}, 'RETIRED', ${NOW})`,
        ).rejects.toThrow();
        await registry.activate(
          "i",
          "k-ok",
          kp.publicKey.export({ format: "jwk" }),
          NOW,
        );
        const stored = JSON.stringify(
          await repo.sql`select * from proof_signing_keys`,
        );
        expect(stored).not.toContain('"d"');
        // Only one ACTIVE key per issuer, ever.
        const kp2 = generateKeyPairSync("ed25519");
        await registry.activate(
          "i",
          "k-ok-2",
          kp2.publicKey.export({ format: "jwk" }),
          at(1),
        );
        expect(
          Number(
            (
              await repo.sql`select count(*)::int n from proof_signing_keys where status='ACTIVE' and issuer='i'`
            )[0]!.n,
          ),
        ).toBe(1);
        await expect(
          registry.activate(
            "i",
            "k-ok",
            kp.publicKey.export({ format: "jwk" }),
            at(2),
          ),
        ).resolves.toBe("ACTIVATED");
        await registry.revoke("k-ok-2", at(3));
        await expect(
          registry.activate(
            "i",
            "k-ok-2",
            kp2.publicKey.export({ format: "jwk" }),
            at(4),
          ),
        ).rejects.toThrow("KEY_REVOKED");
      });
    });

    describe("least-privilege database roles", () => {
      const roles = async () => {
        const sql = readFile("db/roles/least-privilege.sql", "utf8");
        await repo.sql.unsafe(await sql);
        for (const [login, group] of [
          ["t_runtime", "payflow_runtime"],
          ["t_readonly", "payflow_readonly"],
          ["t_migrator", "payflow_migrator"],
        ] as const) {
          await repo.sql.unsafe(`drop role if exists ${login}`);
          await repo.sql.unsafe(
            `create role ${login} login password 'pw_${login}' in role ${group}`,
          );
        }
      };
      const as = (login: string) => {
        const u = new URL(url!);
        u.username = login;
        u.password = `pw_${login}`;
        return postgres(u.toString(), { max: 2, onnotice: () => undefined });
      };
      const refused = async (p: PromiseLike<unknown>) => {
        try {
          await p;
        } catch (e) {
          return String((e as Error).message);
        }
        return null;
      };

      it("the runtime role can do its job and nothing else", async () => {
        await roles();
        const rt = as("t_runtime");
        try {
          await rt`insert into organizations (id, display_name) values ('rt-org', 'x')`;
          await rt`update organizations set display_name = 'y' where id = 'rt-org'`;
          expect(
            (await rt`select count(*)::int n from organizations`)[0]!.n,
          ).toBe(1);
          await rt`insert into organization_audit_events (organization_id, environment, actor_kind, actor_id, action, subject_kind, subject_id, occurred_at)
            values ('rt-org', 'SANDBOX', 'SYSTEM', 'x', 'TEST_EVENT', 'T', '1', ${NOW})`;
          for (const [what, q] of [
            ["create table", rt.unsafe("create table evil (x int)")],
            [
              "alter table",
              rt.unsafe("alter table organizations add column x int"),
            ],
            ["drop table", rt.unsafe("drop table organizations")],
            ["truncate", rt.unsafe("truncate organizations cascade")],
            [
              "update the append-only audit log",
              rt.unsafe("update organization_audit_events set actor_id = 'z'"),
            ],
            [
              "delete from the append-only audit log",
              rt.unsafe("delete from organization_audit_events"),
            ],
            ["create a role", rt.unsafe("create role evil login")],
            [
              "disable a trigger",
              rt.unsafe(
                "alter table organization_audit_events disable trigger all",
              ),
            ],
          ] as const)
            expect(await refused(q), what).toMatch(
              /permission denied|must be owner|append-only/iu,
            );
        } finally {
          await rt.end();
        }
      });

      it("the read-only role reads data but cannot write and never sees a secret digest", async () => {
        await roles();
        await repo.sql`insert into organizations (id, display_name) values ('ro-org', 'x') on conflict do nothing`;
        await repo.sql`insert into organization_members (member_id, secret_hash, organization_id, environment, display_name, role, status, created_by, created_at, expires_at)
          values ('pfm_aaaaaaaaaaaaaaaaaaaaaaaa', ${"a".repeat(64)}, 'ro-org', 'SANDBOX', 'x', 'VIEWER', 'ACTIVE', 't', ${NOW}, ${at(3600)})`;
        const ro = as("t_readonly");
        try {
          expect(
            (await ro`select count(*)::int n from organizations`)[0]!.n,
          ).toBeGreaterThan(0);
          expect(
            await ro`select member_id, role from organization_members`,
          ).toHaveLength(1);
          expect(
            await refused(ro`select secret_hash from organization_members`),
          ).toMatch(/permission denied/iu);
          expect(
            await refused(ro.unsafe("select * from organization_members")),
          ).toMatch(/permission denied/iu);
          expect(
            await refused(
              ro.unsafe("select secret_hash from agent_credentials"),
            ),
          ).toMatch(/permission denied/iu);
          for (const q of [
            "insert into organizations (id, display_name) values ('w','w')",
            "update organizations set display_name = 'w'",
            "delete from organizations",
            "truncate organizations cascade",
            "create table evil (x int)",
          ])
            expect(await refused(ro.unsafe(q)), q).toMatch(
              /permission denied/iu,
            );
        } finally {
          await ro.end();
        }
      });

      it("the migrator can change schema; the app cannot, and the whole hosted gateway runs on the runtime role alone", async () => {
        await roles();
        const mg = as("t_migrator");
        try {
          await mg.unsafe("create table migrator_probe (x int)");
          await mg.unsafe("drop table migrator_probe");
        } finally {
          await mg.end();
        }
        // Run the real hosted composition as the runtime role: a paid purchase, Proof, a member, a tick.
        const u = new URL(url!);
        u.username = "t_runtime";
        u.password = "pw_t_runtime";
        await host?.close();
        host = createHostedConsole(
          parseHostedConfig(env({ DATABASE_URL: u.toString() })),
          { clock, paymentProvider: provider },
        );
        const s = await sandbox();
        const r = await s.client.actions.execute(buy(s.authority));
        expect(r).toMatchObject({ status: "COMPLETED", effectCount: 1 });
        const pid = (r as { proof: { proposalId: string } }).proof.proposalId;
        expect(
          (
            await fetch(`${origin}/v1/proofs/${pid}/portable`, {
              headers: { authorization: `Bearer ${s.token}` },
            })
          ).status,
        ).toBe(200);
        expect(
          (await call(operator, "POST", "/v1/admin/ops/reconcile/tick")).status,
        ).toBe(200);
        expect((await call(s.owner, "GET", "/v1/admin/org/audit")).status).toBe(
          200,
        );
      });
    });
  },
);
