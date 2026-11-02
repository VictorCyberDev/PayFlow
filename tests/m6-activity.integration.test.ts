import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  ConsoleSessions,
  type ConsoleRequest,
} from "../src/console-session.js";
import { ConsoleActivity } from "../src/activity-postgres.js";
import { StaticPublicKeyRing } from "../src/execution-grant.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import { VerticalSession } from "./m4-vertical-fixture.js";
import { discoveryOffer } from "./discovery-fixture.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M6 Activity: delegated completion and proven zero-effect refusals (PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository,
      s: VerticalSession,
      activity: ConsoleActivity,
      req: ConsoleRequest;
    const origin = "http://127.0.0.1:4010";
    const bootstrap = "m6-activity-bootstrap-".repeat(3);
    const clock = () => new Date(s.time);
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
    beforeEach(async () => {
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      s = new VerticalSession(repo);
      s.provider.payer = false;
      await s.provision();
      const sessions = new ConsoleSessions(
        { principalId: "commerce-p", origin, bootstrapKey: bootstrap },
        clock,
      );
      const base = { host: new URL(origin).host, origin };
      const login = sessions.login(base, { bootstrapCode: bootstrap });
      req = {
        ...base,
        cookie: login.cookie.split(";")[0]!,
        csrf: login.view.csrfToken,
      };
      activity = new ConsoleActivity(
        repo,
        sessions,
        new StaticPublicKeyRing(new Map([["m4f", s.keys.publicKey]])),
        clock,
      );
    });

    it("a completed purchase with no human resume is delegated; a human-resumed one is not", async () => {
      await s.execute();
      const done = (await activity.read(req, {})).items[0]!;
      expect(done).toMatchObject({
        status: "COMPLETED",
        moneyMoved: "YES",
        delegated: true,
        decision: "ALLOW",
      });
    });

    it("a payer-approved (human present) purchase is never labelled delegated", async () => {
      s.provider.payer = true;
      await expect(s.execute()).rejects.toThrow();
      await s.prepare();
      const events = await repo.evidence();
      s.time = new Date(
        Math.max(
          Date.parse(s.time),
          ...events.map((e) => Date.parse(e.occurredAt)),
        ) + 1,
      ).toISOString();
      s.provider.approve();
      await s.resume();
      const item = (await activity.read(req, {})).items[0]!;
      expect(item).toMatchObject({
        status: "COMPLETED",
        moneyMoved: "YES",
        delegated: false,
      });
    });

    async function refuse() {
      await s.select();
      const catalog = demoCommerceCatalog();
      catalog.offers[0]!.unitPrice.minor = 18400;
      const next = new VerticalSession(repo, [discoveryOffer()], catalog);
      await expect(
        next.discovery.quoteSelection(s.selectionId!),
      ).rejects.toThrow("AMOUNT_EXCEEDS_LIMIT");
      return next;
    }

    it("a $184 trusted-price refusal appears in Activity as $0 moved with no proposal, reservation, grant or provider call", async () => {
      const next = await refuse();
      const { items } = await activity.read(req, {});
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        operationId: s.selectionId,
        status: "DENIED",
        decision: "DENY",
        moneyMoved: "NO",
        delegated: false,
        amountMinor: 18400,
        currency: "USD",
      });
      expect(items[0]!.references).toEqual({
        paymentAttemptId: null,
        providerOrderId: null,
        providerCaptureId: null,
      });
      expect(
        next.provider.createCalls +
          next.provider.captureCalls +
          s.provider.createCalls +
          s.provider.captureCalls,
      ).toBe(0);
      for (const t of [
        "transaction_proposals",
        "authorization_reservations",
        "execution_grants",
        "payment_attempts",
      ])
        expect(
          Number((await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n),
        ).toBe(0);
    });

    it("the refusal is retrievable by its id, owner-bound, and newest-first with real purchases", async () => {
      await s.execute();
      await refuse();
      const all = (await activity.read(req, {})).items;
      expect(all).toHaveLength(2);
      expect(all.map((i) => i.occurredAt)).toEqual(
        [...all.map((i) => i.occurredAt)].sort().reverse(),
      );
      const one = await activity.read(req, { operationId: s.selectionId });
      expect(one.items[0]!.moneyMoved).toBe("NO");
      await expect(
        activity.read(req, {
          operationId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow();
      await expect(
        activity.read(req, { operationId: "not-a-uuid" }),
      ).rejects.toThrow();
    });

    it("another owner cannot see the refusal", async () => {
      await refuse();
      const other = new ConsoleSessions(
        { principalId: "someone-else", origin, bootstrapKey: bootstrap },
        clock,
      );
      const base = { host: new URL(origin).host, origin };
      const login = other.login(base, { bootstrapCode: bootstrap });
      const foreign = {
        ...base,
        cookie: login.cookie.split(";")[0]!,
        csrf: login.view.csrfToken,
      };
      const a = new ConsoleActivity(
        repo,
        other,
        new StaticPublicKeyRing(new Map()),
        clock,
      );
      expect((await a.read(foreign, {})).items).toEqual([]);
    });
  },
);
