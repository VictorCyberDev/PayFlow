/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { MISSIONS, idemKey } from "./helpers/mission-fixtures.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { talentMission } from "./helpers/talent.js";
import {
  OfferTermsSchema,
  canMoveOffer,
  checkProblems,
  checkStanding,
  termsProblems,
  totalOf,
  type CheckFact,
  type OfferStatus,
} from "../src/missions/talent-offers.js";
import type { Role } from "../src/missions/shortlist.js";
import { TalentScopeSchema } from "../src/missions/talent-scope.js";
import { scopeDoc } from "./helpers/talent.js";

/**
 * V3 M49 — checks, offers and contracts. Checks are a person's findings; an offer is approved only when the scope's required checks have
 * passed; a person sends it and records the answer; PayFlow sends nothing; acceptance commits each milestone in the ledger.
 */
const url = process.env.TEST_DATABASE_URL;
const NOW = "2026-10-23T10:00:00.000Z";
const role = (over: Record<string, unknown> = {}): Role =>
  TalentScopeSchema.parse(
    scopeDoc({
      roles: [
        { ...(scopeDoc().roles as Record<string, unknown>[])[0]!, ...over },
      ],
    }),
  ).roles[0]!;
const terms = (over: Record<string, unknown> = {}) =>
  OfferTermsSchema.parse({
    currency: "USD",
    startDate: "2026-10-26",
    endDate: "2026-11-13",
    milestones: [
      { title: "Landing page", amountMinor: 15_000, dueDate: "2026-11-02" },
      { title: "Design system", amountMinor: 20_000, dueDate: "2026-11-13" },
    ],
    expiresAt: "2026-11-05T10:00:00.000Z",
    ...over,
  });
const problems = (
  t = terms(),
  r = role(),
  scopeExpires = "2026-11-20T10:00:00.000Z",
) => termsProblems(t, r, "USD", scopeExpires, NOW);

