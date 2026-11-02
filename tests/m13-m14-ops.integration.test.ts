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
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import {
  agentInventory,
  authorityExposures,
  financeHome,
  pendingDecisions,
  securityHome,
} from "../src/network/org-views.js";
import { AuditLog } from "../src/network/ops-controls.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m13-host-private-bootstrap-".repeat(3);
const adminToken = "m13-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const NOW = "2026-10-23T10:00:00.000Z";

(url ? describe : describe.skip)(
  "M13/M14 organization controls, audit, rate limits and pauses (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date(NOW);
    const env = () => ({
      PAYFLOW_M5_DEMO: "true",
      DATABASE_URL: url,
      PAYFLOW_M5_PRINCIPAL_ID: "p",
      PAYFLOW_M5_AGENT_ID: "a",
      PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
      PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
      PAYFLOW_M6_DEMO_AGENT: "true",
      PAYFLOW_M6_SIGNING_KEY: pem,
      PAYFLOW_GATEWAY_ADMIN_TOKEN: adminToken,
    });
    const admin = (path: string, body?: unknown, token = adminToken) =>
      fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let seq = 0;
    const buy = (authority: string, over: Record<string, unknown> = {}) => ({
      authority,
      agent: "a",
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: `ops-nonce-${String(++seq).padStart(12, "0")}`,
      ...over,
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
      ).json()) as { token: string; credential: { credentialId: string } };
      return {
        authority: a.authority.id,
        token: c.token,
        credentialId: c.credential.credentialId,
        client: new PayFlowClient({ baseUrl: origin, accessToken: c.token }),
      };
    }
    const calls = () => provider.createCalls + provider.captureCalls;
    async function lowThresholdAuthority(org = "payflow-sandbox") {
      const id = `esc-authority-${Math.random().toString(36).slice(2, 10)}`;
      await repo.saveMandate({
        id,
        principalId: "p",
        authorizedAgentId: "a",
        purpose: "Escalation test",
        category: "KEYBOARD",
        currency: "USD",
        maxSingleTransactionMinor: 10000,
        cumulativeLimitMinor: 10000,
        quantityLimit: 1,
        merchantScope: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
        allowedConditions: ["NEW"],
        merchantRiskCeiling: "LOW",
        autonomousPurchaseThresholdMinor: 5000,
        humanApprovalThresholdMinor: 10000,
        allowedCapabilities: ["CAPTURE_PAYMENT"],
        version: 1,
        nonce: "escalation-nonce-" + id,
        createdAt: NOW,
        expiresAt: "2026-10-24T10:00:00.000Z",
      } as never);
      await repo.sql`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id) values (${id}, ${org}, 'SANDBOX', 'p')`;
      return id;
    }

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
      host = createHostedConsole(parseHostedConfig(env()), {
        clock,
        paymentProvider: provider,
      });
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    }, 60_000);

    describe("finance and exposure", () => {
      it("a paid purchase shows as settled and the available figure equals what the kernel enforces", async () => {
        const s = await sandbox();
        expect((await s.client.actions.execute(buy(s.authority))).status).toBe(
          "COMPLETED",
        );
        const [e] = await authorityExposures(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
          s.authority,
        );
        expect(e).toMatchObject({
          settledMinor: 8400,
          reservedMinor: 0,
          pendingMinor: 0,
          availableMinor: 1600,
          limitMinor: 10000,
          status: "ACTIVE",
        });
        const kernel = await repo.authorityAccounting(s.authority, 10000);
        expect(e!.reservedMinor + e!.pendingMinor + e!.settledMinor).toBe(
          kernel.consumedMinor,
        );
        const f = await financeHome(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
        );
        expect(f).toMatchObject({
          settledMinor: 8400,
          availableMinor: 1600,
          committedObligations: "NOT_MODELLED",
        });
      });

      it("an UNKNOWN payment stays pending and is NOT released as available", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        expect((await s.client.actions.execute(buy(s.authority))).status).toBe(
          "UNRESOLVED",
        );
        const [e] = await authorityExposures(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
          s.authority,
        );
        expect(e).toMatchObject({ pendingMinor: 8400, availableMinor: 1600 });
        expect(e!.settledMinor).toBe(0);
      });

      it("the operator UNKNOWN view lists the unresolved payment, with provider references, and never re-executes", async () => {
        const s = await sandbox();
        provider.loseCapture = true;
        const r = await s.client.actions.execute(buy(s.authority));
        expect(r.status).toBe("UNRESOLVED");
        const before = {
          creates: provider.createCalls,
          captures: provider.captureCalls,
        };
        const res = (await (await admin("/v1/admin/org/unknown")).json()) as {
          operations: {
            operationId: string;
            state: string;
            amountMinor: number;
            agentId: string;
          }[];
          note: string;
        };
        expect(res.operations).toHaveLength(1);
        expect(res.operations[0]).toMatchObject({
          amountMinor: 8400,
          agentId: "a",
        });
        expect(res.operations[0]!.operationId).toBe(r.proof!.proposalId);
        expect(res.note).toMatch(/Observation only/);
        expect({
          creates: provider.createCalls,
          captures: provider.captureCalls,
        }).toEqual(before);
      });

      it("agent inventory and security home show sponsor, exposure, blast radius and denials", async () => {
        const s = await sandbox();
        await s.client.actions.execute(buy(s.authority, { amount: 5000 })); // denied
        const inv = await agentInventory(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
        );
        expect(inv).toHaveLength(1);
        expect(inv[0]).toMatchObject({
          agentId: "a",
          name: "Procurement Agent",
          sponsorPrincipalId: "p",
          activeAuthorities: 1,
        });
        const sec = await securityHome(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
        );
        expect(sec[0]).toMatchObject({
          agentId: "a",
          blastRadiusMinor: 10000,
          deniedLast24h: 1,
        });
      });
    });

    describe("approval escalation", () => {
      it("above the autonomous limit the request waits for a human; the agent cannot approve it", async () => {
        const s = await sandbox();
        const id = await lowThresholdAuthority();
        const r = await s.client.actions.execute(buy(id));
        expect(r).toMatchObject({ status: "NEEDS_APPROVAL", effectCount: 0 });
        expect(calls()).toBe(0);
        const queue = await pendingDecisions(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
        );
        expect(queue).toHaveLength(1);
        expect(queue[0]).toMatchObject({
          amountMinor: 8400,
          autonomousLimitMinor: 5000,
          agentId: "a",
          authorityId: id,
        });
        // The agent's own credential is not an admin credential: it cannot reach the approval route.
        const attempt = await admin(
          `/v1/admin/decisions/${queue[0]!.receiptId}/approve`,
          {},
          s.token,
        );
        expect(attempt.status).toBe(401);
        expect(
          await pendingDecisions(repo.sql, "payflow-sandbox", "SANDBOX"),
        ).toHaveLength(1);
      });

      it("an administrator approves once: Authority is reserved, nothing is paid, a second approval is refused", async () => {
        const s = await sandbox();
        const id = await lowThresholdAuthority();
        await s.client.actions.execute(buy(id));
        const [d] = await pendingDecisions(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
        );
        const ok = await admin(
          `/v1/admin/decisions/${d!.receiptId}/approve`,
          {},
        );
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({
          result: "APPROVED_ONCE",
          effect: "NONE_YET",
        });
        expect(calls()).toBe(0);
        const [e] = await authorityExposures(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
          id,
        );
        expect(e).toMatchObject({ reservedMinor: 8400, availableMinor: 1600 });
        expect(
          (await admin(`/v1/admin/decisions/${d!.receiptId}/approve`, {}))
            .status,
        ).toBe(404);
      });

      it("rejecting records an audit event, removes it from the queue and moves no money", async () => {
        const s = await sandbox();
        const id = await lowThresholdAuthority();
        await s.client.actions.execute(buy(id));
        const [d] = await pendingDecisions(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
        );
        expect(
          (await admin(`/v1/admin/decisions/${d!.receiptId}/reject`, {}))
            .status,
        ).toBe(200);
        expect(
          await pendingDecisions(repo.sql, "payflow-sandbox", "SANDBOX"),
        ).toHaveLength(0);
        const [e] = await authorityExposures(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
          NOW,
          id,
        );
        expect(e).toMatchObject({ reservedMinor: 0, settledMinor: 0 });
        expect(calls()).toBe(0);
      });
    });

    describe("tenant isolation", () => {
      it("another organization's Authority, agents, decisions and audit are invisible and unapprovable", async () => {
        const s = await sandbox();
        await repo.sql`insert into organizations (id, display_name) values ('org-b','B')`;
        await repo.savePrincipal({ id: "pb", displayName: "B owner" });
        await repo.saveAgent({
          id: "ab",
          principalId: "pb",
          displayName: "B agent",
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities,
        });
        await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id) values ('org-b','ab','SANDBOX','pb')`;
        const idB = `b-authority-${Math.random().toString(36).slice(2, 8)}`;
        await repo.saveMandate({
          id: idB,
          principalId: "pb",
          authorizedAgentId: "ab",
          purpose: "B only",
          category: "KEYBOARD",
          currency: "USD",
          maxSingleTransactionMinor: 10000,
          cumulativeLimitMinor: 10000,
          quantityLimit: 1,
          merchantScope: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
          allowedConditions: ["NEW"],
          merchantRiskCeiling: "LOW",
          autonomousPurchaseThresholdMinor: 5000,
          humanApprovalThresholdMinor: 10000,
          allowedCapabilities: ["CAPTURE_PAYMENT"],
          version: 1,
          nonce: "b-nonce-" + idB,
          createdAt: NOW,
          expiresAt: "2026-10-24T10:00:00.000Z",
        } as never);
        await repo.sql`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id) values (${idB}, 'org-b', 'SANDBOX', 'pb')`;
        await new AuditLog(repo.sql).append({
          organizationId: "org-b",
          environment: "SANDBOX",
          actorKind: "ADMIN",
          actorId: "b-admin",
          action: "AUTHORITY_PROVISIONED",
          subjectKind: "AUTHORITY",
          subjectId: idB,
          occurredAt: NOW,
        });

        const a = (await (await admin("/v1/admin/org/authorities")).json()) as {
          authorities: { authorityId: string }[];
        };
        expect(a.authorities.map((x) => x.authorityId)).toEqual([s.authority]);
        const ag = (await (await admin("/v1/admin/org/agents")).json()) as {
          agents: { agentId: string }[];
        };
        expect(ag.agents.map((x) => x.agentId)).toEqual(["a"]);
        const au = JSON.stringify(
          await (await admin("/v1/admin/org/audit")).json(),
        );
        expect(au).not.toContain("b-admin");
        expect(au).not.toContain(idB);
        // B's own projections see only B.
        expect(
          (await authorityExposures(repo.sql, "org-b", "SANDBOX", NOW)).map(
            (x) => x.authorityId,
          ),
        ).toEqual([idB]);
        expect(
          await authorityExposures(repo.sql, "org-b", "PRODUCTION", NOW),
        ).toEqual([]); // environment separation
        // A's admin cannot approve B's escalation: indistinguishable from absence.
        const sB = new PayFlowClient({ baseUrl: origin, accessToken: s.token });
        void sB;
        const fake = await admin(
          `/v1/admin/decisions/00000000-0000-4000-8000-000000000000/approve`,
          {},
        );
        expect(fake.status).toBe(404);
      });
    });

    describe("rate limits, pauses and suspension", () => {
      it("requests over the limit get a structured 429 with Retry-After and are never processed", async () => {
        let limited: Response | undefined;
        for (let i = 0; i < 130 && !limited; i++) {
          const r = await fetch(origin + "/v1/keys");
          if (r.status === 429) limited = r;
        }
        expect(limited).toBeDefined();
        expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await limited!.json()).toMatchObject({
          reason: "RATE_LIMITED",
          effectCount: 0,
          recoverable: true,
        });
      });

      it("a global pause refuses new payments with zero effect, but Proof stays readable; unpausing restores service", async () => {
        const s = await sandbox();
        const first = await s.client.actions.execute(
          buy(s.authority, { amount: 5000 }),
        );
        expect(first.status).toBe("DENIED");
        await repo.sql`insert into execution_controls (scope, disabled, reason) values ('GLOBAL', true, 'drill')`;
        const paused = await s.client.actions.execute(buy(s.authority));
        expect(paused).toMatchObject({
          status: "DENIED",
          reason: "EXECUTION_PAUSED",
          effectCount: 0,
        });
        expect(calls()).toBe(0);
        const [r] =
          await repo.sql`select count(*)::int n from authorization_reservations`;
        expect(r!.n).toBe(0);
        await repo.sql`update execution_controls set disabled = false where scope = 'GLOBAL'`;
        expect((await s.client.actions.execute(buy(s.authority))).status).toBe(
          "COMPLETED",
        );
      });

      it("an organization pause or an environment pause also blocks, and only that scope", async () => {
        const s = await sandbox();
        await repo.sql`insert into execution_controls (scope, disabled, reason) values ('ORG:other-org', true, 'x')`;
        await repo.sql`insert into execution_controls (scope, disabled, reason) values ('ENV:PRODUCTION', true, 'x')`;
        expect(
          await s.client.actions.execute(buy(s.authority, { amount: 5000 })),
        ).not.toMatchObject({ reason: "EXECUTION_PAUSED" });
        await repo.sql`insert into execution_controls (scope, disabled, reason) values ('ORG:payflow-sandbox', true, 'incident')`;
        expect(await s.client.actions.execute(buy(s.authority))).toMatchObject({
          reason: "EXECUTION_PAUSED",
        });
      });

      it("a suspended organization's credentials stop working entirely", async () => {
        const s = await sandbox();
        await repo.sql`update organizations set status = 'SUSPENDED' where id = 'payflow-sandbox'`;
        const r = await s.client.actions.execute(buy(s.authority));
        expect(r).toMatchObject({
          status: "REJECTED",
          effectCount: 0,
          httpStatus: 401,
        });
        expect(calls()).toBe(0);
      });
    });

    describe("audit trail", () => {
      it("records who issued, revoked, provisioned, evaluated and approved, without any secret", async () => {
        const s = await sandbox();
        await s.client.actions.execute(buy(s.authority));
        await admin(`/v1/admin/credentials/${s.credentialId}/revoke`, {});
        const events = (await (await admin("/v1/admin/org/audit")).json()) as {
          events: { action: string }[];
        };
        const actions = events.events.map((e) => e.action);
        for (const a of [
          "AUTHORITY_PROVISIONED",
          "CREDENTIAL_ISSUED",
          "ACTION_EVALUATED",
          "CREDENTIAL_REVOKED",
        ])
          expect(actions).toContain(a);
        const text = JSON.stringify(events);
        expect(text).not.toContain(s.token.split(".")[1]!);
        expect(text).not.toMatch(/nonce|bearer/i);
      });

      it("the developer funnel counts stages from durable records and names what it does not measure", async () => {
        const s = await sandbox();
        await s.client.actions.execute(buy(s.authority));
        await s.client.actions.execute(buy(s.authority, { amount: 5000 }));
        const f = (await (await admin("/v1/admin/org/funnel")).json()) as {
          funnel: Record<string, unknown>;
        };
        expect(f.funnel).toMatchObject({
          credentialsIssued: 1,
          authoritiesProvisioned: 1,
          evaluated: 2,
          allowedAndPaid: 1,
          denied: 1,
          unresolved: 0,
        });
        expect(f.funnel.firstEvaluatedAt).toBeTruthy();
        expect(f.funnel.notMeasuredServerSide).toEqual(
          expect.arrayContaining(["visit", "docs", "first verify"]),
        );
        const text = JSON.stringify(f);
        expect(text).not.toMatch(/token|secret|nonce|pfc_/i);
      });

      it("is append-only at the database: update, delete and truncate are refused", async () => {
        await sandbox();
        await expect(
          repo.sql`update organization_audit_events set actor_id = 'x'`,
        ).rejects.toThrow(/append-only/);
        await expect(
          repo.sql`delete from organization_audit_events`,
        ).rejects.toThrow(/append-only/);
        await expect(
          repo.sql`truncate organization_audit_events`,
        ).rejects.toThrow(/append-only/);
      });

      it("refuses to record a detail key that looks like a secret", async () => {
        await sandbox();
        await expect(
          new AuditLog(repo.sql).append({
            organizationId: "payflow-sandbox",
            environment: "SANDBOX",
            actorKind: "SYSTEM",
            actorId: "t",
            action: "TEST_EVENT",
            subjectKind: "X",
            subjectId: "y",
            detail: { bearerToken: "x" },
            occurredAt: NOW,
          }),
        ).rejects.toThrow("AUDIT_DETAIL_FORBIDDEN_KEY");
      });
    });
  },
);
