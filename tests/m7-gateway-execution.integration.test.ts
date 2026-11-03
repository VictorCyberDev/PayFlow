import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import { DelegatedCommerceService } from "../src/delegated-commerce.js";
import { FakeCommerceRanker } from "../src/commerce-discovery.js";
import type { Mandate } from "../src/domain.js";
import { GatewayAccessError } from "../src/network/access.js";
import {
  GATEWAY_AUDIENCE,
  GatewayRequestError,
} from "../src/network/gateway.js";
import {
  ExecutingGateway,
  type GatewayEvent,
} from "../src/network/gateway-execution.js";
import { createExecutingRestHandler } from "../src/network/rest-execution.js";
import { VerticalSession } from "./m4-vertical-fixture.js";
import { checkoutAuthority, checkoutNow } from "./checkout-fixture.js";
import { discoveryOffer, discoveryQuery } from "./discovery-fixture.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";

const url = process.env.TEST_DATABASE_URL;

function authority(over: Partial<Mandate> = {}): Mandate {
  return {
    ...checkoutAuthority().mandate,
    maxSingleTransactionMinor: 10000,
    cumulativeLimitMinor: 10000,
    autonomousPurchaseThresholdMinor: 10000,
    humanApprovalThresholdMinor: 10000,
    ...over,
  };
}

const access = {
  clientId: "client-1",
  agentId: "commerce-a",
  principalId: "commerce-p",
  audience: GATEWAY_AUDIENCE,
  scopes: ["action:request"],
  issuedAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-12T00:00:00.000Z",
  status: "ACTIVE",
};
let n = 0;
const body = (over: Record<string, unknown> = {}) => ({
  authority: "commerce-m",
  agentId: "commerce-a",
  action: "purchase",
  query: discoveryQuery,
  amount: { minor: 8400, currency: "USD" },
  merchant: { id: "payflow.demo.merchant" },
  nonce: `nonce-${String(++n).padStart(16, "0")}`,
  ...over,
});

