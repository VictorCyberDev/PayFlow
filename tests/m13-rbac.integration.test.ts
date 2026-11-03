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
import { pendingDecisions } from "../src/network/org-views.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m13r-host-private-bootstrap-".repeat(3);
const operator = "m13r-platform-operator-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const NOW = "2026-10-23T10:00:00.000Z";
const ROLES = [
  "OWNER",
  "FINANCE_ADMIN",
  "SECURITY_ADMIN",
  "DEVELOPER",
  "APPROVER",
  "AUDITOR",
  "VIEWER",
] as const;

/**
 * Independent statement of what each role may do. It is written out here on purpose and does NOT
 * import the permission table from the source, so a mistake in the source cannot also be a mistake
 * in the oracle. true = allowed (2xx), false = refused with 403.
 */
const EXPECTED: Record<string, Record<(typeof ROLES)[number], boolean>> = {
  "GET /v1/admin/org/agents": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: true,
    DEVELOPER: true,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: true,
  },
  "GET /v1/admin/org/finance": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: false,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: true,
  },
  "GET /v1/admin/org/security": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: true,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/org/authorities": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: true,
    DEVELOPER: false,
    APPROVER: true,
    AUDITOR: true,
    VIEWER: true,
  },
  "GET /v1/admin/org/decisions": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: false,
    DEVELOPER: false,
    APPROVER: true,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/org/unknown": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: true,
    DEVELOPER: true,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/org/funnel": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: false,
    DEVELOPER: true,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/org/audit": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: true,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/members": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: false,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "GET /v1/admin/credentials": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: true,
    DEVELOPER: true,
    APPROVER: false,
    AUDITOR: true,
    VIEWER: false,
  },
  "POST /v1/admin/credentials": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: false,
    DEVELOPER: true,
    APPROVER: false,
    AUDITOR: false,
    VIEWER: false,
  },
  "POST /v1/admin/members": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: false,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: false,
    VIEWER: false,
  },
  "POST /v1/admin/org/pause": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: true,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: false,
    VIEWER: false,
  },
  "POST /v1/admin/org/resume": {
    OWNER: true,
    FINANCE_ADMIN: false,
    SECURITY_ADMIN: true,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: false,
    VIEWER: false,
  },
  "POST /v1/admin/sandbox/authority": {
    OWNER: true,
    FINANCE_ADMIN: true,
    SECURITY_ADMIN: false,
    DEVELOPER: false,
    APPROVER: false,
    AUDITOR: false,
    VIEWER: false,
  },
};

