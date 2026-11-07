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
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import {
  holderJwk,
  present,
  type Credential,
  type IssuerTrust,
} from "../packages/verifier/src/authority.js";
import {
  selectKey,
  verifyPortableProof,
} from "../packages/verifier/src/index.js";
import {
  IssuerDirectoryClient,
  thumbprint,
} from "../packages/directory-client/src/index.js";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { PayFlowMemberClient } from "../packages/sdk-typescript/src/member.js";
import {
  hostedProofVerifier,
  MerchantVerifier,
  type MerchantOrder,
} from "../packages/merchant-sdk/src/verifier.js";
import {
  PostgresChallengeStore,
  PostgresNonceStore,
  PostgresProofLedger,
} from "../packages/merchant-sdk/src/postgres-stores.js";
import { SigningKeyRegistry } from "../src/network/signing-keys.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * Phase B: the whole developer journey through the supported APIs and SDKs only, against the real host (PostgreSQL, real
 * HTTP), with the issuer, the agent, the merchant and the independent verifier each acting on their own:
 *
 *   stored Gateway Authority → signed portable credential → issuer directory (pinned, fetched) → merchant challenge →
 *   agent presentation → merchant verification → governed payment (reservation, one-time grant, simulated rail) →
 *   portable Proof → hosted Verify and offline verification.
 *
 * Followed by the failure matrix. "Simulated rail" means a deterministic provider double; no real money moves.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "phb-host-private-bootstrap-".repeat(3);
const adminToken = "phb-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const rootPair = generateKeyPairSync("ed25519");
const pemOf = (p: { privateKey: KeyObject }) =>
  p.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const AUD = "https://shop.example";
const MERCHANT = "payflow.demo.merchant";

