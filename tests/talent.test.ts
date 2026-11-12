import { describe, expect, it } from "vitest";
import {
  buildQuery,
  findTalent,
  toCandidate,
  type TalentDirectory,
  type TalentFailure,
} from "../src/partner/talent.js";

/** Shaped from GitHub's documented user object. */
const profile = (over: Record<string, unknown> = {}) => ({
  login: "amelia-dev",
  name: "Amelia Earhart",
  hireable: true,
  bio: "Motion and graphics engineer. Open to contract work.",
  location: "Lisbon",
  company: "@skyward",
  blog: "amelia.example.com",
  public_repos: 42,
  followers: 310,
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  html_url: "https://github.com/amelia-dev",
  created_at: "2014-03-02T11:00:00Z",
  ...over,
});

function directory(
  over: Partial<TalentDirectory> & { profiles?: Record<string, unknown> } = {},
): TalentDirectory & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    searchHandles:
      over.searchHandles ??
      (() =>
        Promise.resolve({
          status: "OK" as const,
          body: {
            total_count: 2,
            items: [{ login: "amelia-dev" }, { login: "bo-dev" }],
          },
        })),
    readProfile:
      over.readProfile ??
      ((handle: string) => {
        reads.push(handle);
        const map = over.profiles ?? {
          "amelia-dev": profile(),
          "bo-dev": profile({ login: "bo-dev", hireable: false }),
        };
        const body = map[handle];
        return body
          ? Promise.resolve({ status: "OK" as const, body })
          : Promise.resolve({ status: "DIRECTORY_REJECTED" as const });
      }),
  };
}
const AT = () => "2026-11-12T00:00:00.000Z";

describe("nobody is listed unless they said so themselves", () => {
  it("keeps only a profile whose owner set hireable", () => {
    expect(toCandidate(profile())?.handle).toBe("amelia-dev");
    expect(toCandidate(profile({ hireable: false }))).toBeNull();
    expect(toCandidate(profile({ hireable: null }))).toBeNull();
    const { hireable, ...withoutFlag } = profile();
    void hireable;
    expect(toCandidate(withoutFlag)).toBeNull();
    expect(toCandidate(null)).toBeNull();
    expect(toCandidate({ login: 123 })).toBeNull();
  });

  it("marks every candidate it does return as self-declared", () => {
    expect(toCandidate(profile())!.declaredAvailable).toBe(true);
  });

  it("drops anyone whose profile could not be read, rather than assuming availability", async () => {
    const d = directory({
      searchHandles: () =>
        Promise.resolve({
          status: "OK",
          body: { items: [{ login: "amelia-dev" }, { login: "unreadable" }] },
        }),
      profiles: { "amelia-dev": profile() },
    });
    const r = await findTalent(d, "motion graphics", null, AT);
    expect(r.status).toBe("FOUND");
    if (r.status !== "FOUND") return;
    expect(r.search.candidates.map((c) => c.handle)).toEqual(["amelia-dev"]);
    // It still says how many it looked at, so the list reads as a filter rather than as "everyone there is".
    expect(r.search.profilesRead).toBe(2);
  });

  it("returns an empty list, not a guess, when no profile can be read at all", async () => {
    const r = await findTalent(
      directory({
        readProfile: () => Promise.resolve({ status: "DIRECTORY_UNAVAILABLE" }),
      }),
      "motion graphics",
      null,
      AT,
    );
    expect(r.status).toBe("FOUND");
    if (r.status !== "FOUND") return;
    expect(r.search.candidates).toHaveLength(0);
    expect(r.search.profilesRead).toBe(2);
  });
});

describe("what a candidate card may claim", () => {
  it("carries the real profile and nothing invented", async () => {
    const r = await findTalent(directory(), "motion graphics", "Lisbon", AT);
    if (r.status !== "FOUND") throw new Error(r.status);
    const c = r.search.candidates[0]!;
    expect(c).toMatchObject({
      handle: "amelia-dev",
      name: "Amelia Earhart",
      location: "Lisbon",
      profileUrl: "https://github.com/amelia-dev",
      publicProjects: 42,
      followers: 310,
    });
    expect(c.portfolioUrl).toBe("https://amelia.example.com/");
    // No rate, no availability window, no rating: the shape has nowhere to put an invented one.
    expect(Object.keys(c)).not.toContain("rate");
    expect(Object.keys(c)).not.toContain("rating");
    expect(Object.keys(c)).not.toContain("availability");
  });

  it("states what it does not know, and what this source covers", async () => {
    const r = await findTalent(directory(), "motion graphics", null, AT);
    if (r.status !== "FOUND") throw new Error(r.status);
    expect(r.search.unknowns.join(" ")).toMatch(/rate/);
    expect(r.search.unknowns.join(" ")).toMatch(/free on your dates/);
    expect(r.search.covers).toMatch(/publish code/);
    expect(r.search.source).toBe("GitHub");
    expect(r.search.evidence).toBe("PROVIDER_OBSERVED");
  });

  it("refuses a link that is not plain https, and strips control characters", () => {
    expect(
      toCandidate(profile({ blog: "javascript:alert(1)" }))!.portfolioUrl,
    ).toBeNull();
    expect(
      toCandidate(profile({ blog: "http://insecure.example" }))!.portfolioUrl,
    ).toBeNull();
    expect(
      toCandidate(profile({ name: "Amelia\u0000\u001b[31m Earhart" }))!.name,
    ).not.toMatch(/[\u0000-\u001f]/u);
    // A profile url the provider did not give falls back to the canonical one rather than being omitted.
    expect(toCandidate(profile({ html_url: null }))!.profileUrl).toBe(
      "https://github.com/amelia-dev",
    );
  });
});

describe("the query PayFlow sends", () => {
  it("is built from the founder's words and our own qualifiers", () => {
    const q = buildQuery("motion graphics", "Lisbon")!;
    expect(q).toContain("motion graphics in:bio");
    expect(q).toContain("type:user");
    expect(q).toContain('location:"Lisbon"');
  });

  it("cannot be steered by what the founder types", () => {
    // A caller trying to smuggle qualifiers gets them stripped, not honoured.
    const q = buildQuery('rust" OR type:org location:"Moon', null)!;
    expect(q).not.toContain("type:org");
    expect(q).not.toContain('"');
    expect(q.match(/type:user/gu)).toHaveLength(1);
    expect(buildQuery("", null)).toBeNull();
    expect(buildQuery("a", null)).toBeNull();
    expect(buildQuery(null, null)).toBeNull();
  });
});

describe("when the directory cannot answer", () => {
  it("carries the failure through rather than showing nobody as if nobody existed", async () => {
    for (const status of [
      "DIRECTORY_UNAVAILABLE",
      "DIRECTORY_TIMEOUT",
      "DIRECTORY_REJECTED",
    ] as TalentFailure[])
      expect(
        (
          await findTalent(
            directory({ searchHandles: () => Promise.resolve({ status }) }),
            "motion graphics",
            null,
            AT,
          )
        ).status,
      ).toBe(status);
    expect(
      (await findTalent(undefined, "motion graphics", null, AT)).status,
    ).toBe("DIRECTORY_NOT_CONFIGURED");
  });
});
