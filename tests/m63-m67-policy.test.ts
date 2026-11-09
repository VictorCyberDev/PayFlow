import { describe, expect, it } from "vitest";
import { convert, exponentOf } from "../src/missions/fx.js";
import {
  QuorumPolicySchema,
  evaluateQuorum,
  tierFor,
  type Vote,
} from "../src/missions/quorum.js";
import {
  canMoveAgent,
  readiness,
  type AgentState,
} from "../src/missions/agent-lifecycle.js";
import { PACKS, applyPack } from "../src/missions/policy-packs.js";

const NOW = "2026-11-09T12:00:00.000Z";
const rate = {
  base: "GBP",
  quote: "USD",
  num: 12_745,
  den: 10_000,
  observedAt: "2026-11-09T11:00:00.000Z",
  source: "test-fixture",
};
const ctx = (direction: "OWED" | "AVAILABLE") => ({
  now: NOW,
  maxAgeSeconds: 7_200,
  direction,
});

describe("M63 FX", () => {
  it("converts with integer math, rounding what is owed UP and what is available DOWN", () => {
    // 10.01 GBP at 1.2745 = 12.7575… USD
    const owed = convert(1_001, "GBP", "USD", rate, ctx("OWED"));
    const avail = convert(1_001, "GBP", "USD", rate, ctx("AVAILABLE"));
    expect(owed).toMatchObject({ ok: true, minor: 1_276, rounding: "UP" });
    expect(avail).toMatchObject({ ok: true, minor: 1_275, rounding: "DOWN" });
    // exact conversions do not round
    expect(convert(10_000, "GBP", "USD", rate, ctx("OWED"))).toMatchObject({
      minor: 12_745,
    });
  });
  it("the inverse direction is exact and owed never undercuts available, for many amounts", () => {
    for (let a = 0; a < 3_000; a += 7) {
      const o = convert(a, "USD", "GBP", rate, ctx("OWED"));
      const v = convert(a, "USD", "GBP", rate, ctx("AVAILABLE"));
      if (!o.ok || !v.ok) throw new Error("expected ok");
      expect(o.minor - v.minor).toBeGreaterThanOrEqual(0);
      expect(o.minor - v.minor).toBeLessThanOrEqual(1);
    }
  });
  it("accounts for each currency's minor units", () => {
    expect(exponentOf("JPY")).toBe(0);
    const jpy = { ...rate, base: "GBP", quote: "JPY", num: 190, den: 1 };
    // 10.00 GBP = 1900 JPY (no minor unit)
    expect(convert(1_000, "GBP", "JPY", jpy, ctx("OWED"))).toMatchObject({
      minor: 1_900,
    });
    const kwd = { ...rate, base: "GBP", quote: "KWD", num: 4, den: 10 };
    // 10.00 GBP = 4.000 KWD = 4000 fils
    expect(convert(1_000, "GBP", "KWD", kwd, ctx("OWED"))).toMatchObject({
      minor: 4_000,
    });
  });
  it("refuses instead of guessing: stale, future, wrong pair, malformed, unknown currency, bad amount", () => {
    const r = (x: unknown, from = "GBP", to = "USD", a = 100) =>
      convert(a, from, to, x, ctx("OWED"));
    expect(r({ ...rate, observedAt: "2026-11-09T08:00:00.000Z" })).toEqual({
      ok: false,
      refusal: "STALE_RATE",
    });
    expect(r({ ...rate, observedAt: "2026-11-09T13:00:00.000Z" })).toEqual({
      ok: false,
      refusal: "STALE_RATE",
    });
    expect(r(rate, "GBP", "EUR")).toEqual({ ok: false, refusal: "WRONG_PAIR" });
    expect(r({ ...rate, num: 0 })).toEqual({ ok: false, refusal: "BAD_RATE" });
    expect(r({ ...rate, num: 1.5 })).toEqual({
      ok: false,
      refusal: "BAD_RATE",
    });
    expect(r({ ...rate, quote: "GBP" })).toEqual({
      ok: false,
      refusal: "BAD_RATE",
    });
    expect(r({ ...rate, base: "XXX", quote: "USD" }, "XXX", "USD")).toEqual({
      ok: false,
      refusal: "UNKNOWN_CURRENCY",
    });
    expect(r(rate, "GBP", "USD", -1)).toEqual({
      ok: false,
      refusal: "BAD_AMOUNT",
    });
    expect(r(rate, "GBP", "USD", 1.5)).toEqual({
      ok: false,
      refusal: "BAD_AMOUNT",
    });
  });
});

