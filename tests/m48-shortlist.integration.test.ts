/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { idemKey } from "./helpers/mission-fixtures.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { scopeDoc, talentMission } from "./helpers/talent.js";
import {
  evaluate,
  rank,
  shortlistProblems,
  type Role,
} from "../src/missions/shortlist.js";
import type { Profile } from "../src/missions/talent-candidates.js";
import { TalentScopeSchema } from "../src/missions/talent-scope.js";

/**
 * V3 M48 — ranking and shortlisting. Every check is MET, NOT_MET or UNKNOWN and unknown is never met; the order uses nothing that stands
 * in for a protected attribute (years of experience is shown, never ranked); only a person adopts a shortlist.
 */
const url = process.env.TEST_DATABASE_URL;
const role = (over: Record<string, unknown> = {}): Role =>
  TalentScopeSchema.parse(
    scopeDoc({
      roles: [
        { ...(scopeDoc().roles as Record<string, unknown>[])[0]!, ...over },
      ],
    }),
  ).roles[0]!;
const prof = (o: Partial<Profile> = {}): Profile => ({
  headline: "x",
  skills: ["TypeScript", "React"],
  currency: "USD",
  portfolioRefs: [],
  fixedQuoteMinor: 30_000,
  ...o,
});

describe("M48 evaluation and ranking (pure)", () => {
  it("skills are matched case-insensitively; price compares to the right cap; unknown is never met", () => {
    expect(evaluate(role(), prof()).standing).toBe("ELIGIBLE");
    expect(
      evaluate(role(), prof({ skills: ["typescript", "REACT"] })).standing,
    ).toBe("ELIGIBLE");
    const missing = evaluate(role(), prof({ skills: ["React"] }));
    expect([missing.standing, missing.reasons]).toEqual([
      "INELIGIBLE",
      ["MISSING_SKILL:TypeScript"],
    ]);
    expect(evaluate(role(), prof({ fixedQuoteMinor: 40_000 })).standing).toBe(
      "ELIGIBLE",
    ); // exactly the cap
    const over = evaluate(role(), prof({ fixedQuoteMinor: 40_001 }));
    expect([over.standing, over.reasons]).toEqual([
      "INELIGIBLE",
      ["PRICE_ABOVE_CAP"],
    ]);
    const unknown = evaluate(role(), prof({ fixedQuoteMinor: undefined }));
    expect([unknown.standing, unknown.price.check, unknown.reasons]).toEqual([
      "NEEDS_INFO",
      "UNKNOWN",
      ["PRICE_NOT_STATED"],
    ]);
    // an hourly role compares the hourly rate to the maximum rate and ignores a fixed quote
    const hourly = role({ engagement: "HOURLY", maxHourlyRateMinor: 9_000 });
    expect(
      evaluate(
        hourly,
        prof({ hourlyRateMinor: 9_000, fixedQuoteMinor: 999_999 }),
      ).standing,
    ).toBe("ELIGIBLE");
    expect(evaluate(hourly, prof({ hourlyRateMinor: 9_001 })).standing).toBe(
      "INELIGIBLE",
    );
    expect(evaluate(hourly, prof({ fixedQuoteMinor: 100 })).standing).toBe(
      "NEEDS_INFO",
    ); // a fixed quote says nothing about an hourly rate
    expect(
      evaluate(
        role(),
        prof({ skills: ["TypeScript", "React", "accessibility"] }),
      ).preferredMet,
    ).toBe(1);
  });

  it("the order is: standing, preferred skills, lower price (unknown last), portfolio, then handle", () => {
    const c = (candidateId: string, handle: string, p: Partial<Profile>) => ({
      candidateId,
      handle,
      profile: prof(p),
    });
    const out = rank(role(), [
      c("e", "zed", { fixedQuoteMinor: 20_000 }),
      c("d", "amy", { fixedQuoteMinor: 20_000 }),
      c("c", "bob", { fixedQuoteMinor: 20_000, portfolioRefs: ["p"] }),
      c("b", "cy", {
        fixedQuoteMinor: 35_000,
        skills: ["TypeScript", "React", "Accessibility"],
      }),
      c("a", "dee", { fixedQuoteMinor: undefined }),
      c("x", "eve", { skills: ["Go"] }),
    ]);
    expect(out.map((r) => [r.handle, r.rank])).toEqual([
      ["cy", 1],
      ["bob", 2],
      ["amy", 3],
      ["zed", 4],
      ["dee", 5],
      ["eve", null],
    ]);
  });

  it("property: years of experience never changes the order; ranks are 1..n for the ranked and null for the rest; the order is deterministic", () => {
    let seed = 48_048;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const skillSets = [
      ["TypeScript", "React"],
      ["TypeScript", "React", "Accessibility"],
      ["React"],
      ["Go"],
    ];
    for (let i = 0; i < 2000; i++) {
      const cands = Array.from({ length: 1 + rnd(8) }, (_, k) => ({
        candidateId: `c${k}`,
        handle: `h${rnd(4)}${k}`,
        profile: prof({
          skills: skillSets[rnd(skillSets.length)]!,
          fixedQuoteMinor: rnd(5) === 0 ? undefined : 10_000 * (1 + rnd(5)),
          portfolioRefs: rnd(2) === 0 ? [] : ["p"],
          yearsExperience: rnd(40),
        }),
      }));
      const base = rank(role(), cands);
      const older = rank(
        role(),
        cands.map((c) => ({
          ...c,
          profile: {
            ...c.profile,
            yearsExperience: 60 - (c.profile.yearsExperience ?? 0),
          },
        })),
      );
      expect(older.map((r) => r.candidateId)).toEqual(
        base.map((r) => r.candidateId),
      );
      expect(
        rank(role(), [...cands].reverse()).map((r) => r.candidateId),
      ).toEqual(base.map((r) => r.candidateId));
      const ranked = base.filter((r) => r.rank !== null);
      expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, k) => k + 1));
      expect(
        base
          .filter((r) => r.rank === null)
          .every((r) => r.evaluation.standing === "INELIGIBLE"),
      ).toBe(true);
    }
  });

  it("only ranked candidates, one to five, each once, can be shortlisted", () => {
    const ranked = rank(role(), [
      ...Array.from({ length: 7 }, (_, k) => ({
        candidateId: `c${k}`,
        handle: `h${k}`,
        profile: prof(),
      })),
      { candidateId: "bad", handle: "zz", profile: prof({ skills: ["Go"] }) },
    ]);
    expect(shortlistProblems(ranked, ["c0", "c1"])).toEqual([]);
    expect(shortlistProblems(ranked, ["c0", "c1", "c2", "c3", "c4"])).toEqual(
      [],
    );
    expect(
      shortlistProblems(ranked, ["c0", "c1", "c2", "c3", "c4", "c5"]),
    ).toEqual(["TOO_MANY"]);
    expect(shortlistProblems(ranked, [])).toEqual(["EMPTY"]);
    expect(shortlistProblems(ranked, ["c0", "c0"])).toEqual(["DUPLICATE"]);
    expect(shortlistProblems(ranked, ["bad"])).toEqual(["INELIGIBLE:bad"]);
    expect(shortlistProblems(ranked, ["nope"])).toEqual([
      "UNKNOWN_CANDIDATE:nope",
    ]);
  });
});

