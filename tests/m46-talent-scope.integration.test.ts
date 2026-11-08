/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
} from "./helpers/mission-fixtures.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  TalentScopeSchema,
  protectedAttributeHits,
  scopeProblems,
  type MissionFacts,
  type TalentScope,
} from "../src/missions/talent-scope.js";

/**
 * V3 M46 — the talent scope. It is the rulebook for everything that follows (shortlist, offer, pay): proposed by an agent or a person,
 * approved only by the owner, checked against the mission twice, one in force at a time, and never resting on protected attributes.
 */
const url = process.env.TEST_DATABASE_URL;
const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: "CONTRACTOR",
  currency: "USD",
  roles: [
    {
      roleId: "fe",
      title: "Frontend engineer",
      requiredSkills: ["TypeScript", "React"],
      preferredSkills: ["Accessibility"],
      engagement: "FIXED_PRICE",
      budgetCapMinor: 40_000,
      deliverables: ["Landing page", "Design system"],
    },
  ],
  requiredChecks: ["IDENTITY_VERIFIED", "PORTFOLIO_REVIEWED"],
  expiresAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const facts: MissionFacts = {
  currency: "USD",
  maxCommitmentMinor: 60_000,
  totalBudgetMinor: 150_000,
  spendingCategories: ["EQUIPMENT", "CONTRACTOR"],
  providerTypes: ["COMMERCE_MARKETPLACE", "TALENT_MARKETPLACE"],
  expiresAt: "2026-11-23T10:00:00.000Z",
};
const parse = (o: Record<string, unknown> = {}): TalentScope =>
  TalentScopeSchema.parse(doc(o));
const NOW = "2026-10-23T10:00:00.000Z";

describe("M46 talent scope rules (pure)", () => {
  it("a sound scope has no problems and each fault has its own code", () => {
    expect(scopeProblems(parse(), facts, NOW)).toEqual([]);
    const p = (s: TalentScope, f: Partial<MissionFacts> = {}) =>
      scopeProblems(s, { ...facts, ...f }, NOW);
    expect(p(parse({ currency: "EUR" }))).toEqual(["CURRENCY_MISMATCH"]);
    expect(p(parse(), { spendingCategories: ["EQUIPMENT"] })).toEqual([
      "CATEGORY_NOT_IN_MISSION",
    ]);
    expect(p(parse(), { providerTypes: ["COMMERCE_MARKETPLACE"] })).toEqual([
      "TALENT_NOT_APPROVED_BY_MISSION",
    ]);
    expect(p(parse({ expiresAt: NOW }))).toEqual(["SCOPE_ALREADY_EXPIRED"]);
    expect(p(parse({ expiresAt: "2026-11-23T10:00:01.000Z" }))).toEqual([
      "OUTLIVES_MISSION",
    ]);
    expect(p(parse({ expiresAt: "2026-11-23T10:00:00.000Z" }))).toEqual([]); // exactly the mission's end
    expect(p(parse(), { maxCommitmentMinor: 39_999 })).toEqual([
      "fe:ABOVE_MAX_COMMITMENT",
    ]);
    expect(p(parse(), { maxCommitmentMinor: 40_000 })).toEqual([]);
    expect(p(parse(), { totalBudgetMinor: 39_999 })).toEqual([
      "ROLES_EXCEED_BUDGET",
    ]);
    expect(p(parse(), { totalBudgetMinor: 40_000 })).toEqual([]);
  });

  it("the schema is strict: hourly roles need a rate, ids and checks are unique, unknown fields are refused", () => {
    const role = (o: Record<string, unknown>) => ({
      ...(doc().roles as Record<string, unknown>[])[0]!,
      ...o,
    });
    expect(() => parse({ roles: [role({ engagement: "HOURLY" })] })).toThrow();
    expect(() =>
      parse({
        roles: [role({ engagement: "HOURLY", maxHourlyRateMinor: 9_000 })],
      }),
    ).not.toThrow();
    expect(() => parse({ roles: [role({}), role({})] })).toThrow(); // duplicate role id
    expect(() =>
      parse({ requiredChecks: ["IDENTITY_VERIFIED", "IDENTITY_VERIFIED"] }),
    ).toThrow();
    expect(() => parse({ requiredChecks: [] })).toThrow();
    expect(() => parse({ roles: [role({ extra: 1 })] })).toThrow();
    expect(() => parse({ roles: [] })).toThrow();
    expect(() => parse({ extra: 1 })).toThrow();
  });

  it("protected attributes are caught as whole words; ordinary engineering words are not", () => {
    const hits = (text: string) =>
      protectedAttributeHits(
        parse({
          roles: [
            {
              ...(doc().roles as Record<string, unknown>[])[0]!,
              requiredSkills: [text],
            },
          ],
        }),
      );
    expect(hits("young team player")).toEqual(["fe:young"]);
    expect(hits("Female developers only")).toEqual(["fe:female"]);
    expect(hits("under 30 years of age")).toEqual(["fe:age"]);
    expect(hits("religious background")).toEqual(["fe:religious"]);
    expect(hits("React Native")).toEqual([]);
    expect(hits("race condition debugging")).toEqual([]);
    expect(hits("single-page applications")).toEqual([]);
    expect(hits("image processing, storage, manage")).toEqual([]); // "age" inside other words
    expect(hits("screen orientation handling")).toEqual([]);
    expect(hits("accessibility for disabled users")).toEqual([]);
    const titled = parse({
      roles: [
        {
          ...(doc().roles as Record<string, unknown>[])[0]!,
          title: "Young designer",
          deliverables: ["Married-couple portal"],
        },
      ],
    });
    expect(protectedAttributeHits(titled)).toEqual(["fe:married", "fe:young"]);
    expect(scopeProblems(titled, facts, NOW)).toEqual([
      "PROTECTED_ATTRIBUTE:fe:married",
      "PROTECTED_ATTRIBUTE:fe:young",
    ]);
  });

  it("property: with clean text, problems are exactly the budget/time/mission faults, never more or fewer", () => {
    let seed = 46_046;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    let clean = 0;
    for (let i = 0; i < 3000; i++) {
      const caps = Array.from({ length: 1 + rnd(4) }, () => 1 + rnd(70_000));
      const roles = caps.map((c, k) => ({
        ...(doc().roles as Record<string, unknown>[])[0]!,
        roleId: `r${k}`,
        budgetCapMinor: c,
      }));
      const scope = parse({ roles });
      const f: MissionFacts = {
        ...facts,
        maxCommitmentMinor: 30_000 + rnd(40_000),
        totalBudgetMinor: 30_000 + rnd(200_000),
      };
      const got = scopeProblems(scope, f, NOW);
      const expected: string[] = [];
      caps.forEach((c, k) => {
        if (c > f.maxCommitmentMinor)
          expected.push(`r${k}:ABOVE_MAX_COMMITMENT`);
      });
      if (caps.reduce((a, c) => a + c, 0) > f.totalBudgetMinor)
        expected.push("ROLES_EXCEED_BUDGET");
      expect(got).toEqual(expected);
      if (got.length === 0) clean++;
    }
    expect(clean).toBeGreaterThan(30);
  });
});