const policy = QuorumPolicySchema.parse({
  tiers: [
    { aboveMinor: 100_000, approvals: 1, roles: ["OWNER", "ADMIN", "FINANCE"] },
    { aboveMinor: 1_000_000, approvals: 2, roles: ["OWNER", "FINANCE"] },
  ],
});
const vote = (
  memberId: string,
  decision: Vote["decision"] = "APPROVE",
  roleNow: Vote["roleNow"] = "OWNER",
  at = "2026-11-09T10:00:00.000Z",
): Vote => ({ memberId, roleNow, decision, at });
const exp = { expiresAt: "2026-11-10T00:00:00.000Z" };

describe("M65 quorum", () => {
  it("picks the tier by amount; below every threshold nothing extra is needed", () => {
    expect(tierFor(policy, 99_999)).toBeNull();
    expect(tierFor(policy, 100_000)?.approvals).toBe(1);
    expect(tierFor(policy, 5_000_000)?.approvals).toBe(2);
    expect(evaluateQuorum(policy, 50, "r", [], exp)).toEqual({
      state: "NOT_REQUIRED",
      required: 0,
    });
  });
  it("counts distinct members only, never the requester, never a role that does not count, never a late vote", () => {
    const big = 2_000_000;
    expect(
      evaluateQuorum(policy, big, "r", [vote("a"), vote("a")], exp),
    ).toMatchObject({ state: "WAITING", counted: 1 });
    expect(
      evaluateQuorum(policy, big, "r", [vote("a"), vote("r")], exp),
    ).toMatchObject({ state: "WAITING", counted: 1 });
    expect(
      evaluateQuorum(
        policy,
        big,
        "r",
        [vote("a"), vote("b", "APPROVE", "ADMIN")],
        exp,
      ),
    ).toMatchObject({ state: "WAITING", counted: 1 });
    expect(
      evaluateQuorum(
        policy,
        big,
        "r",
        [vote("a"), vote("b", "APPROVE", "OWNER", "2026-11-11T00:00:00.000Z")],
        exp,
      ),
    ).toMatchObject({ state: "WAITING", counted: 1 });
    expect(
      evaluateQuorum(
        policy,
        big,
        "r",
        [vote("a"), vote("b", "APPROVE", "FINANCE")],
        exp,
      ),
    ).toEqual({ state: "MET", required: 2, counted: 2 });
  });
  it("a rejection from a member whose vote counts blocks, even after approvals; a rejection from one whose role does not count is ignored", () => {
    expect(
      evaluateQuorum(
        policy,
        2_000_000,
        "r",
        [vote("a"), vote("b", "REJECT", "FINANCE")],
        exp,
      ),
    ).toMatchObject({ state: "BLOCKED", by: "b" });
    expect(
      evaluateQuorum(
        policy,
        2_000_000,
        "r",
        [vote("b", "REJECT", "MEMBER")],
        exp,
      ),
    ).toMatchObject({ state: "WAITING", counted: 0 });
  });
  it("the first vote of a member is the one that counts (a later flip does not change it)", () => {
    const r = evaluateQuorum(
      policy,
      200_000,
      "r",
      [
        vote("a", "APPROVE", "OWNER", "2026-11-09T09:00:00.000Z"),
        vote("a", "REJECT", "OWNER", "2026-11-09T09:30:00.000Z"),
      ],
      exp,
    );
    expect(r).toMatchObject({ state: "MET" });
  });
  it("a policy with two tiers at one threshold, or no tiers, is refused", () => {
    expect(
      QuorumPolicySchema.safeParse({
        tiers: [
          { aboveMinor: 1, approvals: 1, roles: ["OWNER"] },
          { aboveMinor: 1, approvals: 2, roles: ["OWNER"] },
        ],
      }).success,
    ).toBe(false);
    expect(QuorumPolicySchema.safeParse({ tiers: [] }).success).toBe(false);
  });
});

