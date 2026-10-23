import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  ConsoleSessions,
  type ConsoleRequest,
} from "../src/console-session.js";
import { ConsoleControls } from "../src/console-controls.js";
import { ConsoleActivity } from "../src/activity-postgres.js";
import { StaticPublicKeyRing } from "../src/execution-grant.js";
import { ConsoleActivation } from "../src/console-activation.js";
import { activationHttpHandler } from "../src/console-activation-host.js";
import { IntentReviewService } from "../src/intent-review.js";
import { demoReviewBounds } from "../src/intent-review-demo.js";
import { VerticalSession } from "./m4-vertical-fixture.js";
import { checkoutAuthority } from "./checkout-fixture.js";
import { PayPalProviderError } from "../src/paypal.js";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M5D owner-bound controls and read-only durable Activity (PostgreSQL + actual HTTP)",
  () => {
    let repo: PostgresTrustRepository,
      s: VerticalSession,
      sessions: ConsoleSessions,
      controls: ConsoleControls,
      activity: ConsoleActivity,
      req: ConsoleRequest,
      server: Server,
      origin: string;
    const bootstrap = "m5d-private-test-bootstrap-".repeat(3);
    const clock = () => new Date(s.time);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(origin + "/api/activation/revoke", {
        method: "POST",
        headers: {
          host: new URL(origin).host,
          origin,
          cookie: req.cookie!,
          "content-type": "application/json",
          "x-payflow-csrf": req.csrf!,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const get = (path: string) =>
      fetch(origin + path, { headers: { cookie: req.cookie! } });
    const revoke = () =>
      controls.revoke(req, {
        action: "REVOKE_AUTHORITY",
        mandateId: "commerce-m",
      });
    const snapshot = async () =>
      JSON.stringify(
        await repo.sql`select (select jsonb_agg(to_jsonb(p)) from transaction_proposals p) proposals,(select jsonb_agg(to_jsonb(r)) from decision_receipts r) receipts,(select jsonb_agg(to_jsonb(r)) from authorization_reservations r) reservations,(select jsonb_agg(to_jsonb(g)) from execution_grants g) grants,(select jsonb_agg(to_jsonb(a)) from payment_attempts a) attempts,(select jsonb_agg(to_jsonb(o)) from paypal_provider_observations o) observations,(select jsonb_agg(to_jsonb(e) order by sequence) from evidence_events e) evidence`,
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
    beforeEach(async () => {
      vi.restoreAllMocks();
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      s = new VerticalSession(repo);
      await s.provision();
      server = createServer((q, r) => {
        void handler(q, r);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      sessions = new ConsoleSessions(
        { principalId: "commerce-p", origin, bootstrapKey: bootstrap },
        clock,
      );
      controls = new ConsoleControls(repo, sessions, clock);
      activity = new ConsoleActivity(
        repo,
        sessions,
        new StaticPublicKeyRing(new Map([["m4f", s.keys.publicKey]])),
        clock,
      );
      const provider = {
        interpretIntent: () =>
          Promise.resolve({ status: "MODEL_UNAVAILABLE" as const }),
      };
      const app = new ConsoleActivation(
        repo,
        sessions,
        { agentId: "commerce-a", provider, bounds: demoReviewBounds },
        clock,
      );
      const handler = activationHttpHandler(app, {
        sample: "test",
        review: new IntentReviewService(provider, demoReviewBounds, clock),
        outputDirectory: "apps/console/out",
        controls,
        activity,
      });
      const r = await fetch(origin + "/api/activation/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ bootstrapCode: bootstrap }),
      });
      const view = (await r.json()) as { csrfToken: string };
      req = {
        host: new URL(origin).host,
        origin,
        cookie: r.headers.get("set-cookie")!.split(";")[0]!,
        csrf: view.csrfToken,
      };
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });
    afterAll(async () => repo.close());
    it("fresh durable list corrects stale ACTIVE after authenticated revoke; replay appends only one event and no financial rows", async () => {
      expect((await controls.list(req, {})).items[0]!.state).toBe("ACTIVE");
      const response = await post({
        action: "REVOKE_AUTHORITY",
        mandateId: "commerce-m",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "REVOKE_RECORDED",
        mandateId: "commerce-m",
      });
      await revoke();
      const list = await controls.list(req, {});
      expect(list.items[0]).toMatchObject({
        state: "REVOKED",
        freshDispatchBlocked: true,
      });
      expect(
        (await repo.evidence()).filter((e) => e.type === "MANDATE_REVOKED"),
      ).toHaveLength(1);
      expect(s.provider.createCalls).toBe(0);
      expect(s.provider.captureCalls).toBe(0);
      for (const table of [
        "payment_attempts",
        "authorization_reservations",
        "execution_grants",
        "transaction_proposals",
      ])
        expect(
          Number(
            (await repo.sql`select count(*) n from ${repo.sql(table)}`)[0]!.n,
          ),
        ).toBe(0);
      const reload = await get(
        "/api/activation/authority?mandateId=commerce-m",
      );
      expect(await reload.json()).toMatchObject({ state: "REVOKED" });
    });
    it("concurrent revoke is idempotent via the existing durable revocation winner", async () => {
      await Promise.all([revoke(), revoke(), revoke()]);
      expect(
        (await repo.evidence()).filter((e) => e.type === "MANDATE_REVOKED"),
      ).toHaveLength(1);
    });
    it("revoked authority blocks new authorization via the accepted durable service", async () => {
      await s.seal();
      await revoke();
      await expect(
        s.authorizer.authorizeProposal(s.proposalId!, "LOW", s.time),
      ).rejects.toThrow("MANDATE_REVOKED");
      expect(s.provider.createCalls).toBe(0);
      expect(s.provider.captureCalls).toBe(0);
    });
    it("wrong owner cannot list, revoke or select another owner's operation", async () => {
      await s.seal();
      const foreign = new ConsoleSessions(
        { principalId: "other", origin, bootstrapKey: bootstrap },
        clock,
      );
      const login = foreign.login(
        { host: req.host, origin },
        { bootstrapCode: bootstrap },
      );
      const foreignReq = {
        ...req,
        cookie: login.cookie.split(";")[0],
        csrf: login.view.csrfToken,
      };
      const c = new ConsoleControls(repo, foreign, clock);
      expect((await c.list(foreignReq, {})).items).toEqual([]);
      await expect(
        c.revoke(foreignReq, {
          action: "REVOKE_AUTHORITY",
          mandateId: "commerce-m",
        }),
      ).rejects.toThrow();
      const a = new ConsoleActivity(
        repo,
        foreign,
        new StaticPublicKeyRing(new Map()),
        clock,
      );
      expect((await a.read(foreignReq, {})).items).toEqual([]);
      await expect(
        a.read(foreignReq, { operationId: s.proposalId }),
      ).rejects.toThrow();
      expect((await controls.list(req, {})).items[0]!.state).toBe("ACTIVE");
    });
    it.each([
      { action: "REVOKE_AUTHORITY", mandateId: "missing" },
      {
        action: "REVOKE_AUTHORITY",
        mandateId: "commerce-m",
        principalId: "commerce-p",
      },
      { action: "SUSPEND_AUTHORITY", mandateId: "commerce-m" },
      { action: "REVOKE_AUTHORITY", mandateId: "" },
    ])("malformed/tampered mutation fails closed %j", async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(
        (await repo.evidence()).filter((e) => e.type === "MANDATE_REVOKED"),
      ).toHaveLength(0);
    });
    it.each(["csrf", "origin", "session", "expired"])(
      "rejects %s revoke without changing durable state",
      async (kind) => {
        if (kind === "expired")
          s.time = new Date(Date.parse(s.time) + 900001).toISOString();
        const headers =
          kind === "csrf"
            ? { "x-payflow-csrf": "bad" }
            : kind === "origin"
              ? { origin: "https://evil.example" }
              : kind === "session"
                ? { cookie: "forged" }
                : {};
        expect(
          (
            await post(
              { action: "REVOKE_AUTHORITY", mandateId: "commerce-m" },
              headers,
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await repo.sql`select revoked_at from mandates where id='commerce-m'`
          )[0]!.revoked_at,
        ).toBeNull();
      },
    );
    it("captured history remains truthful after revoke; reloads do not append evidence or call provider", async () => {
      s.provider.payer = false;
      await s.execute();
      const before = await snapshot();
      const calls = [s.provider.createCalls, s.provider.captureCalls];
      const a = await activity.read(req, {});
      expect(a.items[0]).toMatchObject({
        status: "COMPLETED",
        moneyMoved: "YES",
        verification: "VERIFIED",
        amountMinor: 8400,
        currency: "USD",
      });
      await activity.read(req, { operationId: s.proposalId });
      expect(await snapshot()).toBe(before);
      await revoke();
      const after = await snapshot();
      await activity.read(req, {});
      await controls.list(req, {});
      await get("/api/activation/activity");
      expect(await snapshot()).toBe(after);
      expect([s.provider.createCalls, s.provider.captureCalls]).toEqual(calls);
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        status: "COMPLETED",
        moneyMoved: "YES",
      });
      expect(
        (
          await repo.sql`select status from payment_attempts where id=${s.attemptId!}`
        )[0],
      ).toMatchObject({ status: "CAPTURED" });
      const prior = JSON.parse(before) as { evidence: unknown[] }[],
        current = JSON.parse(after) as { evidence: unknown[] }[];
      expect(current[0]!.evidence.slice(0, -1)).toEqual(prior[0]!.evidence);
    });
    it("ALLOW and proposal pending states are projections, not evidence of payment", async () => {
      await s.seal();
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        status: "PROPOSED",
        moneyMoved: "UNKNOWN",
        verification: "INCOMPLETE",
      });
      await s.authorize();
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        status: "ALLOWED",
        decision: "ALLOW",
        moneyMoved: "UNKNOWN",
      });
    });
    it("payer action remains pending and reads have zero dispatch", async () => {
      await expect(s.execute()).rejects.toThrow();
      const before = await snapshot();
      const calls = s.provider.createCalls;
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        status: "PENDING",
        moneyMoved: "UNKNOWN",
      });
      expect(await snapshot()).toBe(before);
      expect(s.provider.createCalls).toBe(calls);
      expect(s.provider.captureCalls).toBe(0);
    });
    it("lost capture remains UNKNOWN even if fake provider actually captured", async () => {
      s.provider.payer = false;
      s.provider.loseCapture = true;
      await expect(s.execute()).rejects.toThrow();
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        status: "UNKNOWN_FINANCIAL_OUTCOME",
        moneyMoved: "UNKNOWN",
        verification: "UNKNOWN_FINANCIAL_OUTCOME",
      });
    });
    it("definitive rejection projects proven no-effect, never a successful payment", async () => {
      vi.spyOn(s.provider, "createOrder").mockRejectedValue(
        new PayPalProviderError(
          "DEFINITIVE_REJECTION",
          "sensitive-provider-message",
        ),
      );
      await expect(s.execute()).rejects.toThrow();
      const result = await activity.read(req, {});
      expect(result.items[0]).toMatchObject({
        status: "FAILED",
        moneyMoved: "NO",
        verification: "VERIFIED",
      });
      expect(JSON.stringify(result)).not.toContain(
        "sensitive-provider-message",
      );
    });
    it("missing retained verification keys stays INCOMPLETE, never upgrades to success", async () => {
      s.provider.payer = false;
      await s.execute();
      const missing = new ConsoleActivity(
        repo,
        sessions,
        new StaticPublicKeyRing(new Map()),
        clock,
      );
      expect((await missing.read(req, {})).items[0]).toMatchObject({
        verification: "INCOMPLETE",
        moneyMoved: "UNKNOWN",
      });
    });
    it.each([
      "?operationId=",
      "?operationId=x&operationId=y",
      "?principalId=commerce-p",
      "?operationId=" + "x".repeat(129),
    ])("malformed Activity selector %s fails closed", async (query) =>
      expect((await get("/api/activation/activity" + query)).status).toBe(400),
    );
    it("unauthenticated read and authority-list input injection fail closed", async () => {
      expect((await fetch(origin + "/api/activation/activity")).status).toBe(
        400,
      );
      expect(
        (await get("/api/activation/authorities?state=ACTIVE")).status,
      ).toBe(400);
    });
    it("durable Activity response contains bounded references only", async () => {
      s.provider.payer = false;
      await s.execute();
      const r = await get("/api/activation/activity");
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const text = await r.text();
      expect(text).not.toMatch(
        /signedToken|resumeSecret|csrfToken|bootstrapCode|privateKey|payerActionUrl|purchaseUnits|access_token/,
      );
    });
    it("durable DENY uses accepted receipt and proves pre-execution no effect", async () => {
      await s.seal();
      await s.authorizer.authorizeProposal(s.proposalId!, "HIGH", s.time);
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        decision: "DENY",
        status: "DENIED",
        moneyMoved: "NO",
      });
      expect(s.provider.createCalls).toBe(0);
    });
    it("durable ESCALATE requires approval without implying money moved", async () => {
      const m = {
        ...checkoutAuthority().mandate,
        id: "escalating-m",
        nonce: "escalating-mandate-nonce",
        autonomousPurchaseThresholdMinor: 7000,
      };
      await repo.saveMandate(m);
      const other = new VerticalSession(
        repo,
        undefined,
        undefined,
        undefined,
        m.id,
      );
      await other.seal();
      await other.authorizer.authorizeProposal(
        other.proposalId!,
        "LOW",
        other.time,
      );
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        decision: "ESCALATE",
        status: "ESCALATED",
        moneyMoved: "UNKNOWN",
      });
    });
    it("accepted verifier INVALID result is preserved without provider or database mutation", async () => {
      s.provider.payer = false;
      await s.execute();
      const events = await repo.evidence();
      vi.spyOn(repo, "evidence").mockResolvedValue(
        events.map((e, i) => (i ? e : { ...e, hash: "f".repeat(64) })),
      );
      const before = await snapshot();
      expect((await activity.read(req, {})).items[0]).toMatchObject({
        verification: "INVALID",
        moneyMoved: "UNKNOWN",
        status: "INCOMPLETE",
      });
      expect(await snapshot()).toBe(before);
    });
    it("authority listing is bounded and authenticated, never widened by browser state", async () => {
      const m = checkoutAuthority().mandate;
      for (let i = 0; i < 22; i++)
        await repo.saveMandate({
          ...m,
          id: "extra-" + i,
          nonce: "extra-mandate-nonce-" + i,
        });
      const r = await controls.list(req, {});
      expect(r.items).toHaveLength(20);
      await expect(
        controls.list(req, { principalId: "other" }),
      ).rejects.toThrow();
    });
  },
);
