import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  DelegatedCommerceService,
  type DelegatedOutcome,
} from "../src/delegated-commerce.js";
import { FakeCommerceRanker } from "../src/commerce-discovery.js";
import { mandateFingerprint } from "../src/canonical.js";
import { demoCommerceCatalog } from "../src/demo-commerce-catalog.js";
import type { Mandate, TransactionProposal } from "../src/domain.js";
import { VerticalSession } from "./m4-vertical-fixture.js";
import { checkoutAuthority, checkoutNow } from "./checkout-fixture.js";
import { discoveryOffer, discoveryQuery } from "./discovery-fixture.js";

const url = process.env.TEST_DATABASE_URL;

/** The M6 hero Authority: one new keyboard, approved merchant only, maximum $100, delegated. */
function heroMandate(over: Partial<Mandate> = {}): Mandate {
  const base = checkoutAuthority().mandate;
  return {
    ...base,
    maxSingleTransactionMinor: 10000,
    cumulativeLimitMinor: 10000,
    autonomousPurchaseThresholdMinor: 10000,
    humanApprovalThresholdMinor: 10000,
    ...over,
  };
}

(url ? describe : describe.skip)(
  "M6 delegated / human-not-present commerce (PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository;
    let s: VerticalSession;
    let svc: DelegatedCommerceService;
    const serviceFor = (session: VerticalSession) =>
      new DelegatedCommerceService({
        discovery: session.discovery,
        checkout: session.checkout,
        authorizer: session.authorizer,
        issuer: session.issuer,
        boundary: session.boundary,
        merchantRisk: "LOW",
        clock: () => session.time,
      });
    async function provision(
      over: Partial<Mandate> = {},
      agentStatus?: string,
    ) {
      const f = checkoutAuthority();
      const mandate = heroMandate(over);
      await repo.savePrincipal({
        id: mandate.principalId,
        displayName: "Human",
      });
      await repo.saveAgent({
        ...f.agent,
        ...(agentStatus ? { status: agentStatus as "SUSPENDED" } : {}),
      });
      await repo.saveMandate(mandate);
      await s.checkout.registerMerchantBinding();
      return mandate;
    }
    const attempt = (service = svc, session = s) =>
      service.attempt({
        mandateId: session.mandateId,
        query: discoveryQuery,
        ranker: new FakeCommerceRanker(),
      });
    async function effects() {
      const [r] = await repo.sql`select
        (select count(*) from transaction_proposals) proposals,
        (select count(*) from decision_receipts) receipts,
        (select count(*) from authorization_reservations) reservations,
        (select count(*) from execution_grants) grants,
        (select count(*) from payment_attempts) attempts,
        (select count(*) from payment_resume_capabilities) resumes,
        (select count(*) from evidence_events where type='PAYMENT_RESUME_AUTHENTICATED') humanResumes`;
      return Object.fromEntries(
        Object.entries(r!).map(([k, v]) => [k, Number(v)]),
      ) as Record<string, number>;
    }
    /** Money-moving provider calls. Read-only GETs are intentionally not counted. */
    const providerEffects = (...sessions: VerticalSession[]) => ({
      creates: sessions.reduce((n, x) => n + x.provider.createCalls, 0),
      captures: sessions.reduce((n, x) => n + x.provider.captureCalls, 0),
    });
    const expectNoEffect = async (...sessions: VerticalSession[]) => {
      expect(providerEffects(...sessions)).toEqual({ creates: 0, captures: 0 });
      const e = await effects();
      expect(e.grants).toBe(0);
      expect(e.attempts).toBe(0);
      expect(e.reservations).toBe(0);
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile(`db/migrations/${name}`, "utf8"));
    });
    afterAll(async () => repo?.close());
    beforeEach(async () => {
      await repo.sql`truncate principals,evidence_events,commerce_merchant_bindings restart identity cascade`;
      s = new VerticalSession(repo);
      s.provider.payer = false; // the delegated instrument is pre-approved: orders are born APPROVED
      svc = serviceFor(s);
    });

    describe("valid delegated purchase", () => {
      it("$84 inside the Authority completes with no human step and exactly one capture", async () => {
        await provision();
        const out = await attempt();
        expect(out.status).toBe("COMPLETED");
        expect(out).toMatchObject({
          askedHuman: false,
          providerEffect: "CAPTURED",
        });
        expect(providerEffects(s)).toEqual({ creates: 1, captures: 1 });
        const e = await effects();
        expect(e).toMatchObject({
          proposals: 1,
          receipts: 1,
          reservations: 1,
          grants: 1,
          attempts: 1,
          resumes: 0,
          humanresumes: 0,
        });
        const [res] =
          await repo.sql`select status,amount_minor from authorization_reservations`;
        expect(res).toMatchObject({ status: "COMMITTED" });
        expect(Number(res!.amount_minor)).toBe(8400);
        const [g] = await repo.sql`select status from execution_grants`;
        expect(g!.status).toBe("CONSUMED");
        const [a] =
          await repo.sql`select status,provider_capture_id from payment_attempts`;
        expect(a).toMatchObject({ status: "CAPTURED" });
        const trace = await s.trace.project(
          { proposalId: out.proposalId },
          s.time,
        );
        expect(trace.status).toBe("VERIFIED");
        expect(trace.financialOutcome).toBe("CAPTURED");
        expect(trace.authorityMeter.financial.committedMinor).toBe(8400);
        expect(trace.authorityMeter.financial.remainingMinor).toBe(1600);
      });

      it("a second identical delegated request cannot consume more than the Authority allows", async () => {
        await provision();
        expect((await attempt()).status).toBe("COMPLETED");
        // New selection, new proposal: quantity 1 and the $100 budget are exhausted.
        const again = await attempt();
        expect(["DENIED", "REFUSED"]).toContain(again.status);
        expect(providerEffects(s)).toEqual({ creates: 1, captures: 1 });
        const [c] =
          await repo.sql`select count(*) n from authorization_reservations where status='COMMITTED'`;
        expect(Number(c!.n)).toBe(1);
      });

      it("terminal retry, duplicate return and repeated reconciliation add no capture", async () => {
        await provision();
        await attempt();
        const [a] = await repo.sql`select id from payment_attempts`;
        for (let i = 0; i < 3; i++)
          expect(await s.rail.reconcile(String(a!.id), s.time)).toBe(
            "CAPTURED",
          );
        expect(providerEffects(s).captures).toBe(1);
      });
    });

    describe("outside the Authority: zero provider effect", () => {
      it("price drift: a trusted $184 price against a $100 maximum is refused before any proposal", async () => {
        await provision();
        const catalog = demoCommerceCatalog();
        catalog.offers[0]!.unitPrice.minor = 18400;
        const drift = new VerticalSession(repo, [discoveryOffer()], catalog);
        drift.provider.payer = false;
        const out = await attempt(serviceFor(drift), drift);
        expect(out).toMatchObject({
          status: "REFUSED",
          code: "AMOUNT_EXCEEDS_LIMIT",
          providerEffect: "NONE",
        });
        expect(providerEffects(drift)).toEqual({ creates: 0, captures: 0 });
        expect((await effects()).proposals).toBe(0);
        await expectNoEffect(drift);
      });

      it("a request above the autonomous threshold is not delegated: NEEDS_HUMAN with no reservation or grant", async () => {
        await provision({ autonomousPurchaseThresholdMinor: 5000 });
        const out = await attempt();
        expect(out).toMatchObject({
          status: "NEEDS_HUMAN",
          askedHuman: false,
          providerEffect: "NONE",
        });
        await expectNoEffect(s);
        expect((await effects()).receipts).toBe(1);
      });

      it("a used item is never reached: selection refuses and nothing is dispatched", async () => {
        await provision();
        const used = new VerticalSession(repo, [{ ...discoveryOffer(2) }]);
        used.provider.payer = false;
        const out = await attempt(serviceFor(used), used);
        expect(out.status).toBe("REFUSED");
        await expectNoEffect(used);
      });

      it("quantity widening: two keyboards against a one-item Authority are not executed", async () => {
        await provision();
        const two = await svc.attempt({
          mandateId: s.mandateId,
          query: { ...discoveryQuery, quantity: 2 },
          ranker: new FakeCommerceRanker(),
        });
        expect(["DENIED", "REFUSED"]).toContain(two.status);
        await expectNoEffect(s);
      });
    });

    describe("kernel denials for proposals that bypass discovery (external agents, later milestones)", () => {
      const proposal = (
        over: Partial<TransactionProposal> = {},
      ): TransactionProposal => ({
        id: "proposal-direct-0001",
        agentId: "commerce-a",
        mandateId: "commerce-m",
        mandateFingerprint: mandateFingerprint(heroMandate()),
        amount: { currency: "USD", minor: 8400 },
        quantity: 1,
        merchant: { id: "payflow.demo.merchant", displayName: "Demo merchant" },
        category: "KEYBOARD",
        condition: "NEW",
        requestedCapability: "CAPTURE_PAYMENT",
        proposedAt: checkoutNow,
        nonce: "direct-proposal-nonce-0001",
        metadata: {},
        ...over,
      });
      const cases: [string, Partial<TransactionProposal>, string][] = [
        [
          "$184 over the $100 maximum",
          { amount: { currency: "USD", minor: 18400 } },
          "AMOUNT_EXCEEDS_LIMIT",
        ],
        ["used condition", { condition: "USED" }, "CONDITION_DENIED"],
        [
          "refurbished condition",
          { condition: "REFURBISHED" },
          "CONDITION_DENIED",
        ],
        [
          "wrong merchant",
          { merchant: { id: "evil.merchant", displayName: "Evil" } },
          "MERCHANT_NOT_ALLOWED",
        ],
        ["wrong product category", { category: "LAPTOP" }, "CATEGORY_DENIED"],
        ["quantity widening", { quantity: 2 }, "QUANTITY_EXHAUSTED"],
        [
          "wrong currency",
          { amount: { currency: "EUR", minor: 8400 } },
          "CURRENCY_MISMATCH",
        ],
        [
          "capability outside the Authority",
          { requestedCapability: "REQUEST_REFUND" },
          "CAPABILITY_DENIED",
        ],
      ];
      it.each(cases)(
        "%s is denied with no reservation, grant or provider call",
        async (_name, over, code) => {
          await provision();
          await repo.saveProposal(proposal(over));
          const r = await s.authorizer.authorizeProposal(
            "proposal-direct-0001",
            "LOW",
            checkoutNow,
          );
          expect(r.receipt.decision).toBe("DENY");
          expect(r.receipt.reasonCodes).toContain(code);
          expect(r.reservation).toBeNull();
          await expectNoEffect(s);
        },
      );
      it("a stale proposal fingerprint (Authority changed) is denied", async () => {
        await provision();
        await repo.saveProposal(
          proposal({ mandateFingerprint: "0".repeat(64) }),
        );
        const r = await s.authorizer.authorizeProposal(
          "proposal-direct-0001",
          "LOW",
          checkoutNow,
        );
        expect(r.receipt.decision).toBe("DENY");
        expect(r.receipt.reasonCodes).toContain("MANDATE_INTEGRITY_FAILURE");
        await expectNoEffect(s);
      });
    });

    describe("Authority unavailable: no new dispatch", () => {
      it("revoked Authority", async () => {
        await provision();
        await repo.revokeMandate(s.mandateId, checkoutNow);
        const out = await attempt();
        expect(out.status).toBe("REFUSED");
        await expectNoEffect(s);
      });
      it("expired Authority", async () => {
        await provision({ expiresAt: "2026-10-10T00:00:00.000Z" });
        const out = await attempt();
        expect(["REFUSED", "DENIED"]).toContain(out.status);
        await expectNoEffect(s);
      });
      it("suspended Agent", async () => {
        await provision({}, "SUSPENDED");
        const out = await attempt();
        expect(["REFUSED", "DENIED"]).toContain(out.status);
        await expectNoEffect(s);
      });
    });

    describe("changes between authorization and dispatch (immediate revalidation)", () => {
      /** Issues the grant, runs a hook (the race), then lets the real boundary decide. */
      const racing = (hook: () => Promise<void>) => {
        const issuer = Object.create(s.issuer) as typeof s.issuer;
        issuer.issue = async (reservationId: string, now: string) => {
          const token = await s.issuer.issue(reservationId, now);
          await hook();
          return token;
        };
        return new DelegatedCommerceService({
          discovery: s.discovery,
          checkout: s.checkout,
          authorizer: s.authorizer,
          issuer,
          boundary: s.boundary,
          merchantRisk: "LOW",
          clock: () => s.time,
        });
      };
      it("revoked after the grant, before dispatch: no provider effect and history is preserved", async () => {
        await provision();
        const out = await attempt(
          racing(() => repo.revokeMandate(s.mandateId, s.time)),
        );
        expect(out.status).toBe("REFUSED");
        expect(out).toMatchObject({ providerEffect: "NONE" });
        expect(providerEffects(s)).toEqual({ creates: 0, captures: 0 });
        const [ev] =
          await repo.sql`select count(*) n from evidence_events where type='MANDATE_REVOKED'`;
        expect(Number(ev!.n)).toBe(1);
        const [r] =
          await repo.sql`select status from authorization_reservations`;
        expect(r!.status).not.toBe("COMMITTED");
      });
      it("Agent suspended after the grant, before dispatch", async () => {
        await provision();
        const out = await attempt(
          racing(async () => {
            await repo.sql`update agent_passports set status='SUSPENDED'`.catch(
              async () => {
                await repo.sql`update agents set status='SUSPENDED'`;
              },
            );
          }),
        );
        expect(out.status).toBe("REFUSED");
        expect(providerEffects(s)).toEqual({ creates: 0, captures: 0 });
      });
      it("Authority expires after the grant, before dispatch", async () => {
        const expires = new Date(
          Date.parse(checkoutNow) + 60_000,
        ).toISOString();
        await provision({ expiresAt: expires });
        const out = await attempt(
          racing(async () => {
            s.time = new Date(Date.parse(expires) + 1).toISOString();
            await Promise.resolve();
          }),
        );
        expect(out.status).toBe("REFUSED");
        expect(providerEffects(s)).toEqual({ creates: 0, captures: 0 });
      });
    });

    describe("one-time grants and replay", () => {
      async function granted() {
        await provision();
        const sel = await s.discovery.selectForCheckout(
          s.mandateId,
          discoveryQuery,
          new FakeCommerceRanker(),
        );
        const q = await s.discovery.quoteSelection(sel);
        const m = await s.checkout.sealManifest(q.quoteId);
        const p = await s.checkout.compileManifestProposal(m.manifestId);
        const r = await s.authorizer.authorizeProposal(p.id, "LOW", s.time);
        const token = await s.issuer.issue(r.reservation!.id, s.time);
        return { token, p, r };
      }
      it("a grant executes once; replay is refused and adds no capture", async () => {
        const { token } = await granted();
        await s.boundary.execute(token, s.time);
        expect(providerEffects(s).captures).toBe(1);
        await expect(s.boundary.execute(token, s.time)).rejects.toThrow(
          "EXECUTION_GRANT_CONSUMED",
        );
        await expect(s.boundary.execute(token, s.time)).rejects.toThrow();
        expect(providerEffects(s)).toEqual({ creates: 1, captures: 1 });
      });
      it("expired, tampered and re-scoped grants are refused with no provider call", async () => {
        const { token } = await granted();
        const [payload, sig] = token.split(".");
        const claims = JSON.parse(
          Buffer.from(payload!, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        const forge = (c: Record<string, unknown>) =>
          Buffer.from(JSON.stringify(c)).toString("base64url") + "." + sig;
        await expect(
          s.boundary.execute(
            token,
            new Date(Date.parse(s.time) + 10 * 60_000).toISOString(),
          ),
        ).rejects.toThrow("EXECUTION_GRANT_EXPIRED");
        for (const patch of [
          { amountMinor: 1 },
          { amountMinor: 99999 },
          { agentId: "other-agent" },
          { mandateId: "other-mandate" },
          { merchantId: "evil.merchant" },
          { proposalId: "other-proposal" },
        ])
          await expect(
            s.boundary.execute(forge({ ...claims, ...patch }), s.time),
          ).rejects.toThrow("INVALID_GRANT_SIGNATURE");
        expect(providerEffects(s)).toEqual({ creates: 0, captures: 0 });
        // The genuine grant is still intact and usable exactly once afterwards.
        await s.boundary.execute(token, s.time);
        expect(providerEffects(s).captures).toBe(1);
      });
      it("no raw grant token is present in the outcome", async () => {
        await provision();
        const out = await attempt();
        expect(JSON.stringify(out)).not.toMatch(/ey[A-Za-z0-9_-]{20,}\./);
      });
    });

    describe("concurrency: no overconsumption", () => {
      it("competing delegated attempts against a one-keyboard, $100 Authority produce exactly one capture", async () => {
        await provision();
        const sessions = [
          s,
          new VerticalSession(repo),
          new VerticalSession(repo),
          new VerticalSession(repo),
        ];
        for (const x of sessions) x.provider.payer = false;
        const outs = await Promise.all(
          sessions.map((x) => attempt(serviceFor(x), x)),
        );
        expect(outs.filter((o) => o.status === "COMPLETED")).toHaveLength(1);
        expect(providerEffects(...sessions).captures).toBe(1);
        const [c] =
          await repo.sql`select count(*) n, coalesce(sum(amount_minor),0) total from authorization_reservations where status in ('COMMITTED','AUTHORIZED','EXECUTING')`;
        expect(Number(c!.n)).toBeLessThanOrEqual(1);
        expect(Number(c!.total)).toBeLessThanOrEqual(10000);
        for (const o of outs.filter((x) => x.status !== "COMPLETED"))
          expect((o as DelegatedOutcome).providerEffect).toBe("NONE");
      });
      it("budget (not quantity) is the binding limit: two $84 purchases cannot both fit $100", async () => {
        await provision({ quantityLimit: 2 }); // quantity would allow two; the $100 budget cannot
        const sessions = [s, new VerticalSession(repo)];
        for (const x of sessions) x.provider.payer = false;
        const outs = await Promise.all(
          sessions.map((x) => attempt(serviceFor(x), x)),
        );
        expect(outs.filter((o) => o.status === "COMPLETED")).toHaveLength(1);
        expect(providerEffects(...sessions).captures).toBe(1);
        const [t] =
          await repo.sql`select coalesce(sum(amount_minor),0) total from authorization_reservations where status <> 'RELEASED'`;
        expect(Number(t!.total)).toBeLessThanOrEqual(10000);
      });
    });

    describe("provider ambiguity: never retried, reconciled truthfully", () => {
      it("a lost capture response is UNRESOLVED, then reconciles to one capture", async () => {
        await provision();
        s.provider.loseCapture = true;
        const out = await attempt();
        expect(out).toMatchObject({
          status: "UNRESOLVED",
          providerEffect: "UNKNOWN",
          askedHuman: false,
        });
        expect(providerEffects(s).captures).toBe(1);
        const mid = await s.trace.project(
          { proposalId: out.proposalId! },
          s.time,
        );
        expect(mid.status).toBe("UNKNOWN_FINANCIAL_OUTCOME");
        const [a] = await repo.sql`select id from payment_attempts`;
        expect(await s.rail.reconcile(String(a!.id), s.time)).toBe("CAPTURED");
        expect(providerEffects(s).captures).toBe(1);
        expect(
          (
            await s.trace.project(
              { proposalId: (out as { proposalId: string }).proposalId },
              s.time,
            )
          ).status,
        ).toBe("VERIFIED");
      });
      it("a lost order-create response is recovered with the same order and one capture", async () => {
        await provision();
        s.provider.loseCreate = true;
        const out = await attempt();
        expect(out.status).toBe("UNRESOLVED");
        expect(providerEffects(s).captures).toBe(0);
        const [a] = await repo.sql`select id from payment_attempts`;
        expect(await s.rail.reconcile(String(a!.id), s.time)).toBe("CAPTURED");
        expect(s.provider.uniqueOrders).toBe(1);
        expect(providerEffects(s).captures).toBe(1);
      });
      it("an instrument that is not pre-approved cannot complete delegated: no capture and no human prompt", async () => {
        await provision();
        s.provider.payer = true; // PAYER_ACTION_REQUIRED
        const out = await attempt();
        expect(out.status).not.toBe("COMPLETED");
        expect(providerEffects(s).captures).toBe(0);
        expect((await effects()).humanresumes).toBe(0);
      });
    });

    describe("evidence", () => {
      it("every denied, refused and completed path leaves an intact evidence chain", async () => {
        await provision();
        await attempt();
        await attempt();
        const events = await repo.evidence();
        expect(events.length).toBeGreaterThan(0);
        const seqs = events.map((e) => e.sequence);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
      });
    });
  },
);
