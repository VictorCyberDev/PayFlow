import { describe, expect, it } from "vitest";
import { assertClosureDeletionsArePermitted } from "../src/network/account-data.js";
import {
  DEFAULT_RETENTION_RULES,
  deletionDecision,
} from "../src/network/privacy.js";

/**
 * V3 M74 — the retention policy governs the code, instead of describing it from a distance.
 *
 * `privacy.ts` said that IMMUTABLE_FINANCIAL_EVIDENCE is not deletable, and account closure independently happened to
 * agree, by never touching a financial table. Two descriptions that agree by luck are one refactor away from
 * disagreeing in silence, and the silence is what makes it dangerous: deleting financial evidence raises no error.
 *
 * These tests are about the guard, not the happy path. The question is whether it bites.
 */
describe("M74 retention policy enforcement", () => {
  it("the policy protects financial evidence and permits secret references", () => {
    const rule = (c: string) =>
      DEFAULT_RETENTION_RULES.find((r) => r.dataClass === c)!;
    // The two facts account closure leans on.
    expect(rule("IMMUTABLE_FINANCIAL_EVIDENCE").deletable).toBe(false);
    expect(rule("IMMUTABLE_FINANCIAL_EVIDENCE").retentionDays).toBe(
      "INDEFINITE_BY_EVIDENCE_POLICY",
    );
    expect(rule("SECRET_REFERENCE").deletable).toBe(true);
    // Financial evidence stays exportable even though it cannot be deleted: a person may always have a copy.
    expect(rule("IMMUTABLE_FINANCIAL_EVIDENCE").exportable).toBe(true);
    expect(deletionDecision("IMMUTABLE_FINANCIAL_EVIDENCE")).toEqual({
      allowed: false,
      reason: "IMMUTABLE_FINANCIAL_EVIDENCE",
    });
  });

  it("what account closure actually deletes is permitted by the policy", () => {
    // The real list, unmodified. This is the assertion that runs before every closure.
    expect(() => assertClosureDeletionsArePermitted()).not.toThrow();
  });

  it("the guard refuses a deletion the policy protects, naming the table and the reason", () => {
    // This is the test that matters: if someone adds a financial table to the closure list, closure must stop.
    expect(() =>
      assertClosureDeletionsArePermitted([
        { table: "user_mfa", dataClass: "SECRET_REFERENCE" },
        {
          table: "mission_ledger_items",
          dataClass: "IMMUTABLE_FINANCIAL_EVIDENCE",
        },
      ]),
    ).toThrow(/mission_ledger_items.*IMMUTABLE_FINANCIAL_EVIDENCE/u);
  });

  it("every data class the policy names has a decision, so a new class cannot slip through undecided", () => {
    for (const rule of DEFAULT_RETENTION_RULES) {
      const d = deletionDecision(rule.dataClass);
      // The policy's own `deletable` flag and the decision function must never disagree.
      expect(
        d.allowed,
        `deletionDecision disagrees with DEFAULT_RETENTION_RULES for ${rule.dataClass}`,
      ).toBe(rule.deletable);
    }
  });
});