(url ? describe : describe.skip)(
  "M13 server-side role enforcement, tenant and environment isolation (PostgreSQL + real HTTP)",
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
      PAYFLOW_GATEWAY_ADMIN_TOKEN: operator,
    });
    const call = (
      token: string | null,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });

    /** Org A + one member of every role, minted through the operator bootstrap and an OWNER. */
    async function tenant(orgId: string, environment = "SANDBOX") {
      await repo.sql`insert into organizations (id, display_name) values (${orgId}, ${orgId}) on conflict (id) do nothing`;
      const boot = await call(operator, "POST", "/v1/admin/members", {
        organizationId: orgId,
        environment,
        displayName: `${orgId} owner`,
        role: "OWNER",
      });
      expect(boot.status).toBe(201);
      const owner = ((await boot.json()) as { token: string }).token;
      const tokens: Record<string, string> = { OWNER: owner };
      for (const role of ROLES.filter((r) => r !== "OWNER")) {
        const r = await call(owner, "POST", "/v1/admin/members", {
          displayName: `${orgId} ${role}`,
          role,
        });
        expect(r.status).toBe(201);
        tokens[role] = ((await r.json()) as { token: string }).token;
      }
      return tokens as Record<(typeof ROLES)[number], string>;
    }
    const buy = (authority: string, nonce: string) => ({
      authority,
      agent: "a",
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce,
    });
    async function seedAuthority() {
      const r = await call(operator, "POST", "/v1/admin/sandbox/authority", {});
      expect(r.status).toBe(201);
      return ((await r.json()) as { authority: { id: string } }).authority.id;
    }
    async function lowThresholdAuthority(org: string) {
      const id = `esc-${Math.random().toString(36).slice(2, 10)}`;
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
        nonce: "esc-nonce-" + id,
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

    describe("the role matrix is enforced by the server", () => {
      it("every role gets exactly the access the matrix grants, on every route", async () => {
        await seedAuthority();
        const t = await tenant("payflow-sandbox");
        const bodies: Record<string, unknown> = {
          "POST /v1/admin/credentials": {
            agentId: "a",
            scopes: ["action:request"],
            ttlSeconds: 600,
          },
          "POST /v1/admin/members": { displayName: "x", role: "VIEWER" },
          "POST /v1/admin/org/pause": { reason: "matrix" },
          "POST /v1/admin/sandbox/authority": {},
        };
        const wrong: string[] = [];
        for (const [route, byRole] of Object.entries(EXPECTED)) {
          const [method, path] = route.split(" ") as ["GET" | "POST", string];
          // 7 calls per route stay under the admin limit; reset between routes.
          await repo.sql`delete from rate_limit_windows`;
          for (const role of ROLES) {
            const r = await call(t[role], method, path, bodies[route]);
            const allowed = r.status >= 200 && r.status < 300;
            if (allowed !== byRole[role] || (!allowed && r.status !== 403))
              wrong.push(`${role} ${route} -> ${r.status}`);
            // org/pause by an allowed role would block the following checks: lift it at once.
            if (route === "POST /v1/admin/org/pause" && allowed)
              await call(t.OWNER, "POST", "/v1/admin/org/resume");
          }
        }
        expect(wrong).toEqual([]);
      });

      it("a refused mutation changes nothing", async () => {
        const t = await tenant("payflow-sandbox");
        const before = async () => ({
          members: Number(
            (
              await repo.sql`select count(*)::int n from organization_members`
            )[0]!.n,
          ),
          creds: Number(
            (await repo.sql`select count(*)::int n from agent_credentials`)[0]!
              .n,
          ),
          controls: Number(
            (await repo.sql`select count(*)::int n from execution_controls`)[0]!
              .n,
          ),
        });
        const snap = await before();
        for (const role of ["VIEWER", "AUDITOR", "APPROVER"] as const) {
          expect(
            (
              await call(t[role], "POST", "/v1/admin/credentials", {
                agentId: "a",
                scopes: ["action:request"],
                ttlSeconds: 600,
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await call(t[role], "POST", "/v1/admin/members", {
                displayName: "evil",
                role: "OWNER",
              })
            ).status,
          ).toBe(403);
          expect(
            (await call(t[role], "POST", "/v1/admin/org/pause", {})).status,
          ).toBe(403);
        }
        expect(await before()).toEqual(snap);
      });

      it("a developer cannot widen finance Authority or approve spend; a viewer cannot read audit", async () => {
        const t = await tenant("payflow-sandbox");
        expect(
          (await call(t.DEVELOPER, "POST", "/v1/admin/sandbox/authority", {}))
            .status,
        ).toBe(403);
        expect(
          (
            await call(
              t.DEVELOPER,
              "POST",
              "/v1/admin/decisions/anything/approve",
              {},
            )
          ).status,
        ).toBe(403);
        expect(
          (await call(t.VIEWER, "GET", "/v1/admin/org/audit")).status,
        ).toBe(403);
        // A developer cannot promote themselves or anyone else.
        expect(
          (
            await call(t.DEVELOPER, "POST", "/v1/admin/members", {
              displayName: "me",
              role: "OWNER",
            })
          ).status,
        ).toBe(403);
      });

      it("a role claimed in a header, query or body is not an authorization input", async () => {
        const t = await tenant("payflow-sandbox");
        const r = await call(
          t.VIEWER,
          "POST",
          "/v1/admin/members?role=OWNER",
          { displayName: "x", role: "OWNER", roleOverride: "OWNER" },
          { "x-payflow-role": "OWNER", "x-role": "OWNER" },
        );
        expect(r.status).toBe(403);
      });
    });

    describe("approvals follow the role", () => {
      it("only an approver, finance admin or owner can approve; the others are refused and nothing is reserved", async () => {
        await seedAuthority();
        const t = await tenant("payflow-sandbox");
        const issued = await call(
          t.DEVELOPER,
          "POST",
          "/v1/admin/credentials",
          {
            agentId: "a",
            scopes: ["action:request", "proof:read"],
            ttlSeconds: 600,
          },
        );
        const cred = ((await issued.json()) as { token: string }).token;
        const client = new PayFlowClient({
          baseUrl: origin,
          accessToken: cred,
        });
        const id = await lowThresholdAuthority("payflow-sandbox");
        expect(
          await client.actions.execute(buy(id, "rbac-nonce-000000000001")),
        ).toMatchObject({ status: "NEEDS_APPROVAL", effectCount: 0 });
        const [d] = await pendingDecisions(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
        );
        const path = `/v1/admin/decisions/${d!.receiptId}/approve`;
        for (const role of [
          "DEVELOPER",
          "AUDITOR",
          "VIEWER",
          "SECURITY_ADMIN",
        ] as const)
          expect((await call(t[role], "POST", path)).status).toBe(403);
        expect(
          await pendingDecisions(repo.sql, "payflow-sandbox", "SANDBOX"),
        ).toHaveLength(1);
        const ok = await call(t.APPROVER, "POST", path);
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({
          result: "APPROVED_ONCE",
          effect: "NONE_YET",
        });
        expect(provider.createCalls + provider.captureCalls).toBe(0);
        const audit = (await (
          await call(t.AUDITOR, "GET", "/v1/admin/org/audit")
        ).json()) as {
          events: { action: string; actorKind: string; actorId: string }[];
        };
        expect(
          audit.events.find((e) => e.action === "APPROVAL_RECORDED"),
        ).toMatchObject({ actorKind: "MEMBER" });
      });
    });

    describe("authentication of the actor", () => {
      it("revoked, expired, unknown, malformed and agent credentials are all the same 401", async () => {
        await seedAuthority();
        const t = await tenant("payflow-sandbox");
        const probe = async (token: string | null) =>
          call(token, "GET", "/v1/admin/org/agents");
        expect((await probe(t.VIEWER)).status).toBe(200);
        // Revoke
        const list = (await (
          await call(t.OWNER, "GET", "/v1/admin/members")
        ).json()) as { members: { memberId: string; role: string }[] };
        const viewer = list.members.find((m) => m.role === "VIEWER")!;
        expect(
          (
            await call(
              t.OWNER,
              "POST",
              `/v1/admin/members/${viewer.memberId}/revoke`,
            )
          ).status,
        ).toBe(200);
        expect((await probe(t.VIEWER)).status).toBe(401);
        // Expire
        await repo.sql`update organization_members set expires_at = ${"2026-10-01T00:00:00.000Z"} where role = 'AUDITOR'`;
        expect((await probe(t.AUDITOR)).status).toBe(401);
        // Unknown id, malformed, missing, wrong secret
        const forged =
          t.DEVELOPER.slice(0, -3) +
          (t.DEVELOPER.endsWith("AAA") ? "BBB" : "AAA");
        for (const bad of [
          "pf_act_pfm_000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "not-a-token",
          forged,
          null,
        ])
          expect((await probe(bad)).status).toBe(401);
        // An agent credential is not a member.
        const c = await call(t.OWNER, "POST", "/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request"],
          ttlSeconds: 600,
        });
        const agentToken = ((await c.json()) as { token: string }).token;
        expect((await probe(agentToken)).status).toBe(401);
        // And a member token is not an agent credential.
        const exec = await call(
          t.OWNER,
          "POST",
          "/v1/actions/execute",
          buy("x", "rbac-nonce-000000000009"),
        );
        expect(exec.status).toBe(401);
      });

      it("the platform operator token holds no organization role", async () => {
        await seedAuthority();
        await tenant("payflow-sandbox");
        for (const [method, path] of [
          ["GET", "/v1/admin/org/audit"],
          ["GET", "/v1/admin/org/finance"],
          ["GET", "/v1/admin/members"],
          ["GET", "/v1/admin/credentials"],
          ["POST", "/v1/admin/credentials"],
          ["POST", "/v1/admin/org/pause"],
        ] as const) {
          const r = await call(operator, method, path, {
            agentId: "a",
            scopes: ["action:request"],
            ttlSeconds: 600,
          });
          expect(r.status, `${method} ${path}`).toBe(403);
          expect(await r.json()).toMatchObject({
            reason: "OPERATOR_TOKEN_HAS_NO_ORGANIZATION_ROLE",
          });
        }
        // The operator can only bootstrap an OWNER of an existing organization.
        expect(
          (
            await call(operator, "POST", "/v1/admin/members", {
              organizationId: "payflow-sandbox",
              displayName: "x",
              role: "VIEWER",
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await call(operator, "POST", "/v1/admin/members", {
              organizationId: "no-such-org",
              displayName: "x",
              role: "OWNER",
            })
          ).status,
        ).toBe(400);
      });

      it("the last owner cannot be revoked; a second owner makes it possible", async () => {
        const t = await tenant("payflow-sandbox");
        const members = (await (
          await call(t.OWNER, "GET", "/v1/admin/members")
        ).json()) as { members: { memberId: string; role: string }[] };
        const ownerId = members.members.find(
          (m) => m.role === "OWNER",
        )!.memberId;
        const last = await call(
          t.OWNER,
          "POST",
          `/v1/admin/members/${ownerId}/revoke`,
        );
        expect(last.status).toBe(409);
        expect(await last.json()).toMatchObject({ result: "LAST_OWNER" });
        const second = await call(t.OWNER, "POST", "/v1/admin/members", {
          displayName: "co-owner",
          role: "OWNER",
        });
        expect(second.status).toBe(201);
        expect(
          (await call(t.OWNER, "POST", `/v1/admin/members/${ownerId}/revoke`))
            .status,
        ).toBe(200);
        expect((await call(t.OWNER, "GET", "/v1/admin/members")).status).toBe(
          401,
        );
      });

      it("no response, audit row or member listing ever contains a token or its digest", async () => {
        const t = await tenant("payflow-sandbox");
        const listing = await (
          await call(t.OWNER, "GET", "/v1/admin/members")
        ).text();
        const audit = await (
          await call(t.OWNER, "GET", "/v1/admin/org/audit")
        ).text();
        for (const secret of Object.values(t)) {
          const raw = secret.split(".")[1]!;
          expect(listing).not.toContain(raw);
          expect(audit).not.toContain(raw);
        }
        expect(listing).not.toMatch(/secret_hash|secretHash|pf_act_/u);
        expect(audit).not.toMatch(/pf_act_|pf_sbx_/u);
      });
    });

    describe("tenant and environment isolation", () => {
      it("another organization's owner sees none of this organization's data and cannot act on it", async () => {
        await seedAuthority();
        const a = await tenant("payflow-sandbox");
        const b = await tenant("other-org");
        const issued = await call(a.OWNER, "POST", "/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request", "proof:read"],
          ttlSeconds: 600,
        });
        const issuedBody = (await issued.json()) as {
          credential: { credentialId: string };
        };
        const aMembers = (await (
          await call(a.OWNER, "GET", "/v1/admin/members")
        ).json()) as { members: { memberId: string }[] };

        // Reads are scoped to the caller's own organization.
        const bAudit = (await (
          await call(b.OWNER, "GET", "/v1/admin/org/audit")
        ).json()) as {
          events: { subjectId: string; organizationId: string }[];
        };
        expect(
          bAudit.events.every((e) => e.organizationId === "other-org"),
        ).toBe(true);
        expect(JSON.stringify(bAudit)).not.toContain(
          issuedBody.credential.credentialId,
        );
        const bAgents = (await (
          await call(b.OWNER, "GET", "/v1/admin/org/agents")
        ).json()) as { agents: unknown[] };
        expect(bAgents.agents).toEqual([]);
        const bCreds = (await (
          await call(b.OWNER, "GET", "/v1/admin/credentials")
        ).json()) as { credentials: unknown[] };
        expect(bCreds.credentials).toEqual([]);
        const bMembers = (await (
          await call(b.OWNER, "GET", "/v1/admin/members")
        ).json()) as { members: { memberId: string }[] };
        expect(
          bMembers.members
            .map((m) => m.memberId)
            .some((id) => aMembers.members.some((x) => x.memberId === id)),
        ).toBe(false);

        // Writes against another organization's resources look exactly like "not found".
        const revokeCred = await call(
          b.OWNER,
          "POST",
          `/v1/admin/credentials/${issuedBody.credential.credentialId}/revoke`,
        );
        expect(revokeCred.status).toBe(404);
        const revokeMember = await call(
          b.OWNER,
          "POST",
          `/v1/admin/members/${aMembers.members[1]!.memberId}/revoke`,
        );
        expect(revokeMember.status).toBe(404);
        const stillActive =
          await repo.sql`select count(*)::int n from agent_credentials where status = 'ACTIVE'`;
        expect(Number(stillActive[0]!.n)).toBe(1);

        // A's escalation cannot be approved from B, and B cannot tell it exists.
        const client = new PayFlowClient({
          baseUrl: origin,
          accessToken: (
            (await (
              await call(a.OWNER, "POST", "/v1/admin/credentials", {
                agentId: "a",
                scopes: ["action:request"],
                ttlSeconds: 600,
              })
            ).json()) as { token: string }
          ).token,
        });
        const id = await lowThresholdAuthority("payflow-sandbox");
        await client.actions.execute(buy(id, "rbac-nonce-000000000002"));
        const [d] = await pendingDecisions(
          repo.sql,
          "payflow-sandbox",
          "SANDBOX",
        );
        const cross = await call(
          b.OWNER,
          "POST",
          `/v1/admin/decisions/${d!.receiptId}/approve`,
        );
        const unknown = await call(
          b.OWNER,
          "POST",
          `/v1/admin/decisions/${"0".repeat(8)}-0000-0000-0000-000000000000/approve`,
        );
        expect(cross.status).toBe(404);
        expect(await cross.json()).toMatchObject({
          reason: "DECISION_NOT_FOUND",
        });
        expect(unknown.status).toBe(404);
        expect(
          await pendingDecisions(repo.sql, "payflow-sandbox", "SANDBOX"),
        ).toHaveLength(1);
        expect(
          await (await call(b.OWNER, "GET", "/v1/admin/org/decisions")).json(),
        ).toMatchObject({ decisions: [] });
      });

      it("a PRODUCTION member of the same organization sees and changes nothing in SANDBOX", async () => {
        await seedAuthority();
        const sbx = await tenant("payflow-sandbox", "SANDBOX");
        const prod = await call(operator, "POST", "/v1/admin/members", {
          organizationId: "payflow-sandbox",
          environment: "PRODUCTION",
          displayName: "prod owner",
          role: "OWNER",
        });
        const prodOwner = ((await prod.json()) as { token: string }).token;
        await call(sbx.OWNER, "POST", "/v1/admin/credentials", {
          agentId: "a",
          scopes: ["action:request"],
          ttlSeconds: 600,
        });
        expect(
          await (await call(prodOwner, "GET", "/v1/admin/org/agents")).json(),
        ).toMatchObject({ agents: [] });
        expect(
          await (await call(prodOwner, "GET", "/v1/admin/credentials")).json(),
        ).toMatchObject({ credentials: [] });
        const sbxMembers = (await (
          await call(sbx.OWNER, "GET", "/v1/admin/members")
        ).json()) as { members: { memberId: string }[] };
        expect(
          (
            await call(
              prodOwner,
              "POST",
              `/v1/admin/members/${sbxMembers.members[1]!.memberId}/revoke`,
            )
          ).status,
        ).toBe(404);
      });
    });

    describe("administrative rate limiting", () => {
      it("a flood of bad-token admin calls cannot lock a legitimate member out", async () => {
        const t = await tenant("payflow-sandbox");
        let limited = 0;
        for (let i = 0; i < 75; i++) {
          const r = await call(
            "pf_act_pfm_" + "0".repeat(24) + ".x".repeat(20),
            "GET",
            "/v1/admin/org/agents",
          );
          if (r.status === 429) limited++;
        }
        expect(limited).toBeGreaterThan(0); // the flood itself is throttled
        // The owner has their own bucket and still gets through.
        expect(
          (await call(t.OWNER, "GET", "/v1/admin/org/agents")).status,
        ).toBe(200);
        expect(
          (await call(t.AUDITOR, "GET", "/v1/admin/org/audit")).status,
        ).toBe(200);
      });
    });

    describe("audit and containment", () => {
      it("a denied attempt is recorded under the member, and a member action is attributed to them", async () => {
        const t = await tenant("payflow-sandbox");
        await call(t.VIEWER, "POST", "/v1/admin/org/pause", {});
        await call(t.SECURITY_ADMIN, "POST", "/v1/admin/org/pause", {
          reason: "drill",
        });
        const events = (
          (await (
            await call(t.AUDITOR, "GET", "/v1/admin/org/audit")
          ).json()) as {
            events: {
              action: string;
              actorKind: string;
              actorId: string;
              detail: Record<string, unknown>;
            }[];
          }
        ).events;
        const denied = events.find((e) => e.action === "PERMISSION_DENIED")!;
        expect(denied).toMatchObject({
          actorKind: "MEMBER",
          detail: { permission: "org:pause", role: "VIEWER" },
        });
        expect(
          events.find((e) => e.action === "ORG_EXECUTION_PAUSED"),
        ).toMatchObject({
          actorKind: "MEMBER",
          detail: { role: "SECURITY_ADMIN" },
        });
        expect(events.find((e) => e.action === "MEMBER_ADDED")).toBeDefined();
      });

      it("a security admin can contain the organization: new executions are refused with $0 moved, then resumed", async () => {
        const authority = await seedAuthority();
        const t = await tenant("payflow-sandbox");
        const cred = (
          (await (
            await call(t.DEVELOPER, "POST", "/v1/admin/credentials", {
              agentId: "a",
              scopes: ["action:request", "proof:read"],
              ttlSeconds: 600,
            })
          ).json()) as { token: string }
        ).token;
        const client = new PayFlowClient({
          baseUrl: origin,
          accessToken: cred,
        });
        expect(
          (
            await call(t.SECURITY_ADMIN, "POST", "/v1/admin/org/pause", {
              reason: "suspected compromise",
            })
          ).status,
        ).toBe(200);
        const paused = await client.actions.execute(
          buy(authority, "rbac-nonce-000000000003"),
        );
        expect(paused).toMatchObject({ effectCount: 0 });
        expect(paused.status).not.toBe("COMPLETED");
        expect(provider.createCalls + provider.captureCalls).toBe(0);
        expect(
          (await call(t.SECURITY_ADMIN, "POST", "/v1/admin/org/resume")).status,
        ).toBe(200);
        // The security admin can also revoke the developer's credential, but not issue a new one.
        const list = (await (
          await call(t.SECURITY_ADMIN, "GET", "/v1/admin/credentials")
        ).json()) as { credentials: { credentialId: string }[] };
        expect(
          (
            await call(
              t.SECURITY_ADMIN,
              "POST",
              `/v1/admin/credentials/${list.credentials[0]!.credentialId}/revoke`,
            )
          ).status,
        ).toBe(200);
        expect(
          await client.actions.execute(
            buy(authority, "rbac-nonce-000000000004"),
          ),
        ).toMatchObject({
          status: "REJECTED",
          httpStatus: 401,
          effectCount: 0,
        });
      });
    });
  },
);