describe("M49 checks and terms (pure)", () => {
  it("the latest finding per required check counts; missing and failed are named", () => {
    const f = (
      seq: number,
      kind: CheckFact["kind"],
      result: CheckFact["result"],
    ): CheckFact => ({ seq, kind, result });
    const req = ["IDENTITY_VERIFIED", "PORTFOLIO_REVIEWED"] as const;
    expect(checkProblems(req, [])).toEqual([
      "CHECK_MISSING:IDENTITY_VERIFIED",
      "CHECK_MISSING:PORTFOLIO_REVIEWED",
    ]);
    expect(
      checkProblems(req, [
        f(1, "IDENTITY_VERIFIED", "PASSED"),
        f(2, "PORTFOLIO_REVIEWED", "PASSED"),
      ]),
    ).toEqual([]);
    expect(
      checkProblems(req, [
        f(1, "IDENTITY_VERIFIED", "FAILED"),
        f(2, "PORTFOLIO_REVIEWED", "PASSED"),
      ]),
    ).toEqual(["CHECK_FAILED:IDENTITY_VERIFIED"]);
    // a later finding replaces an earlier one, either way, whatever order they are given in
    expect(
      checkProblems(req, [
        f(3, "IDENTITY_VERIFIED", "PASSED"),
        f(1, "IDENTITY_VERIFIED", "FAILED"),
        f(2, "PORTFOLIO_REVIEWED", "PASSED"),
      ]),
    ).toEqual([]);
    expect(
      checkProblems(req, [
        f(1, "IDENTITY_VERIFIED", "PASSED"),
        f(4, "IDENTITY_VERIFIED", "FAILED"),
        f(2, "PORTFOLIO_REVIEWED", "PASSED"),
      ]),
    ).toEqual(["CHECK_FAILED:IDENTITY_VERIFIED"]);
    // a check the scope does not require is ignored
    expect(
      checkStanding(
        ["IDENTITY_VERIFIED"],
        [
          f(1, "REFERENCES_CHECKED", "FAILED"),
          f(2, "IDENTITY_VERIFIED", "PASSED"),
        ],
      ),
    ).toEqual({ IDENTITY_VERIFIED: "PASSED" });
  });

  it("every fault in the terms has its own code, and the edges are inclusive where they should be", () => {
    expect(problems()).toEqual([]);
    expect(totalOf(terms())).toBe(35_000);
    expect(problems(terms({ currency: "EUR" }))).toEqual(["CURRENCY_MISMATCH"]);
    expect(problems(terms({ endDate: "2026-10-25" }))).toEqual([
      "ENDS_BEFORE_START",
      "MILESTONE_1_OUTSIDE_TERM",
      "MILESTONE_2_OUTSIDE_TERM",
    ]);
    expect(problems(terms({ startDate: "2026-11-02" }))).toEqual([]); // a milestone due on the first day is inside
    expect(problems(terms({ endDate: "2026-11-12" }))).toEqual([
      "MILESTONE_2_OUTSIDE_TERM",
    ]);
    const swapped = [
      { title: "b", amountMinor: 10_000, dueDate: "2026-11-13" },
      { title: "a", amountMinor: 10_000, dueDate: "2026-11-02" },
    ];
    expect(problems(terms({ milestones: swapped }))).toEqual([
      "MILESTONE_2_OUT_OF_ORDER",
    ]);
    const m = (n: number) => [
      { title: "all", amountMinor: n, dueDate: "2026-11-13" },
    ];
    expect(problems(terms({ milestones: m(40_000) }))).toEqual([]); // exactly the role's budget
    expect(problems(terms({ milestones: m(40_001) }))).toEqual([
      "ABOVE_ROLE_BUDGET",
    ]);
    expect(problems(terms({ expiresAt: NOW }))).toEqual([
      "OFFER_ALREADY_EXPIRED",
    ]);
    expect(problems(terms({ expiresAt: "2026-11-20T10:00:00.000Z" }))).toEqual(
      [],
    );
    expect(problems(terms({ expiresAt: "2026-11-20T10:00:01.000Z" }))).toEqual([
      "OUTLIVES_SCOPE",
    ]);
    expect(problems(terms({ hourlyRateMinor: 5_000 }))).toEqual([
      "RATE_ONLY_FOR_HOURLY_ROLES",
    ]);
    const hourly = role({
      engagement: "HOURLY",
      maxHourlyRateMinor: 9_000,
      maxHoursPerWeek: 30,
    });
    expect(problems(terms(), hourly)).toEqual(["HOURLY_RATE_REQUIRED"]);
    expect(
      problems(terms({ hourlyRateMinor: 9_000, hoursPerWeek: 30 }), hourly),
    ).toEqual([]);
    expect(
      problems(terms({ hourlyRateMinor: 9_001, hoursPerWeek: 31 }), hourly),
    ).toEqual(["RATE_ABOVE_MAXIMUM", "HOURS_ABOVE_MAXIMUM"]);
    expect(() => terms({ milestones: [] })).toThrow();
    expect(() => terms({ startDate: "2026-02-30" })).toThrow();
    expect(() => terms({ extra: 1 })).toThrow();
  });

  it("the offer's life only moves forward and every end is final", () => {
    const all: OfferStatus[] = [
      "DRAFT",
      "APPROVED",
      "SENT",
      "ACCEPTED",
      "DECLINED",
      "WITHDRAWN",
      "EXPIRED",
    ];
    const allowed = new Set([
      "DRAFT>APPROVED",
      "DRAFT>WITHDRAWN",
      "DRAFT>EXPIRED",
      "APPROVED>SENT",
      "APPROVED>WITHDRAWN",
      "APPROVED>EXPIRED",
      "SENT>ACCEPTED",
      "SENT>DECLINED",
      "SENT>WITHDRAWN",
      "SENT>EXPIRED",
    ]);
    for (const a of all)
      for (const b of all)
        expect(canMoveOffer(a, b)).toBe(allowed.has(`${a}>${b}`));
    // an offer cannot be accepted without having been sent
    expect(canMoveOffer("DRAFT", "ACCEPTED")).toBe(false);
    expect(canMoveOffer("APPROVED", "ACCEPTED")).toBe(false);
  });
});

