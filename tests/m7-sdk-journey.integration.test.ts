import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parse } from "yaml";
import { createRequire } from "node:module";
import type Ajv2020Class from "ajv/dist/2020.js";
import type addFormatsFn from "ajv-formats";
import { PostgresTrustRepository } from "../src/persistence.js";
import { DelegatedCommerceService } from "../src/delegated-commerce.js";
import { FakeCommerceRanker } from "../src/commerce-discovery.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import type { Mandate } from "../src/domain.js";
import { StaticPublicKeyRing } from "../src/execution-grant.js";
import { ExecutingGateway } from "../src/network/gateway-execution.js";
import { createExecutingRestHandler } from "../src/network/rest-execution.js";
import { CredentialStore } from "../src/network/credentials.js";
import {
  createCredentialAdminHandler,
  staticAdminAuthenticator,
} from "../src/network/admin-rest.js";
import { ProofReader } from "../src/network/proof-read.js";
import { PostgresNetworkStore } from "../src/network/postgres-adapters.js";
import type { RestRequest, RestResponse } from "../src/network/rest.js";
import {
  PayFlowClient,
  type ExecuteResult,
} from "../packages/sdk-typescript/src/index.js";
import { VerticalSession } from "./m4-vertical-fixture.js";
import { checkoutAuthority, checkoutNow } from "./checkout-fixture.js";
import { discoveryOffer, discoveryQuery } from "./discovery-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const spec = parse(await readFile("openapi/payflow-v1.yaml", "utf8")) as {
  components: Record<string, unknown>;
};
const nodeRequire = createRequire(import.meta.url);
const Ajv2020 = (nodeRequire("ajv/dist/2020") as typeof Ajv2020Class).default;
const addFormats = (nodeRequire("ajv-formats") as typeof addFormatsFn).default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
function conforms(schema: string, body: unknown): void {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${schema}`,
    components: spec.components,
  });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

const ADMIN = "admin-test-secret-not-a-real-credential";
const ORG = "org-acme";
const heroMandate = (over: Partial<Mandate> = {}): Mandate => ({
  ...checkoutAuthority().mandate,
  maxSingleTransactionMinor: 10000,
  cumulativeLimitMinor: 10000,
  autonomousPurchaseThresholdMinor: 10000,
  humanApprovalThresholdMinor: 10000,
  ...over,
});

(url ? describe : describe.skip)(
  "M7 SDK → HTTP → ExecutingGateway → M6 execution path (PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository;
    let s: VerticalSession;
    let store: CredentialStore;
    let network: PostgresNetworkStore;
    let admin: (r: RestRequest) => Promise<RestResponse>;
    let exec: (r: RestRequest) => Promise<RestResponse>;
    let seq = 0;

    function shim(
      handler: (r: RestRequest) => Promise<RestResponse>,
    ): typeof fetch {
      return async (input, init) => {
        const u = new URL(input as URL);
        const h = new Headers(init?.headers);
        const reply = await handler({
          method: (init?.method ?? "GET") as "GET" | "POST",
          path: u.pathname,
          ...(h.get("authorization")
            ? { authorization: h.get("authorization")! }
            : {}),
          ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
        });
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: reply.headers,
        });
      };
    }
    const call = (
      path: string,
      body?: unknown,
      method: "GET" | "POST" = body === undefined ? "GET" : "POST",
      token = ADMIN,
    ) =>
      admin({
        method,
        path,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { body }),
      });
    async function issue(over: Record<string, unknown> = {}) {
      const res = await call("/v1/admin/credentials", {
        agentId: "commerce-a",
        scopes: ["action:request", "proof:read"],
        ttlSeconds: 3600,
        label: "test",
        ...over,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const b = res.body as {
        token: string;
        credential: { credentialId: string };
      };
      return {
        token: b.token,
        id: b.credential.credentialId,
        client: new PayFlowClient({
          baseUrl: "http://payflow.test",
          accessToken: b.token,
          fetch: shim(exec),
        }),
      };
    }
    const input = (over: Record<string, unknown> = {}) => ({
      authority: "commerce-m",
      agent: "commerce-a",
      item: discoveryQuery.text,
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
      nonce: `nonce-${String(++seq).padStart(16, "0")}`,
      ...over,
    });
    async function provision(over: Partial<Mandate> = {}) {
      const f = checkoutAuthority();
      const m = heroMandate(over);
      await repo.savePrincipal({ id: m.principalId, displayName: "Human" });
      await repo.saveAgent(f.agent);
      await repo.saveMandate(m);
      await s.checkout.registerMerchantBinding();
      await network.createOrganization(ORG, "Acme");
      await network.registerAgent(ORG, "SANDBOX", f.agent.id, m.principalId);
    }
    const dbEffects = async () => {
      const [r] = await repo.sql`select
        (select count(*) from authorization_reservations) reservations,
        (select count(*) from execution_grants) grants,
        (select count(*) from payment_attempts) attempts`;
      return Object.fromEntries(
        Object.entries(r!).map(([k, v]) => [k, Number(v)]),
      );
    };
    const providerCalls = () =>
      s.provider.createCalls + s.provider.captureCalls;
    async function expectZeroEffect(r: ExecuteResult, ...statuses: string[]) {
      expect(statuses).toContain(r.status);
      expect(r.effectCount).toBe(0);
      expect(providerCalls()).toBe(0);
      expect(await dbEffects()).toEqual({
        reservations: 0,
        grants: 0,
        attempts: 0,
      });
    }

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
      network = new PostgresNetworkStore(repo.sql);
      store = new CredentialStore(repo.sql);
    });
    afterAll(async () => repo?.close());
    function wire(session: VerticalSession) {
      const gateway = new ExecutingGateway({
        repo,
        delegated: new DelegatedCommerceService({
          discovery: session.discovery,
          checkout: session.checkout,
          authorizer: session.authorizer,
          issuer: session.issuer,
          boundary: session.boundary,
          merchantRisk: "LOW",
          clock: () => session.time,
        }),
        ranker: new FakeCommerceRanker(),
        now: () => session.time,
      });
      const proofs = new ProofReader(
        repo,
        new StaticPublicKeyRing(new Map([["m4f", session.keys.publicKey]])),
      );
      return createExecutingRestHandler(gateway, {
        authenticate: (a) => store.authenticate(a, session.time),
        readProof: (access, id) => proofs.read(access, id, session.time),
      });
    }
    beforeEach(async () => {
      await repo.sql`truncate replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      s = new VerticalSession(repo);
      s.provider.payer = false;
      admin = createCredentialAdminHandler(store, {
        authenticateAdmin: staticAdminAuthenticator({
          token: ADMIN,
          organizationId: ORG,
          environment: "SANDBOX",
        }),
        now: () => s.time,
      });
      exec = wire(s);
    });

    describe("credential lifecycle", () => {
      it("issues once, stores only a digest, never lists the secret, and revokes fail-closed", async () => {
        await provision();
        const { token, id, client } = await issue();
        expect(token).toMatch(/^pf_sbx_pfc_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/);
        const secret = token.split(".")[1]!;
        const [row] =
          await repo.sql`select * from agent_credentials where credential_id=${id}`;
        expect(JSON.stringify(row)).not.toContain(secret);
        expect(row!.secret_hash).toHaveLength(64);
        const listed = await call("/v1/admin/credentials");
        conforms("CredentialList", listed.body);
        expect(JSON.stringify(listed.body)).not.toContain(secret);
        expect(JSON.stringify(listed.body)).not.toContain(row!.secret_hash);
        expect(JSON.stringify(listed.body)).not.toContain("secret_hash");

        await provision2OK(client);
        expect(
          (await call(`/v1/admin/credentials/${id}/revoke`, {}, "POST")).status,
        ).toBe(200);
        // Revoked credential fails closed on the very next request.
        s.provider.createCalls = 0;
        const after = await client.actions.execute(input());
        expect(after.status).toBe("REJECTED");
        expect(after.effectCount).toBe(0);
      });
      async function provision2OK(client: PayFlowClient) {
        const r = await client.actions.execute(input());
        expect(r.status).toBe("COMPLETED");
      }

      it("requires administrative authentication and is tenant-bound", async () => {
        await provision();
        const bad = await call("/v1/admin/credentials", undefined, "GET", "x");
        expect(bad.status).toBe(401);
        const { id } = await issue();
        const otherTenant = createCredentialAdminHandler(store, {
          authenticateAdmin: staticAdminAuthenticator({
            token: "other-admin-secret",
            organizationId: "org-other",
            environment: "SANDBOX",
          }),
          now: () => s.time,
        });
        const r = await otherTenant({
          method: "POST",
          path: `/v1/admin/credentials/${id}/revoke`,
          authorization: "Bearer other-admin-secret",
          body: {},
        });
        expect(r.status).toBe(404);
        const [row] =
          await repo.sql`select status from agent_credentials where credential_id=${id}`;
        expect(row!.status).toBe("ACTIVE");
      });

      it("rejects unknown agents and extra fields at issue time", async () => {
        await provision();
        expect(
          (
            await call("/v1/admin/credentials", {
              agentId: "nobody",
              scopes: ["action:request"],
              ttlSeconds: 600,
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await call("/v1/admin/credentials", {
              agentId: "commerce-a",
              scopes: ["action:request"],
              ttlSeconds: 600,
              principalId: "someone-else",
            })
          ).status,
        ).toBe(400);
      });

      it("keeps the bearer token out of evidence and Proof", async () => {
        await provision();
        const { token, client } = await issue();
        const r = await client.actions.execute(input());
        expect(r.status).toBe("COMPLETED");
        const secret = token.split(".")[1]!;
        const [ev] =
          await repo.sql`select count(*)::int n from evidence_events where data::text like ${"%" + secret + "%"}`;
        expect(ev!.n).toBe(0);
        const proof = await client.proofs.get(r.proof!.proposalId!);
        expect(JSON.stringify(proof)).not.toContain(secret);
      });
    });

    describe("M7 acceptance through the exact execution path", () => {
      it("VALID: exactly one provider effect, a contract-conformant result and readable Proof", async () => {
        await provision();
        const { client } = await issue();
        const r = await client.actions.execute(input());
        expect(r).toMatchObject({
          status: "COMPLETED",
          decision: "ALLOW",
          effectCount: 1,
        });
        expect(s.provider.createCalls).toBe(1);
        expect(s.provider.captureCalls).toBe(1);
        expect(r.proof?.href).toBe(`/v1/proofs/${r.proof?.proposalId}`);
        expect(r.proof?.executionId).toBeTruthy();
        const raw = await exec({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: `Bearer ${(await issue()).token}`,
          body: {
            authority: "commerce-m",
            agentId: "commerce-a",
            action: "purchase",
            query: discoveryQuery,
            amount: { minor: 8400, currency: "USD" },
            merchant: { id: "payflow.demo.merchant" },
            nonce: "raw-nonce-0000000001",
          },
        });
        conforms("ExecuteOutcome", raw.body);
        // Proof links Principal → Agent → Authority → decision → reservation → grant → execution.
        const proof = (await client.proofs.get(r.proof!.proposalId!)) as {
          proof: {
            overall?: string;
            stages?: { stage: string; status: string }[];
          };
        };
        const stages = proof.proof.stages ?? [];
        expect(stages.length).toBeGreaterThan(3);
        expect(stages.some((x) => x.status === "INVALID")).toBe(false);
      });

      it("AMOUNT DRIFT: zero effect", async () => {
        await provision();
        const { client } = await issue();
        const r = await client.actions.execute(input({ amount: 5000 }));
        await expectZeroEffect(r, "DENIED");
        expect(r).toMatchObject({
          reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
          recoverable: true,
        });
      });

      it("MERCHANT DRIFT: zero effect", async () => {
        await provision();
        const { client } = await issue();
        await expectZeroEffect(
          await client.actions.execute(input({ merchant: "evil.merchant" })),
          "DENIED",
        );
      });

      it("PRICE DRIFT ($184 trusted vs $100 limit): zero effect", async () => {
        await provision();
        const catalog = demoCommerceCatalog();
        catalog.offers[0]!.unitPrice.minor = 18400;
        const drift = new VerticalSession(repo, [discoveryOffer()], catalog);
        drift.provider.payer = false;
        const { token } = await issue();
        const client = new PayFlowClient({
          baseUrl: "http://payflow.test",
          accessToken: token,
          fetch: shim(wire(drift)),
        });
        const r = await client.actions.execute(input());
        expect(r).toMatchObject({
          status: "DENIED",
          reason: "AMOUNT_EXCEEDS_AUTHORITY",
          effectCount: 0,
        });
        expect(drift.provider.createCalls + drift.provider.captureCalls).toBe(
          0,
        );
        expect((await dbEffects()).grants).toBe(0);
      });

      it("WRONG AGENT: a credential for another agent cannot act on this Authority", async () => {
        await provision();
        await repo.savePrincipal({ id: "p2", displayName: "Other" });
        await repo.saveAgent({
          ...checkoutAuthority().agent,
          id: "other-agent",
          principalId: "p2",
        });
        const { client } = await issue({ agentId: "other-agent" });
        const r = await client.actions.execute(input({ agent: "other-agent" }));
        await expectZeroEffect(r, "REJECTED");
        const spoof = await client.actions.execute(input());
        await expectZeroEffect(spoof, "REJECTED");
      });

      it("WRONG PRINCIPAL: an access object for the right agent but another principal is refused", async () => {
        await provision();
        const { token } = await issue();
        const forged = createExecutingRestHandler(
          new ExecutingGateway({
            repo,
            delegated: undefined as never,
            ranker: new FakeCommerceRanker(),
            now: () => s.time,
          }),
          {
            authenticate: async (a) => ({
              ...(await store.authenticate(a, s.time)),
              principalId: "someone-else",
            }),
          },
        );
        const res = await forged({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: `Bearer ${token}`,
          body: {
            authority: "commerce-m",
            agentId: "commerce-a",
            action: "purchase",
            query: discoveryQuery,
            amount: { minor: 8400, currency: "USD" },
            merchant: { id: "payflow.demo.merchant" },
            nonce: "forged-nonce-00000001",
          },
        });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          reason: "ACCESS_PRINCIPAL_MISMATCH",
          effectCount: 0,
        });
        conforms("ExecuteRejection", res.body);
        expect(providerCalls()).toBe(0);
        expect((await dbEffects()).reservations).toBe(0);
      });

      it("WRONG SCOPE: zero effect", async () => {
        await provision();
        const { client } = await issue({ scopes: ["proof:read"] });
        const r = await client.actions.execute(input());
        await expectZeroEffect(r, "REJECTED");
        expect(r).toMatchObject({ httpStatus: 403 });
      });

      it("WRONG AUDIENCE: zero effect", async () => {
        await provision();
        const { client } = await issue({ audience: "some-other-service" });
        await expectZeroEffect(
          await client.actions.execute(input()),
          "REJECTED",
        );
      });

      it("EXPIRED ACCESS CREDENTIAL: zero effect", async () => {
        await provision();
        const { client } = await issue({ ttlSeconds: 60 });
        const t0 = s.time;
        s.time = new Date(Date.parse(t0) + 120_000).toISOString();
        const r = await client.actions.execute(input());
        s.time = t0;
        await expectZeroEffect(r, "REJECTED");
        expect(r).toMatchObject({ httpStatus: 401 });
      });

      it("REVOKED ACCESS CREDENTIAL: zero effect", async () => {
        await provision();
        const { client, id } = await issue();
        await call(`/v1/admin/credentials/${id}/revoke`, {}, "POST");
        await expectZeroEffect(
          await client.actions.execute(input()),
          "REJECTED",
        );
      });

      it("REVOKED AUTHORITY: zero effect", async () => {
        await provision();
        const { client } = await issue();
        await repo.revokeMandate("commerce-m", checkoutNow);
        const r = await client.actions.execute(input());
        await expectZeroEffect(r, "DENIED");
        expect(r).toMatchObject({ reason: "AUTHORITY_REVOKED" });
      });

      it("SUSPENDED agent (control plane): the live credential stops working at once", async () => {
        await provision();
        const { client } = await issue();
        await network.transitionAgent(ORG, "SANDBOX", "commerce-a", "ACTIVE");
        await network.transitionAgent(
          ORG,
          "SANDBOX",
          "commerce-a",
          "SUSPENDED",
        );
        await expectZeroEffect(
          await client.actions.execute(input()),
          "REJECTED",
        );
      });

      it("SUSPENDED agent passport: the Trust Kernel refuses with zero effect", async () => {
        await provision();
        const { client } = await issue();
        await repo.sql`update agent_passports set status='SUSPENDED' where id='commerce-a'`;
        const r = await client.actions.execute(input());
        await expectZeroEffect(r, "DENIED");
        expect(r).toMatchObject({ reason: "AUTHORITY_UNAVAILABLE" });
      });

      it("EXPIRED AUTHORITY: zero effect", async () => {
        await provision({ expiresAt: "2026-10-10T00:00:00.000Z" });
        const { client } = await issue();
        await expectZeroEffect(await client.actions.execute(input()), "DENIED");
      });

      it("REPLAY: the same nonce never produces a second effect", async () => {
        await provision();
        const { client } = await issue();
        const once = input();
        expect((await client.actions.execute(once)).status).toBe("COMPLETED");
        const again = await client.actions.execute(once);
        expect(again).toMatchObject({
          status: "DENIED",
          reason: "REPLAY_DETECTED",
          effectCount: 0,
        });
        expect(s.provider.createCalls).toBe(1);
        expect(s.provider.captureCalls).toBe(1);
      });

      it("CONCURRENT OVERRUN: the Authority cannot be overspent", async () => {
        await provision();
        const { client } = await issue();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => client.actions.execute(input())),
        );
        expect(results.filter((r) => r.status === "COMPLETED")).toHaveLength(1);
        expect(s.provider.captureCalls).toBe(1);
        const [spent] =
          await repo.sql`select spent_minor::int spent from mandates where id='commerce-m'`;
        expect(spent!.spent).toBeLessThanOrEqual(10000);
      });

      it("MALFORMED / FIELD SMUGGLING: zero effect", async () => {
        await provision();
        const { token } = await issue();
        for (const extra of [
          { maxSingleTransactionMinor: 1e9 },
          { mandate: { id: "x" } },
          { merchantRisk: "LOW" },
          { approvedByHuman: true },
        ]) {
          const res = await exec({
            method: "POST",
            path: "/v1/actions/execute",
            authorization: `Bearer ${token}`,
            body: {
              authority: "commerce-m",
              agentId: "commerce-a",
              action: "purchase",
              query: discoveryQuery,
              amount: { minor: 8400, currency: "USD" },
              merchant: { id: "payflow.demo.merchant" },
              nonce: "smuggle-nonce-0000001",
              ...extra,
            },
          });
          expect(res.status).toBe(400);
          conforms("ExecuteRejection", res.body);
        }
        expect(providerCalls()).toBe(0);
        expect(await dbEffects()).toEqual({
          reservations: 0,
          grants: 0,
          attempts: 0,
        });
      });

      it("PROVIDER LOST RESPONSE: UNRESOLVED, effectCount null, no replacement execution", async () => {
        await provision();
        const { client, token } = await issue();
        s.provider.loseCapture = true;
        const r = await client.actions.execute(input());
        expect(r).toMatchObject({
          status: "UNRESOLVED",
          effectCount: null,
          doNotRetry: true,
        });
        const captures = s.provider.captureCalls;
        const creates = s.provider.createCalls;
        const second = await client.actions.execute(input());
        expect(second.status).not.toBe("COMPLETED");
        expect(s.provider.captureCalls).toBe(captures);
        expect(s.provider.createCalls).toBe(creates);
        // The wire body conforms to the UNRESOLVED schema (null, not 0).
        s.provider.loseCapture = false;
        const wire1 = await exec({
          method: "GET",
          path: `/v1/proofs/${r.proof!.proposalId}`,
          authorization: `Bearer ${token}`,
        });
        expect(wire1.status).toBe(200);
      });

      it("UNEXPECTED SERVER FAILURE is never reported as zero effect", async () => {
        await provision();
        const { token } = await issue();
        const exploding = createExecutingRestHandler(
          new ExecutingGateway({
            repo,
            delegated: {
              attempt: () => Promise.reject(new Error("boom")),
            },
            ranker: new FakeCommerceRanker(),
            now: () => s.time,
          }),
          { authenticate: (a) => store.authenticate(a, s.time) },
        );
        const res = await exploding({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: `Bearer ${token}`,
          body: {
            authority: "commerce-m",
            agentId: "commerce-a",
            action: "purchase",
            query: discoveryQuery,
            amount: { minor: 8400, currency: "USD" },
            merchant: { id: "payflow.demo.merchant" },
            nonce: "boom-nonce-000000001",
          },
        });
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ effectCount: null, doNotRetry: true });
        conforms("ExecuteUnknownFailure", res.body);
        const sdk = new PayFlowClient({
          baseUrl: "http://payflow.test",
          accessToken: token,
          fetch: shim(async () => res),
        });
        const r = await sdk.actions.execute(input());
        expect(r).toMatchObject({ status: "INDETERMINATE", effectCount: null });
      });

      it("TRANSPORT FAILURE after send is INDETERMINATE, never zero", async () => {
        const sdk = new PayFlowClient({
          baseUrl: "http://payflow.test",
          accessToken: "x",
          fetch: () => Promise.reject(new Error("socket hang up")),
        });
        const r = await sdk.actions.execute(input());
        expect(r).toMatchObject({
          status: "INDETERMINATE",
          effectCount: null,
          doNotRetry: true,
        });
      });

      it("PROOF is not readable by another agent or without the proof:read scope", async () => {
        await provision();
        const { client } = await issue();
        const r = await client.actions.execute(input());
        const noScope = await issue({ scopes: ["action:request"] });
        const denied = await exec({
          method: "GET",
          path: `/v1/proofs/${r.proof!.proposalId}`,
          authorization: `Bearer ${noScope.token}`,
        });
        expect(denied.status).toBe(403);
        await repo.savePrincipal({ id: "p3", displayName: "P3" });
        await repo.saveAgent({
          ...checkoutAuthority().agent,
          id: "agent-3",
          principalId: "p3",
        });
        const stranger = await issue({
          agentId: "agent-3",
          scopes: ["proof:read"],
        });
        const hidden = await exec({
          method: "GET",
          path: `/v1/proofs/${r.proof!.proposalId}`,
          authorization: `Bearer ${stranger.token}`,
        });
        expect(hidden.status).toBe(404);
      });
    });
  },
);
