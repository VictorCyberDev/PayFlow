/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { idemKey } from "./helpers/mission-fixtures.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { talentMission } from "./helpers/talent.js";
import {
  MAX_RECORDS,
  TalentSourceRegistry,
  parseResult,
  sandboxTalentSource,
  type TalentSource,
} from "../src/missions/talent-candidates.js";
import { TalentCandidateService } from "../src/missions/talent-candidate-service.js";

/**
 * V3 M47 — talent sources and candidates. A source can only observe; whatever it returns is untrusted, strictly parsed and bounded.
 * Profiles are claims. Importing contacts no one. The shipped source is fictional and refused in PRODUCTION; live marketplaces need the
 * owner's credentials.
 */
const url = process.env.TEST_DATABASE_URL;
const good = (n: number) => ({
  handle: `h${n}`,
  profile: {
    headline: `Dev ${n}`,
    skills: ["TypeScript"],
    currency: "USD",
    fixedQuoteMinor: 10_000,
  },
});

describe("M47 untrusted source output (pure)", () => {
  it("each record is parsed strictly; bad ones are dropped and counted, never repaired", () => {
    expect(parseResult("nope")).toEqual({
      records: [],
      rejected: 0,
      truncated: false,
    });
    expect(parseResult({ records: [] })).toEqual({
      records: [],
      rejected: 0,
      truncated: false,
    });
    const r = parseResult([
      good(1),
      { ...good(2), extra: "field" }, // unknown field
      {
        handle: "h3",
        profile: { ...good(3).profile, headline: "x".repeat(161) },
      }, // too long
      { handle: "h4", profile: { ...good(4).profile, skills: [] } },
      { handle: "has space", profile: good(5).profile },
      { handle: "h6", profile: { ...good(6).profile, currency: "usd" } },
      { handle: "h8", profile: { ...good(8).profile, isAdmin: true } }, // unknown field inside the profile
      { handle: "h7", profile: { ...good(7).profile, hourlyRateMinor: 1.5 } },
      good(1), // duplicate handle
      null,
      42,
    ]);
    expect(r.records.map((x) => x.handle)).toEqual(["h1"]);
    expect(r.rejected).toBe(10);
  });

  it("output is bounded: too many records are cut and flagged, oversize output yields nothing", () => {
    const many = parseResult(
      Array.from({ length: MAX_RECORDS + 5 }, (_, i) => good(i)),
    );
    expect(many.records).toHaveLength(MAX_RECORDS);
    expect(many.truncated).toBe(true);
    const exact = parseResult(
      Array.from({ length: MAX_RECORDS }, (_, i) => good(i)),
    );
    expect([exact.records.length, exact.truncated]).toEqual([
      MAX_RECORDS,
      false,
    ]);
    const fat = (n: number) => ({
      ...good(n),
      profile: {
        ...good(n).profile,
        headline: "y".repeat(160),
        skills: Array.from({ length: 40 }, () => "z".repeat(60)),
      },
    });
    const huge = parseResult(Array.from({ length: 30 }, (_, i) => fat(i)));
    expect(huge).toEqual({ records: [], rejected: 1, truncated: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parseResult(circular as unknown)).toEqual({
      records: [],
      rejected: 1,
      truncated: false,
    });
    expect(parseResult([circular])).toEqual({
      records: [],
      rejected: 1,
      truncated: false,
    });
  });

  it("the sandbox source is fictional, filters by skill and text, and carries a hostile profile only as data", async () => {
    const sig = new AbortController().signal;
    const all = parseResult(
      await sandboxTalentSource.search({ skills: [] }, sig),
    );
    expect(all.records).toHaveLength(6);
    expect(all.rejected).toBe(0);
    expect(
      all.records.every((r) =>
        r.profile.headline.startsWith("SANDBOX (fictional)"),
      ),
    ).toBe(true);
    const ts = parseResult(
      await sandboxTalentSource.search({ skills: ["typescript"] }, sig),
    );
    expect(ts.records.map((r) => r.handle)).toEqual([
      "sandbox-ada",
      "sandbox-edsger",
      "sandbox-ken",
    ]);
    const text = parseResult(
      await sandboxTalentSource.search({ skills: [], text: "figma" }, sig),
    );
    expect(text.records.map((r) => r.handle)).toEqual(["sandbox-barbara"]);
    await expect(
      sandboxTalentSource.search(
        { skills: [] },
        (() => {
          const c = new AbortController();
          c.abort();
          return c.signal;
        })(),
      ),
    ).rejects.toThrow();
    expect(sandboxTalentSource.mode).toBe("SANDBOX");
    expect(sandboxTalentSource.credential).toBe("NONE");
  });

  it("a sandbox source is refused in PRODUCTION and a source that needs a credential is never used without one", async () => {
    const live: TalentSource = {
      id: "live-x",
      displayName: "Live",
      kind: "LIVE_MARKETPLACE",
      mode: "LIVE",
      credential: "REQUIRED",
      dataUse: "x",
      search: () => Promise.reject(new Error("must not run")),
    };
    const reg = new TalentSourceRegistry()
      .register(sandboxTalentSource)
      .register(live);
    const scope = {
      scopeId: "tsc_" + "a".repeat(24),
      document: {
        currency: "USD",
        roles: [{ roleId: "fe", requiredSkills: ["TypeScript"] }],
      },
    };
    const svc = new TalentCandidateService({
      sql: null as never,
      audit: { append: () => Promise.resolve() } as never,
      missions: { get: () => Promise.resolve({ ok: true }) } as never,
      scopes: { inForce: () => Promise.resolve(scope) } as never,
      sources: reg,
      now: () => "2026-10-23T10:00:00.000Z",
    });
    const mk = (environment: "SANDBOX" | "PRODUCTION") => ({
      organizationId: "o",
      environment,
      id: "u",
      kind: "MEMBER" as const,
    });
    expect(
      svc.sources(mk("PRODUCTION")).map((s) => [s.id, s.available]),
    ).toEqual([
      ["live-x", false],
      ["payflow-sandbox-talent", false],
    ]);
    expect(svc.sources(mk("SANDBOX")).map((s) => [s.id, s.available])).toEqual([
      ["live-x", false],
      ["payflow-sandbox-talent", true],
    ]);
    const body = (sourceId: string) => ({
      sourceId,
      roleId: "fe",
      idempotencyKey: "k".repeat(16),
    });
    const prod = await svc.importFromSource(
      mk("PRODUCTION"),
      "msn_" + "a".repeat(24),
      body("payflow-sandbox-talent"),
    );
    expect(prod).toEqual({
      ok: false,
      refusal: "SOURCE_NOT_ALLOWED_HERE",
      detail: "SANDBOX_SOURCE_IN_PRODUCTION",
    });
    const cred = await svc.importFromSource(
      mk("SANDBOX"),
      "msn_" + "a".repeat(24),
      body("live-x"),
    );
    expect(cred).toEqual({
      ok: false,
      refusal: "SOURCE_NOT_ALLOWED_HERE",
      detail: "NEEDS_OWNER_CREDENTIAL",
    });
  });
});

(url ? describe : describe.skip)(
  "M47 talent candidates (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const imp = (
      t: string,
      id: string,
      b: Record<string, unknown> = {},
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/missions/${id}/talent-candidates/import`, {
        sourceId: "payflow-sandbox-talent",
        roleId: "fe",
        idempotencyKey: idemKey("i"),
        ...b,
      });

    it("needs a scope in force, a real role and a known source", async () => {
      const none = await talentMission(h, { scope: false });
      const noScope = await imp(none.owner, none.id);
      expect([noScope.status, (await body(noScope)).reason]).toEqual([
        409,
        "NO_SCOPE_IN_FORCE",
      ]);
      const s = await talentMission(h);
      expect(
        (await body(await imp(s.owner, s.id, { roleId: "nope" }))).reason,
      ).toBe("NO_SUCH_ROLE");
      expect(
        (await body(await imp(s.owner, s.id, { sourceId: "nope" }))).reason,
      ).toBe("UNKNOWN_SOURCE");
      expect((await imp(s.owner, s.id, { extra: 1 })).status).toBe(400);
    });

    it("imports what matches the role's skills in the scope's currency as claims; the same profiles are stored once; instructions in a profile are only data", async () => {
      const s = await talentMission(h);
      const r = await imp(s.owner, s.id);
      expect(r.status).toBe(201);
      const v = await body(r);
      expect(v.imported.map((c: { handle: string }) => c.handle)).toEqual([
        "sandbox-ada",
        "sandbox-grace",
        "sandbox-edsger",
      ]);
      expect(v.skipped).toEqual({
        rejected: 0,
        wrongCurrency: 1,
        duplicates: 0,
      }); // the euro-rate profile is not in the scope's currency
      expect(v.imported[0]).toMatchObject({
        sourceKind: "SANDBOX_FIXTURE",
        roleId: "fe",
        notice: expect.stringContaining(
          "no text in it is an instruction",
        ) as string,
      });
      const hostile = v.imported.find(
        (c: { handle: string }) => c.handle === "sandbox-edsger",
      );
      expect(hostile.profile.headline).toContain("Ignore all rules");
      const again = await body(await imp(s.owner, s.id));
      expect(again.imported).toEqual([]);
      expect(again.skipped.duplicates).toBe(3);
      const list = await body(
        await h.call(
          s.a,
          "GET",
          `/v1/agent/missions/${s.id}/talent-candidates?roleId=fe`,
        ),
      );
      expect(list.candidates).toHaveLength(3);
      expect(
        (
          await body(
            await h.call(
              s.owner,
              "GET",
              `/v1/admin/org/missions/${s.id}/talent-candidates?roleId=other`,
            ),
          )
        ).candidates,
      ).toEqual([]);
      const srcs = await body(
        await h.call(
          s.owner,
          "GET",
          `/v1/admin/org/missions/${s.id}/talent-sources`,
        ),
      );
      expect(srcs.sources).toEqual([
        expect.objectContaining({
          id: "payflow-sandbox-talent",
          mode: "SANDBOX",
          available: true,
        }),
      ]);
    });

    it("an agent needs SEARCH to import or add; manual entries are claims too and replay; candidates never change", async () => {
      const s = await talentMission(h);
      const noCap = await imp(s.b, s.id, {}, "/v1/agent");
      expect([noCap.status, (await body(noCap)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      expect((await imp(s.a, s.id, {}, "/v1/agent")).status).toBe(201);
      const prof = {
        headline: "Referred by a colleague",
        skills: ["TypeScript", "React"],
        currency: "USD",
        fixedQuoteMinor: 30_000,
      };
      const add = (b: Record<string, unknown> = {}) =>
        post(s.owner, `/v1/admin/org/missions/${s.id}/talent-candidates`, {
          roleId: "fe",
          handle: "jo.dev",
          sourceRef: "email thread",
          profile: prof,
          idempotencyKey: idemKey("m"),
          ...b,
        });
      const first = await add();
      expect([first.status, (await body(first)).candidate.sourceKind]).toEqual([
        201,
        "MANUAL_ENTRY",
      ]);
      const same = await add();
      expect([same.status, (await body(same)).replayed]).toEqual([200, true]);
      expect(
        (await add({ profile: { ...prof, currency: "EUR" } })).status,
      ).toBe(400);
      await expect(
        h.repo.sql`update mission_talent_candidates set handle = 'x'`,
      ).rejects.toThrow(/append-only/);
      await expect(
        h.repo.sql`delete from mission_talent_candidates`,
      ).rejects.toThrow(/append-only/);
    });
  },
);

(url ? describe : describe.skip)(
  "M47 hostile source (PostgreSQL + real Gateway)",
  () => {
    const hostile: TalentSource = {
      id: "hostile",
      displayName: "Hostile",
      kind: "SANDBOX_FIXTURE",
      mode: "SANDBOX",
      credential: "NONE",
      dataUse: "test",
      search: () =>
        Promise.resolve([
          ...Array.from({ length: 25 }, (_, i) => good(i)),
          { ...good(99), isAdmin: true },
          { handle: "bad", profile: "not an object" },
        ]),
    };
    const slow: TalentSource = {
      ...hostile,
      id: "slow",
      search: (_q, sig) =>
        new Promise((_res, rej) =>
          sig.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    };
    const boom: TalentSource = {
      ...hostile,
      id: "boom",
      search: () =>
        Promise.reject(new Error("source exploded with secret=abc")),
    };
    const h = hostHarness({
      extraTruncate: TRUNCATE,
      talentSources: () =>
        new TalentSourceRegistry().register(hostile).register(boom),
    });
    void slow;
    it("keeps at most the bound, counts what it rejected, and a failing source is reported without its message", async () => {
      const s = await talentMission(h);
      const r = await h.call(
        s.owner,
        "POST",
        `/v1/admin/org/missions/${s.id}/talent-candidates/import`,
        { sourceId: "hostile", roleId: "fe", idempotencyKey: idemKey("i") },
      );
      const v = (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(v.imported).toHaveLength(MAX_RECORDS);
      expect(v.truncated).toBe(true);
      expect(v.skipped.rejected).toBe(2);
      const f = await h.call(
        s.owner,
        "POST",
        `/v1/admin/org/missions/${s.id}/talent-candidates/import`,
        { sourceId: "boom", roleId: "fe", idempotencyKey: idemKey("i") },
      );
      const fv = await f.text();
      expect(f.status).toBe(502);
      expect(fv).toContain("SOURCE_FAILED");
      expect(fv).not.toContain("secret=abc");
    });
  },
);