(url ? describe : describe.skip)(
  "M49 offers (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const scene = async () => {
      const s = await talentMission(h);
      const imp = await body(
        await post(
          s.owner,
          `/v1/admin/org/missions/${s.id}/talent-candidates/import`,
          {
            sourceId: "payflow-sandbox-talent",
            roleId: "fe",
            idempotencyKey: idemKey("i"),
          },
        ),
      );
      const idOf = (handle: string) =>
        imp.imported.find((c: { handle: string }) => c.handle === handle)
          .candidateId as string;
      const sl = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/talent-shortlists`,
        {
          roleId: "fe",
          candidateIds: [idOf("sandbox-ada")],
          idempotencyKey: idemKey("s"),
        },
      );
      expect(sl.status).toBe(201);
      return { ...s, ada: idOf("sandbox-ada"), grace: idOf("sandbox-grace") };
    };
    const draft = (
      t: string,
      id: string,
      candidateId: string,
      over: Record<string, unknown> = {},
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/missions/${id}/talent-offers`, {
        candidateId,
        terms: JSON.parse(JSON.stringify(terms(over))),
        idempotencyKey: idemKey("o"),
      });
    const check = (
      t: string,
      id: string,
      candidateId: string,
      kind: string,
      result = "PASSED",
    ) =>
      post(t, `/v1/admin/org/missions/${id}/talent-checks`, {
        candidateId,
        kind,
        result,
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: `${kind}.pdf`,
        idempotencyKey: idemKey("c"),
      });
    const act = (t: string, offerId: string, what: string, b: unknown = {}) =>
      post(t, `/v1/admin/org/talent-offers/${offerId}/${what}`, b);

    it("only a shortlisted candidate can be offered, inside the role's limits; an agent with DRAFT may draft; one live offer per candidate", async () => {
      const s = await scene();
      const notSl = await draft(s.owner, s.id, s.grace);
      expect([notSl.status, (await body(notSl)).reason]).toEqual([
        422,
        "NOT_SHORTLISTED",
      ]);
      const bad = await draft(s.owner, s.id, s.ada, {
        milestones: [
          { title: "all", amountMinor: 40_001, dueDate: "2026-11-13" },
        ],
      });
      expect([bad.status, (await body(bad)).detail]).toEqual([
        422,
        "ABOVE_ROLE_BUDGET",
      ]);
      const noCap = await draft(s.b, s.id, s.ada, {}, "/v1/agent");
      expect([noCap.status, (await body(noCap)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      const ok = await draft(s.a, s.id, s.ada, {}, "/v1/agent");
      expect(ok.status).toBe(201);
      const o = (await body(ok)).offer;
      expect(o).toMatchObject({
        status: "DRAFT",
        totalMinor: 35_000,
        currency: "USD",
        draftedBy: "agent:a",
        contractId: null,
        notice: expect.stringContaining("not a party") as string,
      });
      const again = await draft(s.owner, s.id, s.ada);
      expect([again.status, (await body(again)).reason]).toEqual([
        409,
        "ALREADY_LIVE",
      ]);
      await expect(
        h.repo
          .sql`update mission_talent_offers set total_minor = 1 where offer_id = ${o.offerId}`,
      ).rejects.toThrow(/terms never change/);
    });

    it("approval needs every required check passed by a person; a later finding replaces an earlier one; agents record and approve nothing", async () => {
      const s = await scene();
      const o = (await body(await draft(s.owner, s.id, s.ada))).offer;
      expect((await act(s.a, o.offerId, "approve")).status).toBe(401);
      expect((await check(s.a, s.id, s.ada, "IDENTITY_VERIFIED")).status).toBe(
        401,
      );
      const none = await act(s.owner, o.offerId, "approve");
      expect([none.status, (await body(none)).detail]).toEqual([
        422,
        "CHECK_MISSING:IDENTITY_VERIFIED,CHECK_MISSING:PORTFOLIO_REVIEWED",
      ]);
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED", "FAILED");
      await check(s.owner, s.id, s.ada, "PORTFOLIO_REVIEWED");
      expect(
        (await body(await act(s.owner, o.offerId, "approve"))).detail,
      ).toBe("CHECK_FAILED:IDENTITY_VERIFIED");
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED", "PASSED");
      const st = await body(
        await get(
          s.a,
          `/v1/agent/missions/${s.id}/talent-candidates/${s.ada}/checks`,
        ),
      );
      expect(st.standing).toEqual({
        IDENTITY_VERIFIED: "PASSED",
        PORTFOLIO_REVIEWED: "PASSED",
      });
      const ok = await act(s.owner, o.offerId, "approve");
      expect((await body(ok)).offer.status).toBe("APPROVED");
      expect(
        (await body(await act(s.owner, o.offerId, "approve"))).replayed,
      ).toBe(true);
      await expect(
        h.repo.sql`update mission_talent_checks set result = 'PASSED'`,
      ).rejects.toThrow(/append-only/);
    });

    it("a person sends and records the answer; acceptance commits each milestone in the ledger and records the contract, once; nothing is paid", async () => {
      const s = await scene();
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED");
      await check(s.owner, s.id, s.ada, "PORTFOLIO_REVIEWED");
      const o = (await body(await draft(s.owner, s.id, s.ada))).offer;
      const early = await act(s.owner, o.offerId, "answer", {
        outcome: "ACCEPTED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "signed.pdf",
      });
      expect([early.status, (await body(early)).reason]).toEqual([
        409,
        "ILLEGAL_MOVE",
      ]); // not even approved yet
      await act(s.owner, o.offerId, "approve");
      expect(
        (
          await act(s.owner, o.offerId, "answer", {
            outcome: "ACCEPTED",
            evidenceKind: "DOCUMENT_REF",
          })
        ).status,
      ).toBe(409); // approved but not sent
      expect(
        (
          await body(
            await act(s.owner, o.offerId, "sent", { note: "emailed by Sam" }),
          )
        ).offer.status,
      ).toBe("SENT");
      const accept = await act(s.owner, o.offerId, "answer", {
        outcome: "ACCEPTED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "signed.pdf",
      });
      expect(accept.status, JSON.stringify(await accept.clone().json())).toBe(
        200,
      );
      const done = await body(accept);
      expect(done.offer.status).toBe("ACCEPTED");
      expect(done.contractId).toMatch(/^tct_[a-f0-9]{24}$/u);
      const items = await h.repo.sql<
        {
          kind: string;
          stage: string;
          amount_minor: string;
          verification: string;
        }[]
      >`select kind, stage, amount_minor, verification from mission_ledger_items where mission_id = ${s.id} order by amount_minor`;
      expect(
        items.map((i) => [i.kind, i.stage, i.amount_minor, i.verification]),
      ).toEqual([
        ["CONTRACTOR_MILESTONE", "COMMITTED", "15000", "OWNER_REPORTED"],
        ["CONTRACTOR_MILESTONE", "COMMITTED", "20000", "OWNER_REPORTED"],
      ]);
      expect(h.provider.captureCalls).toBe(0); // accepting pays no one
      const replay = await act(s.owner, o.offerId, "answer", {
        outcome: "ACCEPTED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "signed.pdf",
      });
      expect([replay.status, (await body(replay)).replayed]).toEqual([
        200,
        true,
      ]);
      const flip = await act(s.owner, o.offerId, "answer", {
        outcome: "DECLINED",
        evidenceKind: "DOCUMENT_REF",
      });
      expect([flip.status, (await body(flip)).reason]).toEqual([
        409,
        "ILLEGAL_MOVE",
      ]);
      const list = await body(
        await get(s.a, `/v1/agent/missions/${s.id}/talent-offers`),
      );
      expect(list.contracts).toHaveLength(1);
      expect(list.contracts[0]).toMatchObject({
        totalMinor: 35_000,
        currency: "USD",
      });
      expect(
        list.contracts[0].milestones.map(
          (m: { index: number; ledgerItemId: string }) => [
            m.index,
            typeof m.ledgerItemId,
          ],
        ),
      ).toEqual([
        [1, "string"],
        [2, "string"],
      ]);
      const led = await body(await get(s.owner, `${MISSIONS}/${s.id}/ledger`));
      expect(led.summary.exposureMinor).toBe(35_000);
    });

    it("a refusal or a withdrawal commits nothing; an acceptance the budget cannot hold is refused and leaves no contract", async () => {
      const s = await scene();
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED");
      await check(s.owner, s.id, s.ada, "PORTFOLIO_REVIEWED");
      const o = (await body(await draft(s.owner, s.id, s.ada))).offer;
      await act(s.owner, o.offerId, "approve");
      await act(s.owner, o.offerId, "sent");
      // eat the budget so the second milestone cannot fit: 150,000 - 2 x 60,000 = 30,000 left, the offer needs 35,000
      for (const label of ["a", "b"])
        expect(
          (
            await post(s.owner, `${MISSIONS}/${s.id}/ledger/items`, {
              kind: "GOODS",
              label,
              amountMinor: 60_000,
              currency: "USD",
              stage: "COMMITTED",
              verification: "OWNER_REPORTED",
              evidenceKind: "OWNER_REPORTED",
              idempotencyKey: idemKey("l"),
            })
          ).status,
        ).toBe(201);
      const refused = await act(s.owner, o.offerId, "answer", {
        outcome: "ACCEPTED",
        evidenceKind: "DOCUMENT_REF",
      });
      expect([refused.status, (await body(refused)).reason]).toEqual([
        409,
        "LEDGER_REFUSED",
      ]);
      const cons = await h.repo
        .sql`select count(*)::int n from mission_talent_contracts`;
      expect(cons[0]!.n).toBe(0);
      expect(
        (
          await body(
            await get(s.owner, `/v1/admin/org/missions/${s.id}/talent-offers`),
          )
        ).offers[0].status,
      ).toBe("SENT");
      const dec = await act(s.owner, o.offerId, "answer", {
        outcome: "DECLINED",
        evidenceKind: "OWNER_ATTESTATION",
        note: "took another job",
      });
      expect((await body(dec)).offer.status).toBe("DECLINED");
      // the candidate may be offered again once the earlier offer ended
      expect((await draft(s.owner, s.id, s.ada)).status).toBe(201);
    });

    it("an offer cannot be approved once the scope it was drafted under is no longer in force", async () => {
      const s = await scene();
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED");
      await check(s.owner, s.id, s.ada, "PORTFOLIO_REVIEWED");
      const o = (await body(await draft(s.owner, s.id, s.ada))).offer;
      const v2 = (
        await body(
          await post(s.owner, `/v1/admin/org/missions/${s.id}/talent-scopes`, {
            document: scopeDoc({ requiredChecks: ["IDENTITY_VERIFIED"] }),
            idempotencyKey: idemKey("t"),
          }),
        )
      ).scope;
      await post(s.owner, `/v1/admin/org/talent-scopes/${v2.scopeId}/approve`);
      const r = await act(s.owner, o.offerId, "approve");
      expect([r.status, (await body(r)).reason]).toEqual([
        409,
        "SCOPE_CHANGED",
      ]);
    });

    it("an agent may withdraw only its own draft; an expired offer cannot be approved or answered", async () => {
      const s = await scene();
      const mine = (await body(await draft(s.a, s.id, s.ada, {}, "/v1/agent")))
        .offer;
      const other = await post(
        s.b,
        `/v1/agent/talent-offers/${mine.offerId}/withdraw`,
        {},
      );
      expect([other.status, (await body(other)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      expect(
        (
          await body(
            await post(
              s.a,
              `/v1/agent/talent-offers/${mine.offerId}/withdraw`,
              { note: "wrong terms" },
            ),
          )
        ).offer.status,
      ).toBe("WITHDRAWN");
      await check(s.owner, s.id, s.ada, "IDENTITY_VERIFIED");
      await check(s.owner, s.id, s.ada, "PORTFOLIO_REVIEWED");
      const o = (await body(await draft(s.owner, s.id, s.ada))).offer;
      h.advance(20 * 24 * 3600 * 1000);
      const late = await act(s.owner, o.offerId, "approve");
      expect([late.status, (await body(late)).reason]).toEqual([
        409,
        "OFFER_EXPIRED",
      ]);
    });
  },
);
