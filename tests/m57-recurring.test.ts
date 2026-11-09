import { describe, expect, it } from "vitest";
import {
  OUTCOMES,
  OUTCOME_WORDS,
  RecurringSetupSchema,
  checkRecurrence,
  type MissionFacts,
} from "../src/missions/recurring.js";

const NOW = "2026-11-09T12:00:00.000Z";
const good: MissionFacts = {
  status: "ACTIVE",
  expiresAt: "2026-12-01T00:00:00.000Z",
  currency: "GBP",
  maxCommitmentMinor: 50_000,
  availableMinor: 40_000,
};
const r = { amountMinor: 30_000, currency: "GBP" };

describe("M57 recurring renewal checks (pure)", () => {
  it("a healthy mission makes the recurrence due for the owner, and nothing else", () => {
    expect(checkRecurrence(r, good, NOW)).toBe("DUE_FOR_OWNER");
  });
  it("every way the mission can have changed stops it, each with its own reason", () => {
    const c = (m: Partial<MissionFacts> | null) =>
      checkRecurrence(r, m === null ? null : { ...good, ...m }, NOW);
    expect(c(null)).toBe("SKIPPED_MISSION_NOT_ACTIVE");
    for (const status of [
      "PAUSED",
      "REVOKED",
      "CANCELLED",
      "COMPLETED",
      "DRAFT",
      "EXPIRED",
    ])
      expect(c({ status }), status).toBe("SKIPPED_MISSION_NOT_ACTIVE");
    expect(c({ expiresAt: NOW })).toBe("SKIPPED_MISSION_EXPIRED");
    expect(c({ expiresAt: "2026-11-01T00:00:00.000Z" })).toBe(
      "SKIPPED_MISSION_EXPIRED",
    );
    expect(c({ currency: "USD" })).toBe("SKIPPED_CURRENCY_CHANGED");
    expect(c({ maxCommitmentMinor: 29_999 })).toBe(
      "SKIPPED_ABOVE_PURCHASE_LIMIT",
    );
    expect(c({ availableMinor: 29_999 })).toBe("SKIPPED_NO_BUDGET_LEFT");
    // exactly at the limits is allowed
    expect(c({ maxCommitmentMinor: 30_000, availableMinor: 30_000 })).toBe(
      "DUE_FOR_OWNER",
    );
  });
  it("an inactive mission is never reported as having enough budget, whatever else is true (order of checks)", () => {
    expect(
      checkRecurrence(
        r,
        { ...good, status: "PAUSED", availableMinor: 0, maxCommitmentMinor: 0 },
        NOW,
      ),
    ).toBe("SKIPPED_MISSION_NOT_ACTIVE");
  });
  it("every outcome has plain words and only the due one asks the owner", () => {
    for (const o of OUTCOMES)
      expect(OUTCOME_WORDS[o].length).toBeGreaterThan(10);
    expect(OUTCOME_WORDS.DUE_FOR_OWNER).toContain("Nothing was bought");
  });
  it("a recurrence cannot be faster than daily, free, fractional or oversized", () => {
    const base = {
      label: "Design tool",
      amountMinor: 1_000,
      everySeconds: 86_400,
    };
    expect(RecurringSetupSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, everySeconds: 3_600 },
      { ...base, everySeconds: 400 * 86_400 },
      { ...base, amountMinor: 0 },
      { ...base, amountMinor: 1.5 },
      { ...base, label: "" },
      { ...base, extra: 1 },
    ])
      expect(
        RecurringSetupSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});
