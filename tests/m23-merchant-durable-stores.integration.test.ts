import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildStatusList,
  CREDENTIAL_VERSION,
  holderJwk,
  issueCredential,
  present,
  type Credential,
  type IssuerTrust,
} from "../packages/verifier/src/authority.js";
import {
  MerchantVerifier,
  type MerchantOrder,
  type ProofCheck,
} from "../packages/merchant-sdk/src/verifier.js";
import {
  PostgresChallengeStore,
  PostgresNonceStore,
  PostgresProofLedger,
} from "../packages/merchant-sdk/src/postgres-stores.js";

/**
 * M23 shared durable merchant stores against real PostgreSQL. Several verifier "instances" (separate store objects, and
 * separate connection pools after a "restart") must behave as ONE verifier.
 */
const url = process.env.TEST_DATABASE_URL;
const ISS = "https://issuer.example";
const AUD = "https://shop.example";
const NS = "shop-1";
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const order: MerchantOrder = {
  orderId: "order-1",
  amountMinor: 8_400,
  currency: "USD",
  merchantId: "shop-1",
};

(url ? describe : describe.skip)(
  "M23 durable merchant challenge, nonce and Proof stores (PostgreSQL)",
  () => {
    let admin: ReturnType<typeof postgres>;
    const pools: ReturnType<typeof postgres>[] = [];
    const pool = () => {
      const p = postgres(url!, { max: 8, onnotice: () => undefined });
      pools.push(p);
      return p;
    };
    let clock = T0;
    const issuer = generateKeyPairSync("ed25519");
    const agent = generateKeyPairSync("ed25519");
    let credential: Credential;
    let proofCheck: ProofCheck;

    const trust: IssuerTrust = {
      issuer: ISS,
      status: "TRUSTED",
      maxDelegationDepth: 3,
      allowedActionKinds: ["PURCHASE"],
      allowedCurrencies: ["USD"],
      maxAmountMinor: 10_000,
    };
    const status = buildStatusList(
      {
        iss: ISS,
        kid: "k1",
        issuedAt: "2026-11-06T11:00:00.000Z",
        validUntil: "2026-11-06T18:00:00.000Z",
        revoked: [],
      },
      issuer.privateKey,
    );
    const show = (challenge: string) =>
      present(credential, agent.privateKey, {
        aud: AUD,
        challenge,
        nonce: `n-${Math.random().toString(36).slice(2)}-0123456`,
        iat: new Date(clock).toISOString(),
        exp: new Date(clock + 120_000).toISOString(),
      });

    /** One merchant instance with its own connection pool, all sharing the one database. */
    function instance(sql = pool(), namespace = NS) {
      const merchant = new MerchantVerifier({
        audience: AUD,
        now: () => new Date(clock).toISOString(),
        env: {
          issuerKey: (iss, kid) =>
            iss === ISS && kid === "k1" ? holderJwk(issuer.publicKey) : null,
          trust: (iss) => (iss === ISS ? trust : null),
          statusList: () => status,
        },
        proofVerifier: () => Promise.resolve(proofCheck),
        challenges: new PostgresChallengeStore(sql, namespace),
        claimNonce: new PostgresNonceStore(sql, namespace, () => clock).claim,
        proofLedger: new PostgresProofLedger(sql, namespace),
      });
      return { merchant, sql };
    }

    beforeAll(async () => {
      admin = postgres(url!, { max: 2, onnotice: () => undefined });
      await admin.unsafe(
        "drop table if exists merchant_challenges, merchant_nonces, merchant_proof_claims cascade",
      );
      await admin.unsafe(
        await readFile("db/migrations/028_m23_merchant_stores.sql", "utf8"),
      );
      credential = issueCredential(
        {
          v: CREDENTIAL_VERSION,
          iss: ISS,
          kid: "k1",
          jti: "cred-1",
          sub: "agent-1",
          principal: "p1",
          holder: holderJwk(agent.publicKey),
          scope: {
            actionKinds: ["PURCHASE"],
            currencies: ["USD"],
            counterpartyIds: ["shop-1"],
            maxAmountMinor: 10_000,
          },
          nbf: "2026-11-06T00:00:00.000Z",
          exp: "2026-11-07T00:00:00.000Z",
          maxDepth: 2,
        },
        issuer.privateKey,
      );
    });
    beforeEach(async () => {
      clock = T0;
      await admin`truncate merchant_challenges, merchant_nonces, merchant_proof_claims`;
      proofCheck = {
        verified: true,
        authentic: true,
        reason: "OK",
        outcome: "SUCCEEDED",
        effectCount: 1,
        actionId: "act-1",
        mismatches: [],
      };
    });
    afterAll(async () => {
      await admin.unsafe(
        "drop table if exists merchant_challenges, merchant_nonces, merchant_proof_claims cascade",
      );
      await admin.end();
      await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
    });

    it("a challenge issued by one instance is verified by another, once, and a replay is refused by every instance", async () => {
      const a = instance();
      const b = instance();
      const { challenge } = await a.merchant.issue(order);
      const v = await b.merchant.verifyAgent(show(challenge), order);
      expect(v.valid).toBe(true);
      for (const m of [a, b])
        expect(await m.merchant.verifyAgent(show(challenge), order)).toEqual({
          valid: false,
          reasons: ["UNKNOWN_CHALLENGE"],
        });
    });

    it("exactly one of many concurrent presentations on one challenge wins, across instances", async () => {
      const a = instance();
      const b = instance();
      const { challenge } = await a.merchant.issue(order);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? a : b).merchant.verifyAgent(show(challenge), order),
        ),
      );
      expect(results.filter((r) => r.valid)).toHaveLength(1);
      const [row] =
        await admin`select count(*)::int n from merchant_challenges where consumed_at is not null`;
      expect(row!.n).toBe(1);
    });

    it("survives a restart: an unspent challenge still works, a spent one stays spent", async () => {
      const first = instance();
      const open = await first.merchant.issue(order);
      const spent = await first.merchant.issue({
        ...order,
        orderId: "order-2",
      });
      expect(
        (
          await first.merchant.verifyAgent(show(spent.challenge), {
            ...order,
            orderId: "order-2",
          })
        ).valid,
      ).toBe(true);
      await first.sql.end({ timeout: 1 });
      const restarted = instance();
      expect(
        (await restarted.merchant.verifyAgent(show(open.challenge), order))
          .valid,
      ).toBe(true);
      expect(
        (
          await restarted.merchant.verifyAgent(show(spent.challenge), {
            ...order,
            orderId: "order-2",
          })
        ).valid,
      ).toBe(false);
    });

    it("binds a challenge to one order: other facts are refused and do NOT spend it", async () => {
      const a = instance();
      const { challenge } = await a.merchant.issue(order);
      for (const wrong of [
        { ...order, amountMinor: 8_401 },
        { ...order, orderId: "order-9" },
        { ...order, currency: "EUR" },
        { ...order, merchantId: "other" },
      ])
        expect(
          (await a.merchant.verifyAgent(show(challenge), wrong)).valid,
        ).toBe(false);
      expect((await a.merchant.verifyAgent(show(challenge), order)).valid).toBe(
        true,
      );
    });

    it("expires, and stores only a hash of the challenge", async () => {
      const a = instance();
      const { challenge } = await a.merchant.issue(order);
      const dump = JSON.stringify(
        await admin`select * from merchant_challenges`,
      );
      expect(dump).not.toContain(challenge);
      clock += 301_000;
      expect((await a.merchant.verifyAgent(show(challenge), order)).valid).toBe(
        false,
      );
    });

    it("is namespaced: another merchant sharing the database cannot spend this merchant's challenge", async () => {
      const mine = instance(pool(), "shop-1");
      const theirs = instance(pool(), "shop-2");
      const { challenge } = await mine.merchant.issue(order);
      expect(
        (await theirs.merchant.verifyAgent(show(challenge), order)).valid,
      ).toBe(false);
      expect(
        (await mine.merchant.verifyAgent(show(challenge), order)).valid,
      ).toBe(true);
    });

    it("a presentation nonce is claimed once across instances, even concurrently, and expires from retention", async () => {
      const x = new PostgresNonceStore(pool(), NS, () => clock);
      const y = new PostgresNonceStore(pool(), NS, () => clock);
      const wins = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? x : y).claim(
            "pac:https://shop.example:c1",
            "nonce-abcdefgh-1",
          ),
        ),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(
        await x.claim("pac:https://shop.example:c1", "nonce-abcdefgh-2"),
      ).toBe(true);
      expect(
        await new PostgresNonceStore(pool(), "shop-2", () => clock).claim(
          "pac:https://shop.example:c1",
          "nonce-abcdefgh-1",
        ),
      ).toBe(true);
    });

    it("one payment pays one order, one order is paid by one payment, across instances and restarts", async () => {
      const a = instance();
      const b = instance();
      expect(await a.merchant.associateProof({}, order)).toMatchObject({
        verdict: "FULFIL",
      });
      // Re-check of the same order is fine, from any instance.
      expect(await b.merchant.associateProof({}, order)).toMatchObject({
        verdict: "FULFIL",
      });
      // The same payment cannot pay a second order.
      expect(
        await b.merchant.associateProof({}, { ...order, orderId: "order-2" }),
      ).toMatchObject({
        verdict: "REFUSE",
        reason: "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER",
      });
      // A second, different payment cannot pay the same order again.
      proofCheck = { ...proofCheck, actionId: "act-2" };
      expect(await a.merchant.associateProof({}, order)).toMatchObject({
        verdict: "REFUSE",
        reason: "ORDER_ALREADY_PAID_BY_ANOTHER_PAYMENT",
      });
      await a.sql.end({ timeout: 1 });
      proofCheck = { ...proofCheck, actionId: "act-1" };
      expect(
        await instance().merchant.associateProof(
          {},
          { ...order, orderId: "order-3" },
        ),
      ).toMatchObject({
        verdict: "REFUSE",
      });
    });

    it("concurrent claims cannot double-pay: one action for many orders, and many actions for one order, each yield exactly one winner", async () => {
      const ledgers = [
        new PostgresProofLedger(pool(), NS),
        new PostgresProofLedger(pool(), NS),
      ];
      const forAction = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          ledgers[i % 2]!.claim("act-X", `order-${i}`),
        ),
      );
      expect(forAction.filter((r) => r === "CLAIMED")).toHaveLength(1);
      const forOrder = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          ledgers[i % 2]!.claim(`act-${i}`, "order-Z"),
        ),
      );
      expect(forOrder.filter((r) => r === "CLAIMED")).toHaveLength(1);
      const [row] =
        await admin`select count(*)::int n from merchant_proof_claims`;
      expect(row!.n).toBe(2);
    });

    it("fails closed when the store is unavailable: no challenge, no valid verification, and the Proof HOLDs (never ship, never cancel)", async () => {
      const a = instance();
      const { challenge } = await a.merchant.issue(order);
      const down = instance();
      await down.sql.end({ timeout: 1 });
      await expect(down.merchant.issue(order)).rejects.toBeTruthy();
      expect(await down.merchant.verifyAgent(show(challenge), order)).toEqual({
        valid: false,
        reasons: ["STORE_UNAVAILABLE"],
      });
      expect(await down.merchant.associateProof({}, order)).toMatchObject({
        verdict: "HOLD",
        reason: "VERIFIER_UNAVAILABLE",
      });
      // Nothing was spent or recorded by the failed attempts.
      expect((await a.merchant.verifyAgent(show(challenge), order)).valid).toBe(
        true,
      );
      const [row] =
        await admin`select count(*)::int n from merchant_proof_claims`;
      expect(row!.n).toBe(0);
    });

    it("a store that answers the peek but fails the spend never yields a valid verification", async () => {
      const a = instance();
      const { challenge } = await a.merchant.issue(order);
      const real = new PostgresChallengeStore(a.sql, NS);
      const flaky = new MerchantVerifier({
        audience: AUD,
        now: () => new Date(clock).toISOString(),
        env: {
          issuerKey: () => holderJwk(issuer.publicKey),
          trust: () => trust,
          statusList: () => status,
        },
        proofVerifier: () => Promise.resolve(proofCheck),
        challenges: {
          async: true,
          put: (c, r, n) => real.put(c, r, n),
          peek: (c, d, n) => real.peek(c, d, n),
          consume: () => Promise.reject(new Error("connection lost")),
        },
      });
      expect(await flaky.verifyAgent(show(challenge), order)).toEqual({
        valid: false,
        reasons: ["STORE_UNAVAILABLE"],
      });
    });

    it("the spend itself re-checks the order binding (not only the earlier peek)", async () => {
      const store = new PostgresChallengeStore(pool(), NS);
      await store.put(
        "c-direct-1",
        { digest: "a".repeat(64), expiresAt: clock + 60_000 },
        clock,
      );
      expect(await store.consume("c-direct-1", "b".repeat(64), clock)).toBe(
        false,
      );
      expect(
        await store.consume("c-direct-1", "a".repeat(64), clock + 61_000),
      ).toBe(false);
      expect(await store.consume("c-direct-1", "a".repeat(64), clock)).toBe(
        true,
      );
      expect(await store.consume("c-direct-1", "a".repeat(64), clock)).toBe(
        false,
      );
    });

    it("refuses the synchronous API with a shared store instead of silently skipping the write", () => {
      expect(() => instance().merchant.issueChallenge(order)).toThrow(
        "ASYNC_STORE_USE_ISSUE",
      );
    });
  },
);