(url ? describe : describe.skip)(
  "M7 external Gateway -> real execution path (PostgreSQL, fake provider)",
  () => {
    let repo: PostgresTrustRepository;
    let s: VerticalSession;
    let gw: ExecutingGateway;
    let events: GatewayEvent[];

    async function provision(over: Partial<Mandate> = {}) {
      const f = checkoutAuthority();
      const m = authority(over);
      await repo.savePrincipal({ id: m.principalId, displayName: "Human" });
      await repo.saveAgent(f.agent);
      await repo.saveMandate(m);
      await s.checkout.registerMerchantBinding();
    }
    async function counts() {
      const [r] = await repo.sql`select
        (select count(*) from authorization_reservations) reservations,
        (select count(*) from execution_grants) grants,
        (select count(*) from payment_attempts) attempts`;
      return Object.fromEntries(
        Object.entries(r!).map(([k, v]) => [k, Number(v)]),
      ) as Record<string, number>;
    }
    const effects = () => ({
      creates: s.provider.createCalls,
      captures: s.provider.captureCalls,
    });
    const expectZeroEffect = async () => {
      expect(effects()).toEqual({ creates: 0, captures: 0 });
      expect(await counts()).toEqual({
        reservations: 0,
        grants: 0,
        attempts: 0,
      });
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
    });
    afterAll(async () => repo?.close());
    beforeEach(async () => {
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      s = new VerticalSession(repo);
      s.provider.payer = false; // delegated instrument: orders are born APPROVED
      events = [];
      gw = new ExecutingGateway({
        repo,
        delegated: new DelegatedCommerceService({
          discovery: s.discovery,
          checkout: s.checkout,
          authorizer: s.authorizer,
          issuer: s.issuer,
          boundary: s.boundary,
          merchantRisk: "LOW",
          clock: () => s.time,
        }),
        ranker: new FakeCommerceRanker(),
        now: () => s.time,
        onEvent: (e) => {
          events.push(e);
        },
      });
    });

    it("a bounded $84 request executes exactly once and returns a machine-readable result", async () => {
      await provision();
      const r = await gw.requestPurchase(access, body());
      expect(r).toMatchObject({
        decision: "ALLOW",
        status: "COMPLETED",
        effectCount: 1,
        nextAction: "INSPECT_PROOF",
      });
      expect(r.proof?.executionId).toBeTruthy();
      expect(effects()).toEqual({ creates: 1, captures: 1 });
      expect((await counts()).grants).toBe(1);
      expect(events.map((e) => e.type)).toEqual([
        "gateway.request_received",
        "gateway.evaluated",
        "gateway.executed",
      ]);
      // Events are identifiers and outcome only.
      expect(JSON.stringify(events)).not.toMatch(/nonce-|secret|token/i);
    });

    it("a claimed amount that differs from the trusted price is refused with $0 moved", async () => {
      await provision();
      const r = await gw.requestPurchase(
        access,
        body({ amount: { minor: 5000, currency: "USD" } }),
      );
      expect(r).toMatchObject({
        decision: "DENY",
        status: "DENIED",
        effectCount: 0,
        reason: "CLAIMED_TERMS_DO_NOT_MATCH_TRUSTED_PRICE",
        recoverable: true,
      });
      await expectZeroEffect();
    });

    it("a substituted merchant is refused with $0 moved", async () => {
      await provision();
      const r = await gw.requestPurchase(
        access,
        body({ merchant: { id: "other.merchant" } }),
      );
      expect(r).toMatchObject({ decision: "DENY", effectCount: 0 });
      await expectZeroEffect();
    });

    it("a trusted price above the Authority limit is refused with $0 moved and an actionable message", async () => {
      await provision({
        maxSingleTransactionMinor: 5000,
        cumulativeLimitMinor: 5000,
        autonomousPurchaseThresholdMinor: 5000,
        humanApprovalThresholdMinor: 5000,
      });
      const r = await gw.requestPurchase(access, body());
      expect(r).toMatchObject({
        decision: "DENY",
        effectCount: 0,
        reason: "NO_OFFER_INSIDE_AUTHORITY",
        nextAction: "CHANGE_REQUEST_OR_REQUEST_APPROVAL",
      });
      expect(r.humanSummary).toContain("$50");
      await expectZeroEffect();
    });

    it("price drift: the agent asks for $84, the trusted merchant price is $184, the Authority limit is $100", async () => {
      await provision();
      const catalog = demoCommerceCatalog();
      catalog.offers[0]!.unitPrice.minor = 18400;
      const drift = new VerticalSession(repo, [discoveryOffer()], catalog);
      drift.provider.payer = false;
      const driftGateway = new ExecutingGateway({
        repo,
        delegated: new DelegatedCommerceService({
          discovery: drift.discovery,
          checkout: drift.checkout,
          authorizer: drift.authorizer,
          issuer: drift.issuer,
          boundary: drift.boundary,
          merchantRisk: "LOW",
          clock: () => drift.time,
        }),
        ranker: new FakeCommerceRanker(),
        now: () => drift.time,
      });
      const r = await driftGateway.requestPurchase(access, body());
      expect(r).toMatchObject({
        decision: "DENY",
        effectCount: 0,
        reason: "AMOUNT_EXCEEDS_AUTHORITY",
        nextAction: "REDUCE_AMOUNT_OR_REQUEST_APPROVAL",
      });
      expect(r.humanSummary).toContain("$100");
      expect(drift.provider.createCalls + drift.provider.captureCalls).toBe(0);
      expect((await counts()).grants).toBe(0);
    });

    it("replaying the same nonce never produces a second provider effect", async () => {
      await provision();
      const request = body();
      const first = await gw.requestPurchase(access, request);
      expect(first.status).toBe("COMPLETED");
      const second = await gw.requestPurchase(access, request);
      expect(second).toMatchObject({
        decision: "DENY",
        reason: "REPLAY_DETECTED",
        effectCount: 0,
      });
      expect(effects()).toEqual({ creates: 1, captures: 1 });
      expect(events.map((e) => e.type)).toContain("gateway.replay_blocked");
    });

    it("a revoked Authority fails closed with no reservation, grant or provider call", async () => {
      await provision();
      await repo.revokeMandate("commerce-m", checkoutNow);
      const r = await gw.requestPurchase(access, body());
      expect(r).toMatchObject({
        decision: "DENY",
        effectCount: 0,
        reason: "AUTHORITY_REVOKED",
        recoverable: false,
      });
      await expectZeroEffect();
    });

    it("credentials for another agent, principal, scope or audience are refused before anything is stored", async () => {
      await provision();
      await expect(
        gw.requestPurchase({ ...access, agentId: "intruder" }, body()),
      ).rejects.toBeInstanceOf(GatewayRequestError);
      await expect(
        gw.requestPurchase({ ...access, principalId: "other" }, body()),
      ).rejects.toBeInstanceOf(GatewayRequestError);
      await expect(
        gw.requestPurchase({ ...access, scopes: ["authority:read"] }, body()),
      ).rejects.toBeInstanceOf(GatewayAccessError);
      await expect(
        gw.requestPurchase({ ...access, audience: "elsewhere" }, body()),
      ).rejects.toBeInstanceOf(GatewayAccessError);
      await expect(
        gw.requestPurchase(
          { ...access, expiresAt: "2026-10-10T12:00:00.000Z" },
          body(),
        ),
      ).rejects.toBeInstanceOf(GatewayAccessError);
      await expectZeroEffect();
    });

    it("a malformed request is rejected and an unknown field cannot smuggle Authority", async () => {
      await provision();
      await expect(
        gw.requestPurchase(access, {
          ...body(),
          maxSingleTransactionMinor: 1e9,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_MALFORMED" });
      await expect(
        gw.requestPurchase(access, body({ nonce: "short" })),
      ).rejects.toMatchObject({ code: "REQUEST_MALFORMED" });
      await expectZeroEffect();
    });

    it("concurrent overrun: five parallel $84 requests against a $100 Authority produce one payment", async () => {
      await provision();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => gw.requestPurchase(access, body())),
      );
      const completed = results.filter((r) => r.status === "COMPLETED");
      expect(completed).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status !== "COMPLETED")
          .every((r) => r.effectCount === 0),
      ).toBe(true);
      expect(s.provider.captureCalls).toBe(1);
    });

    it("UNKNOWN stays UNKNOWN: a lost capture response is never reported as failed and never retried", async () => {
      await provision();
      s.provider.loseCapture = true;
      const r = await gw.requestPurchase(access, body());
      expect(r).toMatchObject({
        decision: "ALLOW",
        status: "UNRESOLVED",
        effectCount: null,
        doNotRetry: true,
        humanSummary: "We're confirming whether money moved.",
        nextAction: "DO_NOT_RETRY_WAIT_FOR_RECONCILIATION",
      });
      const captures = s.provider.captureCalls;
      // A new request cannot spend again while the first payment is unresolved.
      const again = await gw.requestPurchase(access, body());
      expect(again.status).not.toBe("COMPLETED");
      expect(s.provider.captureCalls).toBe(captures);
      expect(events.map((e) => e.type)).toContain("gateway.unknown");
    });

    describe("REST adapter", () => {
      const handler = () =>
        createExecutingRestHandler(gw, {
          authenticate: (h) =>
            h === "Bearer good"
              ? Promise.resolve(access as never)
              : Promise.reject(new GatewayAccessError("ACCESS_INACTIVE")),
        });
      it("executes once over HTTP and returns the structured result", async () => {
        await provision();
        const res = await handler()({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: "Bearer good",
          body: body(),
        });
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body).toMatchObject({ status: "COMPLETED", effectCount: 1 });
        expect(JSON.stringify(res.body)).not.toMatch(/Bearer|secret|token/i);
      });
      it("rejects a bad credential with an actionable body and $0 moved", async () => {
        await provision();
        const res = await handler()({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: "Bearer bad",
          body: body(),
        });
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({
          decision: "DENY",
          effectCount: 0,
          nextAction: "USE_A_VALID_CREDENTIAL",
        });
        await expectZeroEffect();
      });
      it("rejects malformed input with a recoverable 400", async () => {
        await provision();
        const res = await handler()({
          method: "POST",
          path: "/v1/actions/execute",
          authorization: "Bearer good",
          body: { nope: true },
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ recoverable: true });
        await expectZeroEffect();
      });
    });

    it("kernel refusals map to specific, actionable machine and human messages", async () => {
      await provision({
        cumulativeLimitMinor: 10000,
        quantityLimit: 5,
      });
      const first = await gw.requestPurchase(access, body());
      expect(first.status).toBe("COMPLETED");
      const second = await gw.requestPurchase(access, body());
      expect(second).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "CUMULATIVE_LIMIT_EXCEEDED",
        nextAction: "ASK_OWNER_FOR_MORE_BUDGET",
      });
      expect(second.humanSummary).toContain("budget");
    });
  },
);