(url ? describe : describe.skip)(
  "M46 talent scope (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const scene = () =>
      activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE", "TALENT_MARKETPLACE"],
          spendingCategories: ["EQUIPMENT", "CONTRACTOR"],
          maxCommitmentMinor: 60_000,
          totalBudgetMinor: 150_000,
        }),
      );
    const propose = (
      t: string,
      id: string,
      d: Record<string, unknown> = doc(),
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/missions/${id}/talent-scopes`, {
        document: d,
        idempotencyKey: idemKey("t"),
      });

    it("an agent with DRAFT proposes, a person approves; nothing is in force before; the scope is checked against the mission", async () => {
      const s = await scene();
      const noCap = await propose(s.b, s.id, doc(), "/v1/agent");
      expect([noCap.status, (await body(noCap)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      const bad = await propose(
        s.a,
        s.id,
        doc({ currency: "EUR", category: "NOPE" }),
        "/v1/agent",
      );
      expect([bad.status, (await body(bad)).detail]).toEqual([
        422,
        "CURRENCY_MISMATCH,CATEGORY_NOT_IN_MISSION",
      ]);
      const prot = await propose(
        s.owner,
        s.id,
        doc({
          roles: [
            {
              ...(doc().roles as Record<string, unknown>[])[0]!,
              title: "Young designer",
            },
          ],
        }),
      );
      expect((await body(prot)).detail).toBe("PROTECTED_ATTRIBUTE:fe:young");
      const ok = await propose(s.a, s.id, doc(), "/v1/agent");
      expect(ok.status).toBe(201);
      const sc = (await body(ok)).scope;
      expect(sc).toMatchObject({
        version: 1,
        status: "PENDING_APPROVAL",
        proposedBy: "agent:a",
      });
      expect(
        (
          await body(
            await h.call(
              s.owner,
              "GET",
              `/v1/admin/org/missions/${s.id}/talent-scopes`,
            ),
          )
        ).inForce,
      ).toBeNull();
      // agents cannot approve (the member API refuses their credential)
      expect(
        (await post(s.a, `/v1/admin/org/talent-scopes/${sc.scopeId}/approve`))
          .status,
      ).toBe(401);
      const ap = await post(
        s.owner,
        `/v1/admin/org/talent-scopes/${sc.scopeId}/approve`,
      );
      expect((await body(ap)).scope.status).toBe("APPROVED");
      expect(
        (
          await body(
            await post(
              s.owner,
              `/v1/admin/org/talent-scopes/${sc.scopeId}/approve`,
            ),
          )
        ).replayed,
      ).toBe(true);
      const seen = await body(
        await h.call(s.a, "GET", `/v1/agent/missions/${s.id}/talent-scopes`),
      );
      expect(seen.inForce.scopeId).toBe(sc.scopeId);
    });

    it("one version is in force at a time: a newer approval supersedes; a rejection or revocation leaves none; versions never change", async () => {
      const s = await scene();
      const v1 = (await body(await propose(s.owner, s.id))).scope;
      await post(s.owner, `/v1/admin/org/talent-scopes/${v1.scopeId}/approve`);
      const v2 = (
        await body(
          await propose(
            s.owner,
            s.id,
            doc({ requiredChecks: ["IDENTITY_VERIFIED"] }),
          ),
        )
      ).scope;
      expect(v2.version).toBe(2);
      await post(s.owner, `/v1/admin/org/talent-scopes/${v2.scopeId}/approve`);
      const l = await body(
        await h.call(
          s.owner,
          "GET",
          `/v1/admin/org/missions/${s.id}/talent-scopes`,
        ),
      );
      expect(l.scopes.map((x: { status: string }) => x.status)).toEqual([
        "SUPERSEDED",
        "APPROVED",
      ]);
      expect(l.inForce.scopeId).toBe(v2.scopeId);
      const rejectedAfter = await post(
        s.owner,
        `/v1/admin/org/talent-scopes/${v1.scopeId}/reject`,
      );
      expect([
        rejectedAfter.status,
        (await body(rejectedAfter)).reason,
      ]).toEqual([409, "NOT_PENDING"]);
      const rv = await post(
        s.owner,
        `/v1/admin/org/talent-scopes/${v2.scopeId}/revoke`,
        { reason: "re-scoping" },
      );
      expect((await body(rv)).scope.status).toBe("REVOKED");
      expect(
        (
          await body(
            await h.call(
              s.owner,
              "GET",
              `/v1/admin/org/missions/${s.id}/talent-scopes`,
            ),
          )
        ).inForce,
      ).toBeNull();
      const v3 = (await body(await propose(s.owner, s.id))).scope;
      expect(
        (
          await body(
            await post(
              s.owner,
              `/v1/admin/org/talent-scopes/${v3.scopeId}/reject`,
              { reason: "too broad" },
            ),
          )
        ).scope.status,
      ).toBe("REJECTED");
      await expect(
        h.repo
          .sql`update mission_talent_scopes set document = '{}'::jsonb where scope_id = ${v1.scopeId}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        h.repo.sql`delete from mission_talent_scopes`,
      ).rejects.toThrow(/never deleted/);
      await expect(
        h.repo
          .sql`update mission_talent_scopes set status = 'APPROVED' where scope_id = ${v3.scopeId}`,
      ).rejects.toThrow(/REJECTED talent scope cannot change/);
    });

    it("approval checks the mission again: a scope that has since expired cannot take effect", async () => {
      const s = await scene();
      const sc = (
        await body(
          await propose(
            s.owner,
            s.id,
            doc({ expiresAt: "2026-10-24T10:00:00.000Z" }),
          ),
        )
      ).scope;
      h.advance(3 * 24 * 3600 * 1000);
      const late = await post(
        s.owner,
        `/v1/admin/org/talent-scopes/${sc.scopeId}/approve`,
      );
      expect([late.status, (await body(late)).detail]).toEqual([
        422,
        "SCOPE_ALREADY_EXPIRED",
      ]);
      expect(
        (
          await body(
            await h.call(
              s.owner,
              "GET",
              `/v1/admin/org/missions/${s.id}/talent-scopes`,
            ),
          )
        ).inForce,
      ).toBeNull();
    });

    it("the same key replays, a different document under the same key is refused", async () => {
      const s = await scene();
      const key = "same-key-0123456789";
      const first = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/talent-scopes`,
        { document: doc(), idempotencyKey: key },
      );
      const again = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/talent-scopes`,
        { document: doc(), idempotencyKey: key },
      );
      expect([
        first.status,
        again.status,
        (await body(again)).replayed,
      ]).toEqual([201, 200, true]);
      const other = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/talent-scopes`,
        {
          document: doc({ requiredChecks: ["IDENTITY_VERIFIED"] }),
          idempotencyKey: key,
        },
      );
      expect(other.status).toBe(409);
    });
  },
);