(url ? describe : describe.skip)(
  "Phase B developer journey and failure matrix (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    let nowMs = Date.parse("2026-10-23T10:00:00.000Z");
    const clock = () => new Date(nowMs);
    const iso = (ms: number) => new Date(ms).toISOString();
    const pools: ReturnType<typeof postgres>[] = [];
    const owner = ownerFactory(
      () => origin,
      () => repo.sql,
      adminToken,
    );
    const owners = new Map<string, string>();
    let n = 0;
    const holder = generateKeyPairSync("ed25519");

    const startHost = (over: Record<string, string> = {}) => {
      host = createHostedConsole(
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: origin,
          PAYFLOW_M6_DEMO_AGENT: "true",
          PAYFLOW_M6_SIGNING_KEY: pemOf(rootPair),
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
      nowMs = Date.parse("2026-10-23T10:00:00.000Z");
      owners.clear();
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,proof_signing_keys,issuer_directory_publications,portable_credentials,delegations,merchant_challenges,merchant_nonces,merchant_proof_claims",
      );
      provider = new VerticalProvider();
      provider.payer = false;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      for (const id of ["a", "b"])
        await repo.saveAgent({
          id,
          principalId: "p",
          displayName: `Agent ${id}`,
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
      await Promise.all(pools.splice(0).map((p) => p.end({ timeout: 1 })));
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    // ----------------------------------------------------------------------------------------------- the actors
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
    const ownerOf = async (organizationId = "payflow-sandbox") => {
      const cached = owners.get(organizationId);
      if (cached) return cached;
      await repo.sql`insert into organizations (id, display_name) values (${organizationId}, 'T') on conflict (id) do nothing`;
      const r = await call(adminToken, "POST", "/v1/admin/members", {
        organizationId,
        environment: "SANDBOX",
        displayName: "owner",
        role: "OWNER",
      });
      const t = ((await r.json()) as { token: string }).token;
      owners.set(organizationId, t);
      return t;
    };
    const trust = (issuer: string): IssuerTrust => ({
      issuer,
      status: "TRUSTED",
      maxDelegationDepth: 2,
      allowedActionKinds: ["PURCHASE"],
      allowedCurrencies: ["USD"],
      maxAmountMinor: 1_000_000,
    });
    /** The merchant trusts one issuer by an out-of-band pin; everything else it fetches over HTTP. */
    const directory = () =>
      new IssuerDirectoryClient({
        issuers: {
          [origin]: {
            directoryUrl: `${origin}/v1/issuer/directory`,
            pins: [thumbprint(holderJwk(rootPair.publicKey))],
            allowInsecureLoopback: true,
          },
        },
        now: () => iso(nowMs),
      });
    async function learn(client: IssuerDirectoryClient) {
      expect(["ACCEPTED", "UNCHANGED"]).toContain(await client.refresh(origin));
      await client.refreshStatus(origin);
    }
    /** One merchant instance with its own connection pool; all share the merchant database. */
    function merchantInstance(
      client: IssuerDirectoryClient,
      namespace = MERCHANT,
    ) {
      const sql = postgres(url!, { max: 4, onnotice: () => undefined });
      pools.push(sql);
      return {
        sql,
        merchant: new MerchantVerifier({
          audience: AUD,
          now: () => iso(nowMs),
          env: { ...client.environment(), trust: () => trust(origin) },
          proofVerifier: hostedProofVerifier(origin),
          challenges: new PostgresChallengeStore(sql, namespace),
          claimNonce: new PostgresNonceStore(sql, namespace, () => nowMs).claim,
          proofLedger: new PostgresProofLedger(sql, namespace),
        }),
      };
    }
    const orderOf = (over: Partial<MerchantOrder> = {}): MerchantOrder => ({
      orderId: "order-1",
      amountMinor: 8_400,
      currency: "USD",
      merchantId: MERCHANT,
      ...over,
    });
    async function authority() {
      const r = await call(
        adminToken,
        "POST",
        "/v1/admin/sandbox/authority",
        {},
      );
      return ((await r.json()) as { authority: { id: string } }).authority.id;
    }
    async function issue(
      authorityId: string,
      over: { maxAmountMinor?: number; ttlSeconds?: number } = {},
    ) {
      const members = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await ownerOf(),
      });
      const r = await members.credentials.issue(authorityId, {
        holder: holderJwk(holder.publicKey) as {
          kty: "OKP";
          crv: "Ed25519";
          x: string;
        },
        idempotencyKey: `phb-idem-key-${String(++n).padStart(8, "0")}`,
        ...over,
      });
      if (!r.ok) throw new Error(`issue: ${r.reason}`);
      return { ...r, members };
    }
    /** The agent's own Gateway credential: how it pays. Separate from the portable credential it shows merchants. */
    async function agentClient(agentId = "a") {
      await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
        values ('payflow-sandbox', ${agentId}, 'SANDBOX', 'p') on conflict do nothing`;
      const r = await call(await ownerOf(), "POST", "/v1/admin/credentials", {
        agentId,
        scopes: ["action:request", "proof:read"],
        ttlSeconds: 3600,
      });
      const token = ((await r.json()) as { token: string }).token;
      return {
        token,
        client: new PayFlowClient({ baseUrl: origin, accessToken: token }),
      };
    }
    const show = (
      credential: Credential,
      challenge: string,
      key: KeyObject = holder.privateKey,
    ) =>
      present(credential, key, {
        aud: AUD,
        challenge,
        nonce: `n-${Math.random().toString(36).slice(2)}-0123456789`,
        iat: iso(nowMs),
        exp: iso(nowMs + 120_000),
      });
    async function pay(
      client: PayFlowClient,
      auth: string,
      over: {
        nonce?: string;
        amount?: number;
        agent?: string;
        merchant?: string;
      } = {},
    ) {
      return client.actions.execute({
        item: "Quiet keyboard",
        amount: over.amount ?? 8_400,
        currency: "USD",
        merchant: over.merchant ?? MERCHANT,
        nonce: over.nonce ?? `phb-nonce-${String(++n).padStart(12, "0")}`,
        authority: auth,
        agent: over.agent ?? "a",
      });
    }
    async function portableProof(token: string, proposalId: string) {
      const r = await call(token, "GET", `/v1/proofs/${proposalId}/portable`);
      return (
        ((await r.json()) as { proof?: Record<string, unknown> }).proof ?? {}
      );
    }
    const reasons = (
      v: { valid: boolean } & { reasons?: readonly string[] },
    ) => (v.valid ? [] : (v.reasons ?? []));

    // ------------------------------------------------------------------------------------------- the journey
    it("runs the whole journey: stored Authority → credential → directory → challenge → presentation → payment → Proof → independent verification", async () => {
      // 1. A stored Authority exists in the database, owned by this tenant.
      const auth = await authority();
      const [mandate] =
        await repo.sql`select id, revoked_at from mandates where id = ${auth}`;
      expect(mandate).toMatchObject({ id: auth, revoked_at: null });
      // 2. The member issues a signed portable credential FROM that stored Authority.
      const issued = await issue(auth);
      expect(issued.authorityId).toBe(auth);
      // 3. The merchant learns the issuer's keys and revocations by fetching, pinned to one thumbprint.
      const dir = directory();
      await learn(dir);
      let shop = merchantInstance(dir);
      // 4. Challenge → 5. presentation → 6. merchant verification. The merchant restarts in between (new pool).
      const { challenge } = await shop.merchant.issue(orderOf());
      await shop.sql.end({ timeout: 1 });
      shop = merchantInstance(dir);
      const verified = await shop.merchant.verifyAgent(
        show(issued.credential, challenge),
        orderOf(),
      );
      expect(verified.valid).toBe(true);
      expect(shop.merchant.gateMark(verified, orderOf())).not.toBeNull();
      // 7. The authorized economic action: reservation, one-time grant, simulated effect, through the agent's own credential.
      const agent = await agentClient();
      const paid = await pay(agent.client, auth);
      expect(paid).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(1);
      // 8. The portable Proof, verified by the merchant through hosted Verify and tied to the order once...
      expect(paid.proof?.proposalId).toBeTruthy();
      const proof = await portableProof(
        agent.token,
        paid.proof?.proposalId ?? "",
      );
      expect(
        await shop.merchant.associateProof(proof, orderOf()),
      ).toMatchObject({
        verdict: "FULFIL",
        reason: "PAID_ONCE_MATCHES_ORDER",
      });
      // ...and verified OFFLINE by anyone holding only the public key document (no PayFlow call, no payment ability).
      const keys = (await (await fetch(`${origin}/v1/keys`)).json()) as unknown;
      const jwk = selectKey(keys, String((proof as { keyId?: string }).keyId));
      expect(jwk).not.toBeNull();
      expect(verifyPortableProof(proof, jwk!, iso(nowMs), null)).toMatchObject({
        valid: true,
        reason: "PROOF_VALID",
      });
      // The Authority's own audit trail and the stored credential agree with what happened.
      const [issuedRow] =
        await repo.sql`select authority_id, revoked_at from portable_credentials`;
      expect(issuedRow).toMatchObject({ authority_id: auth, revoked_at: null });
    });

    // ------------------------------------------------------------------------------------- failure matrix
    /** A prepared world: stored Authority, credential, a merchant that has learned the issuer, and the agent's client. */
    async function world(
      issueOver: { maxAmountMinor?: number; ttlSeconds?: number } = {},
    ) {
      const auth = await authority();
      const issued = await issue(auth, issueOver);
      const dir = directory();
      await learn(dir);
      const shop = merchantInstance(dir);
      const agent = await agentClient();
      return { auth, issued, dir, shop, agent };
    }
    const verify = async (
      w: Awaited<ReturnType<typeof world>>,
      order: MerchantOrder,
      key?: KeyObject,
      credential?: Credential,
    ) => {
      const { challenge } = await w.shop.merchant.issue(order);
      return w.shop.merchant.verifyAgent(
        show(credential ?? w.issued.credential, challenge, key),
        order,
      );
    };
    /** The Gateway answers a refusal as data (DENIED, $0) or as an HTTP error; either way it is captured, never thrown. */
    const settle = async (run: Promise<unknown>) => {
      try {
        const r = (await run) as Record<string, unknown>;
        return r;
      } catch (e) {
        return { thrown: (e as Error).message };
      }
    };
    const noEffect = () =>
      expect(provider.createCalls + provider.captureCalls).toBe(0);

    it("out-of-scope amount: the merchant refuses beyond the credential, and the Gateway refuses beyond the Authority; nothing moves", async () => {
      const w = await world({ maxAmountMinor: 5_000 });
      const v = await verify(w, orderOf({ amountMinor: 8_400 }));
      expect(reasons(v)).toEqual(["ACTION_NOT_IN_SCOPE"]);
      const tooBig = await settle(
        pay(w.agent.client, w.auth, {
          amount: 100_000_000,
        }),
      );
      expect(tooBig).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
      });
      noEffect();
    });

    it("wrong merchant and wrong currency: refused by the credential's own scope", async () => {
      const w = await world();
      expect(
        reasons(await verify(w, orderOf({ merchantId: "other.merchant" }))),
      ).toEqual(["ACTION_NOT_IN_SCOPE"]);
      expect(reasons(await verify(w, orderOf({ currency: "EUR" })))).toEqual([
        "ACTION_NOT_IN_SCOPE",
      ]);
      const wrongMerchant = await settle(
        pay(w.agent.client, w.auth, {
          merchant: "other.merchant",
        }),
      );
      expect(wrongMerchant).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
      });
      noEffect();
    });

    it("wrong agent: a presentation signed by a key that is not the credential's holder, and a payment as an agent the credential does not name, both fail", async () => {
      const w = await world();
      const other = generateKeyPairSync("ed25519");
      expect(reasons(await verify(w, orderOf(), other.privateKey))).toEqual([
        "POSSESSION_NOT_PROVEN",
      ]);
      const asB = await settle(pay(w.agent.client, w.auth, { agent: "b" }));
      expect(asB).toMatchObject({
        decision: "DENY",
        effectCount: 0,
        reason: "ACCESS_AGENT_MISMATCH",
      });
      noEffect();
    });

    it("a tampered credential fails: widening its own scope breaks the issuer's signature", async () => {
      const w = await world({ maxAmountMinor: 5_000 });
      const forged = structuredClone(w.issued.credential);
      (forged.root.claims.scope as { maxAmountMinor: number }).maxAmountMinor =
        9_000_000;
      const v = await verify(w, orderOf(), undefined, forged);
      expect(reasons(v)).toEqual(["ROOT_SIGNATURE_INVALID"]);
    });

    it("a replayed challenge or presentation is refused after the first success", async () => {
      const w = await world();
      const { challenge } = await w.shop.merchant.issue(orderOf());
      const presentation = show(w.issued.credential, challenge);
      expect(
        (await w.shop.merchant.verifyAgent(presentation, orderOf())).valid,
      ).toBe(true);
      expect(
        await w.shop.merchant.verifyAgent(presentation, orderOf()),
      ).toEqual({
        valid: false,
        reasons: ["UNKNOWN_CHALLENGE"],
      });
      // A second merchant instance on the same database refuses it too.
      const second = merchantInstance(w.dir);
      expect(
        (
          await second.merchant.verifyAgent(
            show(w.issued.credential, challenge),
            orderOf(),
          )
        ).valid,
      ).toBe(false);
    });

    it("a revoked credential, then a revoked Authority: learned from the signed status list, and the Gateway denies the payment", async () => {
      const w = await world();
      expect((await verify(w, orderOf())).valid).toBe(true);
      // Revoke the credential through the member API.
      expect(
        await w.issued.members.credentials.revoke(
          w.issued.credentialId,
          "lost",
        ),
      ).toMatchObject({ found: true });
      await w.dir.refreshStatus(origin);
      const afterCred = await verify(w, orderOf({ orderId: "order-2" }));
      expect(reasons(afterCred)).toContain("REVOKED");
      expect(
        w.shop.merchant.gateMark(afterCred, orderOf({ orderId: "order-2" }))
          ?.state,
      ).toBe("REVOKED");
      // Revoke the stored Authority itself: a different credential for it dies with it, and the Gateway denies.
      const w2 = await world();
      await repo.sql`update mandates set revoked_at = ${iso(nowMs)} where id = ${w2.auth}`;
      await w2.dir.refreshStatus(origin);
      expect(
        reasons(await verify(w2, orderOf({ orderId: "order-3" }))),
      ).toContain("REVOKED");
      const denied = await settle(pay(w2.agent.client, w2.auth));
      expect(denied).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "AUTHORITY_REVOKED",
      });
      noEffect();
    });

    it("stale issuer status is UNKNOWN, never green; a stale directory fails closed; both recover on refresh", async () => {
      const w = await world({ ttlSeconds: 6 * 3600 });
      expect((await verify(w, orderOf())).valid).toBe(true);
      // Status list lifetime is 15 minutes; do not refresh.
      nowMs += 20 * 60 * 1000;
      const stale = await verify(w, orderOf({ orderId: "order-2" }));
      expect(reasons(stale)).toEqual(["STATUS_LIST_STALE"]);
      expect(
        w.shop.merchant.gateMark(stale, orderOf({ orderId: "order-2" }))?.state,
      ).toBe("UNKNOWN");
      // Directory lifetime is one hour.
      nowMs += 60 * 60 * 1000;
      const noKeys = await verify(w, orderOf({ orderId: "order-3" }));
      expect(reasons(noKeys)).toEqual(["UNKNOWN_ISSUER_KEY"]);
      await learn(w.dir);
      expect((await verify(w, orderOf({ orderId: "order-4" }))).valid).toBe(
        true,
      );
    });

    it("key rotation: a credential issued before rotation keeps verifying, a new one verifies, through a client that only followed the chain", async () => {
      const w = await world();
      const before = w.issued.credential;
      const next = generateKeyPairSync("ed25519");
      await new SigningKeyRegistry(repo.sql).announce(
        "payflow-sandbox",
        "rotated-2",
        next.publicKey.export({ format: "jwk" }),
        iso(nowMs),
      );
      await learn(w.dir);
      await host?.close();
      startHost({
        PAYFLOW_M6_SIGNING_KEY: pemOf(next),
        PAYFLOW_M6_SIGNING_KID: "rotated-2",
      });
      await learn(w.dir);
      expect(
        (await verify(w, orderOf({ orderId: "order-2" }), undefined, before))
          .valid,
      ).toBe(true);
      const after = await issue(w.auth);
      expect(after.credential.root.claims.kid).toBe("rotated-2");
      expect(
        (
          await verify(
            w,
            orderOf({ orderId: "order-3" }),
            undefined,
            after.credential,
          )
        ).valid,
      ).toBe(true);
    });

    it("duplicate payment: the same action nonce executes once; one payment cannot pay two orders", async () => {
      const w = await world();
      const nonce = `phb-dup-nonce-${String(++n).padStart(8, "0")}`;
      const first = await pay(w.agent.client, w.auth, { nonce });
      const again = await settle(pay(w.agent.client, w.auth, { nonce }));
      expect(first).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      expect(provider.captureCalls).toBe(1);
      expect(again).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "REPLAY_DETECTED",
      });
      const proof = await portableProof(
        w.agent.token,
        first.proof?.proposalId ?? "",
      );
      expect(
        (await w.shop.merchant.associateProof(proof, orderOf())).verdict,
      ).toBe("FULFIL");
      expect(
        await w.shop.merchant.associateProof(
          proof,
          orderOf({ orderId: "order-2" }),
        ),
      ).toMatchObject({
        verdict: "REFUSE",
        reason: "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER",
      });
    });

    it("UNKNOWN effect: the lost response is never retried into a second payment, and the merchant HOLDs the order", async () => {
      const w = await world();
      provider.loseCapture = true;
      const unknown = await pay(w.agent.client, w.auth);
      provider.loseCapture = false;
      expect(unknown).toMatchObject({
        status: "UNRESOLVED",
        effectCount: null,
      });
      const proof = await portableProof(
        w.agent.token,
        unknown.proof?.proposalId ?? "",
      );
      expect(
        await w.shop.merchant.associateProof(proof, orderOf()),
      ).toMatchObject({
        verdict: "HOLD",
        reason: "OUTCOME_UNKNOWN",
      });
      expect(provider.captureCalls).toBe(1);
    });

    it("interrupted execution: a lost create response is UNKNOWN and is never retried into a second order or a capture", async () => {
      const w = await world();
      provider.loseCreate = true;
      const nonce = `phb-int-nonce-${String(++n).padStart(8, "0")}`;
      const first = await settle(pay(w.agent.client, w.auth, { nonce }));
      provider.loseCreate = false;
      expect(first).toMatchObject({
        status: "UNRESOLVED",
        effectCount: null,
        doNotRetry: true,
        reason: "PAYPAL_ORDER_CREATE_UNKNOWN",
      });
      const retry = await settle(pay(w.agent.client, w.auth, { nonce }));
      expect(retry).toMatchObject({
        status: "DENIED",
        reason: "REPLAY_DETECTED",
      });
      expect(provider.uniqueOrders).toBe(1);
      expect(provider.createCalls).toBe(1);
      expect(provider.captureCalls).toBe(0);
    });

    it("merchant-store restart mid-flow: an issued challenge survives, a spent one stays spent, and a payment ledger entry survives", async () => {
      const w = await world();
      const { challenge } = await w.shop.merchant.issue(orderOf());
      const spent = await w.shop.merchant.issue(
        orderOf({ orderId: "order-2" }),
      );
      expect(
        (
          await w.shop.merchant.verifyAgent(
            show(w.issued.credential, spent.challenge),
            orderOf({ orderId: "order-2" }),
          )
        ).valid,
      ).toBe(true);
      const paid = await pay(w.agent.client, w.auth);
      const proof = await portableProof(
        w.agent.token,
        paid.proof?.proposalId ?? "",
      );
      expect(
        (await w.shop.merchant.associateProof(proof, orderOf())).verdict,
      ).toBe("FULFIL");
      await w.shop.sql.end({ timeout: 1 });
      const restarted = merchantInstance(w.dir);
      expect(
        (
          await restarted.merchant.verifyAgent(
            show(w.issued.credential, challenge),
            orderOf(),
          )
        ).valid,
      ).toBe(true);
      expect(
        (
          await restarted.merchant.verifyAgent(
            show(w.issued.credential, spent.challenge),
            orderOf({ orderId: "order-2" }),
          )
        ).valid,
      ).toBe(false);
      expect(
        await restarted.merchant.associateProof(
          proof,
          orderOf({ orderId: "order-9" }),
        ),
      ).toMatchObject({ verdict: "REFUSE" });
    });

    it("concurrent delegated spending through the supported clients: a shared budget lets exactly one of two concurrent purchases through", async () => {
      const auth = await authority();
      const t = await ownerOf();
      const members = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: t,
      });
      await agentClient("b");
      const a = await agentClient("a");
      const root = await members.delegations.createRoot(auth, {
        childAgentId: "b",
        budgetMinor: 10_000,
        idempotencyKey: `phb-root-key-${String(++n).padStart(8, "0")}`,
      });
      if (!root.ok) throw new Error(root.reason);
      const leaf = await members.delegations.delegate(root.delegationId, {
        childAgentId: "a",
        maxAmountMinor: 9_000,
        idempotencyKey: `phb-hop-key-${String(++n).padStart(8, "0")}`,
      });
      if (!leaf.ok) throw new Error(leaf.reason);
      const widen = await members.delegations.delegate(root.delegationId, {
        childAgentId: "a",
        maxAmountMinor: 10_001,
        idempotencyKey: `phb-wide-key-${String(++n).padStart(8, "0")}`,
      });
      expect(widen).toMatchObject({ ok: false, httpStatus: 403 });
      const send = () =>
        fetch(`${origin}/v1/a2a/message:send`, {
          method: "POST",
          headers: {
            "content-type": "application/a2a+json",
            "A2A-Version": "1.0",
            authorization: `Bearer ${a.token}`,
          },
          body: JSON.stringify({
            message: {
              messageId: `phb-msg-${String(++n).padStart(8, "0")}`,
              role: "ROLE_USER",
              parts: [
                {
                  data: {
                    tool: "request_authorized_action",
                    arguments: {
                      action: {
                        authority: auth,
                        agentId: "a",
                        action: "purchase",
                        query: { text: "Quiet keyboard", quantity: 1 },
                        amount: { minor: 8_400, currency: "USD" },
                        merchant: { id: MERCHANT },
                        nonce: `phb-del-nonce-${String(++n).padStart(8, "0")}`,
                      },
                    },
                    delegation: { delegationId: leaf.delegationId },
                  },
                },
              ],
            },
          }),
        });
      const results = await Promise.all([send(), send()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(provider.captureCalls).toBe(1);
    });

    it("cross-tenant access: another organization sees, revokes and delegates nothing of this tenant's, and learns nothing from the refusals", async () => {
      const w = await world();
      const theirs = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await ownerOf("org-other"),
      });
      expect(await theirs.credentials.list(w.auth)).toEqual([]);
      expect(
        await theirs.credentials.revoke(w.issued.credentialId, "x"),
      ).toMatchObject({ found: false });
      expect(await theirs.delegations.list(w.auth)).toEqual([]);
      const rooted = await theirs.delegations.createRoot(w.auth, {
        childAgentId: "a",
        budgetMinor: 1_000,
        idempotencyKey: `phb-xt-key-${String(++n).padStart(8, "0")}`,
      });
      expect(rooted).toMatchObject({ ok: false, httpStatus: 404 });
      const issuedByThem = await theirs.credentials.issue(w.auth, {
        holder: holderJwk(holder.publicKey) as {
          kty: "OKP";
          crv: "Ed25519";
          x: string;
        },
        idempotencyKey: `phb-xt-iss-${String(++n).padStart(8, "0")}`,
      });
      expect(issuedByThem).toMatchObject({ ok: false });
      // The original credential is untouched and still verifies.
      expect((await verify(w, orderOf())).valid).toBe(true);
    });
  },
);