describe("M66 agent lifecycle", () => {
  it("only legal moves exist; retired is final; suspended can resume", () => {
    expect(canMoveAgent("ENROLLED", "ACTIVE")).toBe(true);
    expect(canMoveAgent("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canMoveAgent("SUSPENDED", "ACTIVE")).toBe(true);
    expect(canMoveAgent("ENROLLED", "SUSPENDED")).toBe(false);
    for (const to of [
      "ENROLLED",
      "ACTIVE",
      "SUSPENDED",
      "RETIRED",
    ] as AgentState[])
      expect(canMoveAgent("RETIRED", to)).toBe(false);
  });
  it("authority needs ACTIVE and a live credential; rotation is flagged before it lapses and an expired one never works", () => {
    const cred = {
      issuedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    expect(readiness("ACTIVE", cred, NOW)).toEqual({
      canAct: true,
      rotation: "OK",
    });
    expect(readiness("ACTIVE", cred, "2026-11-25T00:00:00.000Z")).toEqual({
      canAct: true,
      rotation: "ROTATE_SOON",
    });
    expect(readiness("ACTIVE", cred, "2026-12-01T00:00:00.000Z")).toEqual({
      canAct: false,
      why: "CREDENTIAL_EXPIRED",
    });
    expect(readiness("ACTIVE", cred, "2026-10-31T00:00:00.000Z")).toEqual({
      canAct: false,
      why: "CREDENTIAL_NOT_YET_VALID",
    });
    expect(readiness("SUSPENDED", cred, NOW)).toEqual({
      canAct: false,
      why: "SUSPENDED",
    });
    expect(readiness("ENROLLED", cred, NOW)).toEqual({
      canAct: false,
      why: "NOT_ACTIVATED",
    });
    expect(readiness("RETIRED", cred, NOW)).toEqual({
      canAct: false,
      why: "RETIRED",
    });
  });
});

describe("M67 policy packs", () => {
  const asked = {
    totalBudgetMinor: 100_000,
    maxPurchaseMinor: 90_000,
    approveAboveMinor: 60_000,
    durationDays: 90,
  };
  it("only ever tightens, and says what it changed", () => {
    const cautious = PACKS.find((p) => p.id === "CAUTIOUS")!;
    const a = applyPack(cautious, asked);
    expect(a.limits).toEqual({
      totalBudgetMinor: 100_000,
      maxPurchaseMinor: 20_000,
      approveAboveMinor: 10_000,
      durationDays: 14,
    });
    expect(a.changes.map((c) => c.field).sort()).toEqual([
      "approveAboveMinor",
      "durationDays",
      "maxPurchaseMinor",
    ]);
  });
  it("leaves tighter requests alone and never raises any limit, for every pack and many requests", () => {
    for (const p of PACKS)
      for (const total of [1, 999, 100_000, 7_777_777])
        for (const f of [0, 0.05, 0.3, 1]) {
          const req = {
            totalBudgetMinor: total,
            maxPurchaseMinor: Math.floor(total * f),
            approveAboveMinor: Math.floor(total * f * 0.5),
            durationDays: Math.round(1 + f * 60),
          };
          const out = applyPack(p, req).limits;
          expect(out.maxPurchaseMinor).toBeLessThanOrEqual(
            req.maxPurchaseMinor,
          );
          expect(out.approveAboveMinor).toBeLessThanOrEqual(
            req.approveAboveMinor,
          );
          expect(out.durationDays).toBeLessThanOrEqual(req.durationDays);
          expect(out.totalBudgetMinor).toBe(total);
        }
    const tight = {
      totalBudgetMinor: 100_000,
      maxPurchaseMinor: 1_000,
      approveAboveMinor: 500,
      durationDays: 3,
    };
    expect(applyPack(PACKS[0]!, tight)).toMatchObject({
      limits: tight,
      changes: [],
    });
  });
  it("the look-only pack cannot buy", () => {
    const p = PACKS.find((x) => x.id === "EXPLORATORY_ONLY")!;
    const a = applyPack(p, asked);
    expect(a.lookOnly).toBe(true);
    expect(a.limits.maxPurchaseMinor).toBe(0);
  });
});