(url ? describe : describe.skip)(
  "M48 shortlist (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const scene = async () => {
      const s = await talentMission(h);
      await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/talent-candidates/import`,
        {
          sourceId: "payflow-sandbox-talent",
          roleId: "fe",
          idempotencyKey: idemKey("i"),
        },
      );
      const add = (handle: string, profile: Record<string, unknown>) =>
        post(s.owner, `/v1/admin/org/missions/${s.id}/talent-candidates`, {
          roleId: "fe",
          handle,
          profile,
          idempotencyKey: idemKey("m"),
        });
      await add("pat.dev", {
        headline: "Pat",
        skills: ["TypeScript", "React"],
        currency: "USD",
        fixedQuoteMinor: 30_000,
      });
      await add("jo.dev", {
        headline: "Jo",
        skills: ["TypeScript", "React"],
        currency: "USD",
      });
      const ranking = await body(
        await get(
          s.owner,
          `/v1/admin/org/missions/${s.id}/talent-roles/fe/ranking`,
        ),
      );
      const idOf = (handle: string) =>
        ranking.ranked.find((r: { handle: string }) => r.handle === handle)
          .candidateId as string;
      return { ...s, ranking, idOf };
    };
    const adopt = (
      t: string,
      id: string,
      ids: string[],
      extra: Record<string, unknown> = {},
    ) =>
      post(t, `/v1/admin/org/missions/${id}/talent-shortlists`, {
        roleId: "fe",
        candidateIds: ids,
        idempotencyKey: idemKey("s"),
        ...extra,
      });

    it("ranks the imported and added candidates by the scope's checks; unknown is not met; the hostile profile gains nothing", async () => {
      const s = await scene();
      expect(
        s.ranking.ranked.map(
          (r: {
            handle: string;
            rank: number | null;
            evaluation: { standing: string };
          }) => [r.handle, r.rank, r.evaluation.standing],
        ),
      ).toEqual([
        ["sandbox-ada", 1, "ELIGIBLE"],
        ["pat.dev", 2, "ELIGIBLE"],
        ["jo.dev", 3, "NEEDS_INFO"],
        ["sandbox-grace", null, "INELIGIBLE"],
        ["sandbox-edsger", null, "INELIGIBLE"],
      ]);
      const ed = s.ranking.ranked.find(
        (r: { handle: string }) => r.handle === "sandbox-edsger",
      );
      expect(ed.evaluation.reasons).toEqual(["PRICE_ABOVE_CAP"]);
      // an agent with COMPARE reads the same ranking; one without is refused
      expect(
        (
          await body(
            await get(
              s.a,
              `/v1/agent/missions/${s.id}/talent-roles/fe/ranking`,
            ),
          )
        ).ranked,
      ).toHaveLength(5);
      const noCap = await get(
        s.c,
        `/v1/agent/missions/${s.id}/talent-roles/fe/ranking`,
      );
      expect([noCap.status, (await body(noCap)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      expect(
        (
          await get(
            s.owner,
            `/v1/admin/org/missions/${s.id}/talent-roles/nope/ranking`,
          )
        ).status,
      ).toBe(422);
    });

    it("only a person adopts, only from ranked candidates, one active shortlist per role; it can be withdrawn and re-adopted", async () => {
      const s = await scene();
      expect((await adopt(s.a, s.id, [s.idOf("sandbox-ada")])).status).toBe(
        401,
      ); // the member API refuses an agent credential
      const bad = await adopt(s.owner, s.id, [
        s.idOf("sandbox-ada"),
        s.idOf("sandbox-grace"),
      ]);
      expect([bad.status, (await body(bad)).detail]).toEqual([
        422,
        `INELIGIBLE:${s.idOf("sandbox-grace")}`,
      ]);
      const key = "same-key-0123456789";
      const ok = await adopt(
        s.owner,
        s.id,
        [s.idOf("sandbox-ada"), s.idOf("pat.dev")],
        { idempotencyKey: key, note: "top two" },
      );
      expect(ok.status).toBe(201);
      const sl = (await body(ok)).shortlist;
      expect(sl).toMatchObject({
        status: "ACTIVE",
        roleId: "fe",
        note: "top two",
        notice: expect.stringContaining("never years of experience") as string,
      });
      expect(sl.snapshot.ranked[0].handle).toBe("sandbox-ada");
      const again = await adopt(
        s.owner,
        s.id,
        [s.idOf("sandbox-ada"), s.idOf("pat.dev")],
        { idempotencyKey: key },
      );
      expect([again.status, (await body(again)).replayed]).toEqual([200, true]);
      expect(
        (
          await adopt(
            s.owner,
            s.id,
            [s.idOf("sandbox-ada"), s.idOf("pat.dev")],
            { idempotencyKey: key, note: "x" },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await adopt(s.owner, s.id, [s.idOf("sandbox-ada")], {
            idempotencyKey: key,
          })
        ).status,
      ).toBe(409);
      const second = await adopt(s.owner, s.id, [s.idOf("jo.dev")]);
      expect([second.status, (await body(second)).reason]).toEqual([
        409,
        "ALREADY_ACTIVE",
      ]);
      const wd = await post(
        s.owner,
        `/v1/admin/org/talent-shortlists/${sl.shortlistId}/withdraw`,
        { reason: "re-ranking" },
      );
      expect((await body(wd)).shortlist.status).toBe("WITHDRAWN");
      expect(
        (
          await body(
            await post(
              s.owner,
              `/v1/admin/org/talent-shortlists/${sl.shortlistId}/withdraw`,
              { reason: "again" },
            ),
          )
        ).replayed,
      ).toBe(true);
      expect((await adopt(s.owner, s.id, [s.idOf("jo.dev")])).status).toBe(201);
      await expect(
        h.repo
          .sql`update mission_talent_shortlists set role_id = 'x' where shortlist_id = ${sl.shortlistId}`,
      ).rejects.toThrow(/withdrawn shortlist cannot change/);
      await expect(
        h.repo.sql`delete from mission_talent_shortlists`,
      ).rejects.toThrow(/never deleted/);
      const l = await body(
        await get(s.a, `/v1/agent/missions/${s.id}/talent-shortlists`),
      );
      expect(l.shortlists.map((x: { status: string }) => x.status)).toEqual([
        "WITHDRAWN",
        "ACTIVE",
      ]);
    });

    it("candidates imported under an older scope are not ranked under a newer one", async () => {
      const s = await scene();
      const v2 = (
        await body(
          await post(s.owner, `/v1/admin/org/missions/${s.id}/talent-scopes`, {
            document: scopeDoc({ requiredChecks: ["IDENTITY_VERIFIED"] }),
            idempotencyKey: idemKey("t"),
          }),
        )
      ).scope;
      await post(s.owner, `/v1/admin/org/talent-scopes/${v2.scopeId}/approve`);
      const r = await body(
        await get(
          s.owner,
          `/v1/admin/org/missions/${s.id}/talent-roles/fe/ranking`,
        ),
      );
      expect(r.ranked).toEqual([]);
      expect(r.staleExcluded).toBe(5);
      const none = await adopt(s.owner, s.id, [s.idOf("sandbox-ada")]);
      expect([none.status, (await body(none)).detail]).toEqual([
        422,
        `UNKNOWN_CANDIDATE:${s.idOf("sandbox-ada")}`,
      ]);
    });
  },
);
