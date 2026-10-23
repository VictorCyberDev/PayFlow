import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  ConsoleSessions,
  type ConsoleRequest,
} from "../src/console-session.js";
import { ConsoleActivity } from "../src/activity-postgres.js";
import { ConsoleDemoAgent } from "../src/console-demo-agent.js";
import { DemoShoppingAgent } from "../src/delegated-demo.js";
import { checkoutAuthority } from "./checkout-fixture.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M6 demo Shopping Agent surface (PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository;
    let provider: VerticalProvider;
    const now = Date.parse("2026-10-11T00:00:00.000Z");
    const clock = () => new Date(now);
    const keys = generateKeyPairSync("ed25519");
    const origin = "http://127.0.0.1:4011";
    const bootstrap = "m6-demo-agent-bootstrap-".repeat(3);
    const base = { host: new URL(origin).host, origin };
    const signing = {
      kid: "m6",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    let agent: DemoShoppingAgent,
      api: ConsoleDemoAgent,
      activity: ConsoleActivity,
      req: ConsoleRequest;
    function loginAs(principalId: string) {
      const sessions = new ConsoleSessions(
        { principalId, origin, bootstrapKey: bootstrap },
        clock,
      );
      const l = sessions.login(base, { bootstrapCode: bootstrap });
      return {
        sessions,
        req: {
          ...base,
          cookie: l.cookie.split(";")[0]!,
          csrf: l.view.csrfToken,
        },
      };
    }
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            "transaction_proposals",
            "decision_receipts",
            "authorization_reservations",
            "execution_grants",
            "payment_attempts",
          ].map(
            async (t) =>
              [
                t,
                Number(
                  (await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n,
                ),
              ] as const,
          ),
        ),
      );
    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
    });
    afterAll(async () => repo.close());
    async function setUp(connected: boolean) {
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      const f = checkoutAuthority();
      const mandate = {
        ...f.mandate,
        maxSingleTransactionMinor: 10000,
        cumulativeLimitMinor: 10000,
        autonomousPurchaseThresholdMinor: 10000,
        humanApprovalThresholdMinor: 10000,
      };
      await repo.savePrincipal({
        id: mandate.principalId,
        displayName: "Human",
      });
      await repo.saveAgent(f.agent);
      await repo.saveMandate(mandate);
      provider = new VerticalProvider();
      provider.payer = false;
      agent = new DemoShoppingAgent({
        repo,
        provider: connected ? provider : null,
        signing,
        expectedPayPalMerchantId: "DEMOACCOUNT01",
        clock,
      });
      const { sessions, req: r } = loginAs("commerce-p");
      req = r;
      api = new ConsoleDemoAgent(repo, sessions, agent);
      activity = new ConsoleActivity(repo, sessions, agent.keys, clock);
    }
    beforeEach(() => setUp(true));

    it("status reports the payment rail honestly", async () => {
      expect(await api.status(req)).toMatchObject({
        payment: "SANDBOX_CONNECTED",
      });
      await setUp(false);
      expect(await api.status(req)).toMatchObject({ payment: "NOT_CONNECTED" });
    });

    it("VALID_PURCHASE completes under the Authority with one capture and shows as delegated in Activity", async () => {
      const out = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(out).toMatchObject({
        status: "COMPLETED",
        providerEffect: "CAPTURED",
        code: null,
      });
      expect(provider.captureCalls).toBe(1);
      const items = (await activity.read(req, {})).items;
      expect(items[0]).toMatchObject({
        operationId: out.operationId,
        status: "COMPLETED",
        moneyMoved: "YES",
        delegated: true,
        verification: "VERIFIED",
        amountMinor: 8400,
      });
    });

    it("PRICE_DRIFT is refused at $184, shows $0 moved, and creates nothing a provider could act on", async () => {
      const out = await api.run(req, {
        scenario: "PRICE_DRIFT",
        mandateId: "commerce-m",
      });
      expect(out).toMatchObject({
        status: "REFUSED",
        providerEffect: "NONE",
        code: "AMOUNT_EXCEEDS_LIMIT",
      });
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      expect(await counts()).toEqual({
        transaction_proposals: 0,
        decision_receipts: 0,
        authorization_reservations: 0,
        execution_grants: 0,
        payment_attempts: 0,
      });
      const item = (await activity.read(req, {})).items[0]!;
      expect(item).toMatchObject({
        operationId: out.operationId,
        moneyMoved: "NO",
        status: "DENIED",
        amountMinor: 18400,
      });
    });

    it("without a connected payment rail a purchase is refused before anything is written", async () => {
      await setUp(false);
      const out = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(out).toMatchObject({
        status: "REFUSED",
        code: "PAYMENT_RAIL_NOT_CONNECTED",
        providerEffect: "NONE",
      });
      expect(await counts()).toEqual({
        transaction_proposals: 0,
        decision_receipts: 0,
        authorization_reservations: 0,
        execution_grants: 0,
        payment_attempts: 0,
      });
      // The blocked case still runs without a rail and still cannot reach a provider.
      expect(
        (
          await api.run(req, {
            scenario: "PRICE_DRIFT",
            mandateId: "commerce-m",
          })
        ).status,
      ).toBe("REFUSED");
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("an uncertain payment is UNRESOLVED, never retried, and the system reconciles it to one capture", async () => {
      provider.loseCapture = true;
      const out = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(out).toMatchObject({
        status: "UNRESOLVED",
        providerEffect: "UNKNOWN",
      });
      expect(provider.captureCalls).toBe(1);
      const before = (await activity.read(req, {})).items[0]!;
      expect(before).toMatchObject({
        status: "UNKNOWN_FINANCIAL_OUTCOME",
        moneyMoved: "UNKNOWN",
        delegated: false,
      });
      expect(await api.reconcile(req, {})).toMatchObject({
        version: "payflow.demo-agent-reconcile.v1",
      });
      expect(provider.captureCalls).toBe(1);
      const after = (await activity.read(req, {})).items[0]!;
      expect(after).toMatchObject({
        status: "COMPLETED",
        moneyMoved: "YES",
        delegated: true,
        verification: "VERIFIED",
      });
      // Idempotent: further passes change nothing.
      await api.reconcile(req, {});
      expect(provider.captureCalls).toBe(1);
    });

    it("reconcile takes no body and cannot start a purchase", async () => {
      await expect(
        api.reconcile(req, { scenario: "VALID_PURCHASE" }),
      ).rejects.toThrow();
      await api.reconcile(req, {});
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      expect((await counts()).execution_grants).toBe(0);
    });

    it("a second purchase cannot exceed the Authority (one keyboard, $100)", async () => {
      await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      const again = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(again.status).not.toBe("COMPLETED");
      expect(provider.captureCalls).toBe(1);
    });

    it("another owner cannot drive someone else's Authority", async () => {
      const foreign = loginAs("someone-else");
      const other = new ConsoleDemoAgent(repo, foreign.sessions, agent);
      await expect(
        other.run(foreign.req, {
          scenario: "VALID_PURCHASE",
          mandateId: "commerce-m",
        }),
      ).rejects.toThrow();
      expect(provider.createCalls + provider.captureCalls).toBe(0);
      expect((await counts()).execution_grants).toBe(0);
    });

    it.each([
      { scenario: "VALID_PURCHASE", mandateId: "commerce-m", amountMinor: 1 },
      { scenario: "VALID_PURCHASE", mandateId: "commerce-m", principalId: "x" },
      { scenario: "TRANSFER", mandateId: "commerce-m" },
      { scenario: "VALID_PURCHASE" },
      { scenario: "VALID_PURCHASE", mandateId: "" },
    ])("malformed or widening request is refused: %j", async (body) => {
      await expect(api.run(req, body)).rejects.toThrow();
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("a revoked Authority cannot be used", async () => {
      await repo.revokeMandate("commerce-m", clock().toISOString());
      const out = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(out.status).toBe("REFUSED");
      expect(provider.createCalls + provider.captureCalls).toBe(0);
    });

    it("the response carries no grant, secret, provider id or stack", async () => {
      const out = await api.run(req, {
        scenario: "VALID_PURCHASE",
        mandateId: "commerce-m",
      });
      expect(Object.keys(out).sort()).toEqual([
        "code",
        "operationId",
        "providerEffect",
        "status",
        "version",
      ]);
      expect(JSON.stringify(out)).not.toMatch(
        /VERTICAL|ey[A-Za-z0-9_-]{20,}\.|at .*\.ts/,
      );
    });
  },
);
