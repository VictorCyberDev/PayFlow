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
import {
  PayFlowAgentDelegationClient,
  PayFlowMemberClient,
} from "../packages/sdk-typescript/src/member.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M18 tenant-facing delegation API against the real host: PostgreSQL, real HTTP, real agent credentials and the real A2A
 * interface. Every delegation is derived from a STORED Authority; nothing here lets a child widen a parent.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m18api-host-private-bootstrap-".repeat(3);
const adminToken = "m18api-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const MERCHANT = "payflow.demo.merchant";

(url ? describe : describe.skip)(
  "M18 tenant delegation API (PostgreSQL + real HTTP)",
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
    const owners = new Map<string, string>();
    let n = 0;
    let msg = 0;
    const key = () => `m18api-idem-key-${String(++n).padStart(8, "0")}`;

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const f of (await readdir("db/migrations"))
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + f, "utf8"));
      server = createServer((req, res) => {
        if (!host) return void res.writeHead(502).end();
        void host.handler(req, res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    beforeEach(async () => {
      owners.clear();
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,delegations",
      );
      provider = new VerticalProvider();
      provider.payer = false;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      for (const id of ["a", "b", "c"])
        await repo.saveAgent({
          id,
          principalId: "p",
          displayName: `Agent ${id}`,
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities,
        });
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
        }),
        { clock, paymentProvider: provider },
      );
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

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
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ownerOf = async (organizationId: string) => {
      const cached = owners.get(organizationId);
      if (cached) return cached;
      await repo.sql`insert into organizations (id, display_name) values (${organizationId}, 'T') on conflict (id) do nothing`;
      const r = await call(adminToken, "POST", "/v1/admin/members", {
        organizationId,
        environment: "SANDBOX",
        displayName: "owner",
        role: "OWNER",
      });
      const token = ((await r.json()) as { token: string }).token;
      owners.set(organizationId, token);
      return token;
    };
    const member = async (role: string, organizationId = "payflow-sandbox") => {
      const ownerToken = await ownerOf(organizationId);
      if (role === "OWNER") return ownerToken;
      const r = await call(ownerToken, "POST", "/v1/admin/members", {
        displayName: `m18 ${role}`,
        role,
      });
      const body = (await r.json()) as { token?: string };
      if (!body.token) throw new Error(`member ${role}: ${r.status}`);
      return body.token;
    };
    async function authority() {
      const r = await call(
        adminToken,
        "POST",
        "/v1/admin/sandbox/authority",
        {},
      );
      return ((await r.json()) as { authority: { id: string } }).authority.id;
    }
    /** An organization agent and its own credential, issued by the owner. */
    async function agent(id: string) {
      await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
        values ('payflow-sandbox', ${id}, 'SANDBOX', 'p') on conflict do nothing`;
      const r = await call(
        await member("OWNER"),
        "POST",
        "/v1/admin/credentials",
        {
          agentId: id,
          scopes: ["action:request", "proof:read"],
          ttlSeconds: 3600,
        },
      );
      const body = (await r.json()) as { token?: string };
      if (!body.token) throw new Error(`credential ${id}: ${r.status}`);
      return body.token;
    }
    const rootOf = (
      auth: string,
      token: string,
      over: Record<string, unknown> = {},
    ) =>
      call(token, "POST", `/v1/admin/org/authorities/${auth}/delegations`, {
        childAgentId: "b",
        budgetMinor: 10_000,
        idempotencyKey: key(),
        ...over,
      });
    const hopOf = (
      id: string,
      token: string,
      over: Record<string, unknown> = {},
    ) =>
      call(token, "POST", `/v1/admin/org/delegations/${id}/hops`, {
        childAgentId: "a",
        idempotencyKey: key(),
        ...over,
      });
    const agentHop = (
      id: string,
      token: string,
      over: Record<string, unknown> = {},
    ) =>
      call(token, "POST", `/v1/agent/delegations/${id}/hops`, {
        childAgentId: "a",
        idempotencyKey: key(),
        ...over,
      });
    type View = {
      delegationId: string;
      authorityId: string;
      status: string;
      depth: number;
      lineage: { delegationId: string }[];
      own: {
        maxAmountMinor: number;
        spentMinor: number;
        currencies: string[];
        actionKinds: string[];
        counterpartyIds: string[];
      };
      effective: {
        remainingBudgetMinor: number;
        perActionMaxMinor: number;
        currencies: string[];
      };
    };
    const created = async (r: Response) => {
      const body = (await r.json()) as {
        delegationId: string;
        delegation: View;
      };
      expect(r.status).toBe(201);
      return body;
    };
    const purchase = (auth: string, over: Record<string, unknown> = {}) => ({
      authority: auth,
      agentId: "a",
      action: "purchase",
      query: { text: "Quiet keyboard", quantity: 1 },
      amount: { minor: 8400, currency: "USD" },
      merchant: { id: MERCHANT },
      nonce: `m18api-nonce-${String(++n).padStart(12, "0")}`,
      ...over,
    });
    const send = (
      token: string,
      args: Record<string, unknown>,
      delegationId: string,
    ) =>
      fetch(`${origin}/v1/a2a/message:send`, {
        method: "POST",
        headers: {
          "content-type": "application/a2a+json",
          "A2A-Version": "1.0",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: {
            messageId: `m18api-msg-${String(++msg).padStart(6, "0")}`,
            role: "ROLE_USER",
            parts: [
              {
                data: {
                  tool: "request_authorized_action",
                  arguments: args,
                  delegation: { delegationId },
                },
              },
            ],
          },
        }),
      });

    it("creates a root from the STORED Authority: scope, currency and merchants come from storage, and the view shows lineage and effective permissions", async () => {
      const auth = await authority();
      await agent("b");
      const r = await created(await rootOf(auth, await member("OWNER")));
      expect(r.delegation).toMatchObject({
        authorityId: auth,
        depth: 0,
        status: "ACTIVE",
        own: {
          maxAmountMinor: 10_000,
          spentMinor: 0,
          currencies: ["USD"],
          actionKinds: ["PURCHASE"],
          counterpartyIds: [MERCHANT],
        },
        effective: { remainingBudgetMinor: 10_000, currencies: ["USD"] },
      });
      expect(r.delegation.lineage).toHaveLength(1);
      const got = await call(
        await member("AUDITOR"),
        "GET",
        `/v1/admin/org/delegations/${r.delegationId}`,
      );
      expect(got.status).toBe(200);
      const list = (await (
        await call(
          await member("AUDITOR"),
          "GET",
          `/v1/admin/org/authorities/${auth}/delegations`,
        )
      ).json()) as { delegations: View[] };
      expect(list.delegations.map((d) => d.delegationId)).toEqual([
        r.delegationId,
      ]);
    });

    it("refuses every attempt to widen a stored Authority at the root", async () => {
      const auth = await authority();
      const t = await member("OWNER");
      const refused = async (over: Record<string, unknown>) => {
        const r = await rootOf(auth, t, over);
        return { status: r.status, body: JSON.stringify(await r.json()) };
      };
      expect(await refused({ budgetMinor: 10_001 })).toMatchObject({
        status: 403,
        body: expect.stringContaining("BUDGET_ABOVE_AUTHORITY") as string,
      });
      expect(
        await refused({ counterpartyIds: ["evil.example"] }),
      ).toMatchObject({
        status: 403,
        body: expect.stringContaining(
          "COUNTERPARTY_NOT_IN_AUTHORITY",
        ) as string,
      });
      // Currency, action kind, audience or amount cannot be supplied at all.
      for (const extra of [
        { currencies: ["EUR"] },
        { actionKinds: ["TRANSFER"] },
        { maxAmountMinor: 99_999_999 },
        { audience: "x" },
      ])
        expect((await refused(extra)).status).toBe(400);
      expect(await refused({ childAgentId: "ghost" })).toMatchObject({
        status: 403,
        body: expect.stringContaining("AGENT_NOT_IN_ORGANIZATION") as string,
      });
      expect(await refused({ budgetMinor: 0 })).toMatchObject({ status: 400 });
      const missing = await rootOf("no-such-authority", t);
      expect(missing.status).toBe(404);
      const count = await repo.sql`select count(*)::int n from delegations`;
      expect(count[0]!.n).toBe(0);
    });

    it("an agent can only narrow: every widening hop is refused and nothing is stored", async () => {
      const auth = await authority();
      const t = await member("OWNER");
      await agent("a");
      const bToken = await agent("b");
      const root = await created(await rootOf(auth, t, { budgetMinor: 6_000 }));
      const bad = async (over: Record<string, unknown>) => {
        const r = await agentHop(root.delegationId, bToken, over);
        return { status: r.status, body: JSON.stringify(await r.json()) };
      };
      expect(await bad({ maxAmountMinor: 6_001 })).toMatchObject({
        status: 403,
      });
      expect(await bad({ currencies: ["EUR"] })).toMatchObject({ status: 403 });
      expect(await bad({ counterpartyIds: ["evil.example"] })).toMatchObject({
        status: 403,
      });
      expect([400, 403]).toContain(
        (await bad({ actionKinds: ["TRANSFER"] })).status,
      );
      expect((await bad({ audience: "other" })).status).toBe(400);
      const rows = await repo.sql`select count(*)::int n from delegations`;
      expect(rows[0]!.n).toBe(1);
      const ok = await created(
        await agentHop(root.delegationId, bToken, { maxAmountMinor: 4_000 }),
      );
      expect(ok.delegation).toMatchObject({
        depth: 1,
        authorityId: auth,
        effective: { perActionMaxMinor: 4_000 },
      });
      expect(ok.delegation.lineage.map((l) => l.delegationId)).toEqual([
        root.delegationId,
        ok.delegationId,
      ]);
    });

    it("only the agent that holds a delegation may extend it; a member acts for the tenant", async () => {
      const auth = await authority();
      const t = await member("OWNER");
      await agent("b");
      const aToken = await agent("a");
      const root = await created(await rootOf(auth, t));
      // "a" is not the holder (b is).
      const stolen = await agentHop(root.delegationId, aToken, {
        childAgentId: "c",
      });
      expect(stolen.status).toBe(403);
      expect(JSON.stringify(await stolen.json())).toContain(
        "NOT_THE_DELEGATING_AGENT",
      );
      expect((await agentHop(root.delegationId, "pf_bogus")).status).toBe(401);
      expect(
        (await hopOf(root.delegationId, t, { maxAmountMinor: 3_000 })).status,
      ).toBe(201);
    });

    it("is idempotent: the same key replays, a different body under the same key is refused, and concurrent duplicates make one delegation", async () => {
      const auth = await authority();
      await agent("b");
      const t = await member("OWNER");
      const idem = key();
      const first = await created(
        await rootOf(auth, t, { idempotencyKey: idem }),
      );
      const replay = await rootOf(auth, t, { idempotencyKey: idem });
      expect(replay.status).toBe(200);
      expect(
        ((await replay.json()) as { delegationId: string }).delegationId,
      ).toBe(first.delegationId);
      const changed = await rootOf(auth, t, {
        idempotencyKey: idem,
        budgetMinor: 9_000,
      });
      expect(changed.status).toBe(409);
      const dup = key();
      const all = await Promise.all(
        Array.from({ length: 8 }, () =>
          rootOf(auth, t, { idempotencyKey: dup }),
        ),
      );
      const ids = new Set(
        await Promise.all(
          all.map(
            async (r) =>
              ((await r.json()) as { delegationId: string }).delegationId,
          ),
        ),
      );
      expect(ids.size).toBe(1);
      const rows = await repo.sql`select count(*)::int n from delegations`;
      expect(rows[0]!.n).toBe(2);
    });

    it("conserves a shared budget through real delegated purchases: two concurrent spends cannot both succeed", async () => {
      const auth = await authority();
      const t = await member("OWNER");
      await agent("b");
      const aToken = await agent("a");
      const root = await created(
        await rootOf(auth, t, { budgetMinor: 10_000 }),
      );
      const leaf = await created(
        await hopOf(root.delegationId, t, { maxAmountMinor: 9_000 }),
      );
      const results = await Promise.all([
        send(aToken, { action: purchase(auth) }, leaf.delegationId),
        send(aToken, { action: purchase(auth) }, leaf.delegationId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(provider.captureCalls).toBe(1);
      const view = (await (
        await call(t, "GET", `/v1/admin/org/delegations/${leaf.delegationId}`)
      ).json()) as { delegation: View };
      expect(view.delegation.effective.remainingBudgetMinor).toBe(600);
      const rootView = (await (
        await call(t, "GET", `/v1/admin/org/delegations/${root.delegationId}`)
      ).json()) as { delegation: View };
      expect(rootView.delegation.own.spentMinor).toBe(8_400);
    });

    it("a delegation is bound to its Authority: another stored Authority is refused before anything is reserved", async () => {
      const first = await authority();
      const second = await authority();
      expect(second).not.toBe(first);
      const t = await member("OWNER");
      await agent("b");
      const aToken = await agent("a");
      const root = await created(await rootOf(first, t));
      const leaf = await created(await hopOf(root.delegationId, t));
      const r = await send(
        aToken,
        { action: purchase(second) },
        leaf.delegationId,
      );
      expect(r.status).toBe(403);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      const v = (await (
        await call(t, "GET", `/v1/admin/org/delegations/${root.delegationId}`)
      ).json()) as { delegation: View };
      expect(v.delegation.own.spentMinor).toBe(0);
    });

    it("revocation takes the whole subtree out of service and is audited", async () => {
      const auth = await authority();
      const t = await member("OWNER");
      await agent("b");
      const aToken = await agent("a");
      const root = await created(await rootOf(auth, t));
      const leaf = await created(await hopOf(root.delegationId, t));
      const done = await call(
        await member("SECURITY_ADMIN"),
        "POST",
        `/v1/admin/org/delegations/${root.delegationId}/revoke`,
        { reason: "compromised" },
      );
      expect(done.status).toBe(200);
      const again = (await (
        await call(
          t,
          "POST",
          `/v1/admin/org/delegations/${root.delegationId}/revoke`,
          {},
        )
      ).json()) as { alreadyRevoked: boolean };
      expect(again.alreadyRevoked).toBe(true);
      const v = (await (
        await call(t, "GET", `/v1/admin/org/delegations/${leaf.delegationId}`)
      ).json()) as { delegation: View };
      expect(v.delegation.status).toBe("ANCESTOR_REVOKED");
      expect(
        (await send(aToken, { action: purchase(auth) }, leaf.delegationId))
          .status,
      ).toBe(403);
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      const audit =
        await repo.sql`select action from organization_audit_events where subject_kind = 'DELEGATION' order by sequence`;
      const actions = audit.map((a) => String(a.action));
      expect(actions).toContain("DELEGATION_ROOT_CREATED");
      expect(actions).toContain("DELEGATION_HOP_CREATED");
      expect(actions.filter((a) => a === "DELEGATION_REVOKED")).toHaveLength(1);
    });

    it("enforces roles on the server: DEVELOPER, APPROVER, VIEWER and AUDITOR cannot create; SECURITY_ADMIN can only revoke", async () => {
      const auth = await authority();
      await agent("b");
      for (const role of [
        "DEVELOPER",
        "APPROVER",
        "VIEWER",
        "AUDITOR",
        "SECURITY_ADMIN",
      ])
        expect((await rootOf(auth, await member(role))).status).toBe(403);
      expect((await rootOf(auth, await member("FINANCE_ADMIN"))).status).toBe(
        201,
      );
      const root = (
        (await (
          await call(
            await member("OWNER"),
            "GET",
            `/v1/admin/org/authorities/${auth}/delegations`,
          )
        ).json()) as { delegations: View[] }
      ).delegations[0]!;
      expect(
        (
          await call(
            await member("DEVELOPER"),
            "POST",
            `/v1/admin/org/delegations/${root.delegationId}/revoke`,
            {},
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            await member("DEVELOPER"),
            "GET",
            `/v1/admin/org/delegations/${root.delegationId}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            null,
            "GET",
            `/v1/admin/org/delegations/${root.delegationId}`,
          )
        ).status,
      ).toBe(401);
    });

    it("is tenant isolated: another organization sees, extends and revokes nothing, and cannot root a chain in this Authority", async () => {
      const auth = await authority();
      await agent("b");
      const root = await created(await rootOf(auth, await member("OWNER")));
      const theirs = await member("OWNER", "org-other");
      expect(
        (
          await call(
            theirs,
            "GET",
            `/v1/admin/org/delegations/${root.delegationId}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call(
            theirs,
            "POST",
            `/v1/admin/org/delegations/${root.delegationId}/revoke`,
            {},
          )
        ).status,
      ).toBe(404);
      expect((await hopOf(root.delegationId, theirs)).status).toBe(404);
      expect((await rootOf(auth, theirs)).status).toBe(404);
      const list = (await (
        await call(
          theirs,
          "GET",
          `/v1/admin/org/authorities/${auth}/delegations`,
        )
      ).json()) as { delegations: unknown[] };
      expect(list.delegations).toEqual([]);
      const still = (await (
        await call(
          await member("OWNER"),
          "GET",
          `/v1/admin/org/delegations/${root.delegationId}`,
        )
      ).json()) as { delegation: View };
      expect(still.delegation.status).toBe("ACTIVE");
    });

    it("is environment isolated: a PRODUCTION member of the same organization cannot see or revoke a SANDBOX delegation", async () => {
      const auth = await authority();
      await agent("b");
      const root = await created(await rootOf(auth, await member("OWNER")));
      await ownerOf("payflow-sandbox");
      const r = await call(adminToken, "POST", "/v1/admin/members", {
        organizationId: "payflow-sandbox",
        environment: "PRODUCTION",
        displayName: "prod owner",
        role: "OWNER",
      });
      const prod = ((await r.json()) as { token: string }).token;
      expect(
        (
          await call(
            prod,
            "GET",
            `/v1/admin/org/delegations/${root.delegationId}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call(
            prod,
            "POST",
            `/v1/admin/org/delegations/${root.delegationId}/revoke`,
            {},
          )
        ).status,
      ).toBe(404);
    });

    it("the SDK clients complete the real workflow: member roots, holding agent narrows, both inspect, member revokes", async () => {
      const auth = await authority();
      const bToken = await agent("b");
      await agent("a");
      const members = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await member("FINANCE_ADMIN"),
      });
      const agentB = new PayFlowAgentDelegationClient({
        baseUrl: origin,
        agentToken: bToken,
      });
      const root = await members.delegations.createRoot(auth, {
        childAgentId: "b",
        budgetMinor: 7_000,
        idempotencyKey: key(),
      });
      if (!root.ok) throw new Error(root.reason);
      const widen = await agentB.delegate(root.delegationId, {
        childAgentId: "a",
        maxAmountMinor: 7_001,
        idempotencyKey: key(),
      });
      expect(widen).toMatchObject({ ok: false, httpStatus: 403 });
      const hop = await agentB.delegate(root.delegationId, {
        childAgentId: "a",
        maxAmountMinor: 5_000,
        idempotencyKey: key(),
      });
      if (!hop.ok) throw new Error(hop.reason);
      expect(hop.delegation.effective).toMatchObject({
        perActionMaxMinor: 5_000,
        remainingBudgetMinor: 5_000,
      });
      expect((await agentB.inspect(hop.delegationId))?.depth).toBe(1);
      expect((await members.delegations.list(auth)).length).toBe(2);
      expect(
        await members.delegations.revoke(root.delegationId, "done"),
      ).toEqual({
        found: true,
        alreadyRevoked: false,
      });
      expect(
        (await members.delegations.inspect(hop.delegationId))?.status,
      ).toBe("ANCESTOR_REVOKED");
    });

    it("a revoked Authority cannot be delegated from", async () => {
      const auth = await authority();
      await agent("b");
      await repo.sql`update mandates set revoked_at = now() where id = ${auth}`;
      const r = await rootOf(auth, await member("OWNER"));
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).toContain("AUTHORITY_REVOKED");
    });

    it("never leaks credentials or key material in any delegation response", async () => {
      const auth = await authority();
      await agent("b");
      const t = await member("OWNER");
      const r = await rootOf(auth, t);
      const text = JSON.stringify(await r.json());
      for (const secret of [t, adminToken, bootstrap, "PRIVATE KEY"])
        expect(text).not.toContain(secret);
    });
  },
);
