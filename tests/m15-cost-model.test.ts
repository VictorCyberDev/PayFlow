import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUTS,
  ILLUSTRATIVE_TIERS,
  costPer1000AuthorityEvaluations,
  costPer1000Executions,
  costPer1000VerifyCalls,
  costPerActiveAgent,
  costPerActiveOrganization,
  grossMargin,
  operationCost,
  paypalMerchantFeeUsd,
  renderGrossMarginMarkdown,
  reportTier,
  scaleInput,
  validateInputs,
  type OrganizationUsage,
  type UnitCostInput,
  type UnitCostTable,
} from "../scripts/cost-model.js";

const est = (id: string, value: number): UnitCostInput => ({
  id,
  description: id,
  unit: "unit",
  value,
  provenance: "ESTIMATE",
  assumption: "test",
});

/** A tiny table with round numbers so arithmetic can be checked by hand. */
function simpleTable(): UnitCostTable {
  const ids: Record<string, number> = {
    "vercel.activeCpuUsdPerHour": 0.36, // $0.36/h => $0.0001 per CPU-second... 1000 ms = 0.0001
    "vercel.provisionedMemoryUsdPerGbHour": 0.036,
    "vercel.fastDataTransferUsdPerGb": 0.1,
    "vercel.observabilityUsdPerMillionEvents": 1,
    "vercel.invocationUsdPerMillion": 0.5,
    "vercel.proPlatformFeeUsdPerMonth": 20,
    "neon.computeUsdPerCuHour": 0.36,
    "neon.storageUsdPerGbMonth": 0.5,
    "fixed.neonBaselineCuHoursPerMonth": 100,
    "fixed.monthlySupportHoursPerActiveOrg": 2,
    "fixed.supportUsdPerHour": 50,
    "fixed.retentionMonths": 10,
    "profile.modelCallsPerAuthorityEvaluation": 0,
  };
  for (const kind of ["authority", "verify", "execution"]) {
    Object.assign(ids, {
      [`profile.${kind}.activeCpuMs`]: 10,
      [`profile.${kind}.wallMs`]: 100,
      [`profile.${kind}.memoryGb`]: 1,
      [`profile.${kind}.dbCuSeconds`]: 1,
      [`profile.${kind}.storedBytes`]: 1_000_000,
      [`profile.${kind}.egressBytes`]: 1_000_000,
      [`profile.${kind}.logEvents`]: 1,
    });
  }
  return Object.entries(ids).map(([id, value]) => est(id, value));
}

const usageBase: OrganizationUsage = {
  authorityEvaluations: 1000,
  verifyCalls: 1000,
  executions: 1000,
  activeAgents: 4,
  orgsSharingFixedCosts: 2,
};

describe("M15 cost model: arithmetic", () => {
  it("computes each line of a per-1000 authority cost by hand-checkable formulas", () => {
    const result = costPer1000AuthorityEvaluations(simpleTable());
    const byId = Object.fromEntries(
      result.lines.map((line) => [line.id, line.costUsd]),
    );
    // 1000 * 10 ms = 10,000 ms = 1/360 h * $0.36 = $0.01
    expect(byId["authority.cpu"]).toBeCloseTo(0.01, 12);
    // 1000 * 100 ms * 1 GB = 100,000 ms = 1/36 h * $0.036 = $0.001
    expect(byId["authority.memory"]).toBeCloseTo(0.001, 12);
    // 1000 invocations = 0.001 M * $0.5
    expect(byId["authority.invocations"]).toBeCloseTo(0.0005, 12);
    // 1000 CU-seconds = 1/3.6 h * $0.36 = $0.1
    expect(byId["authority.dbCompute"]).toBeCloseTo(0.1, 12);
    // 1000 * 1e6 bytes = 1 GB * 10 months * $0.5 = $5
    expect(byId["authority.dbStorage"]).toBeCloseTo(5, 12);
    // 1 GB * $0.1
    expect(byId["authority.egress"]).toBeCloseTo(0.1, 12);
    // 1000 events = 0.001 M * $1
    expect(byId["authority.logging"]).toBeCloseTo(0.001, 12);
    const sum = Object.values(byId).reduce((a, b) => a + b, 0);
    expect(result.totalUsd).toBeCloseTo(sum, 12);
    expect(result.complete).toBe(true);
    expect(result.unverified).toEqual([]);
  });

  it("exposes verify and execution costs that differ from authority costs", () => {
    const table = DEFAULT_INPUTS;
    const a = costPer1000AuthorityEvaluations(table).totalUsd;
    const v = costPer1000VerifyCalls(table).totalUsd;
    const x = costPer1000Executions(table).totalUsd;
    expect(a).toBeGreaterThan(0);
    expect(v).toBeGreaterThan(0);
    expect(x).toBeGreaterThan(a);
  });

  it("per-1000 scaling is linear in count", () => {
    const table = DEFAULT_INPUTS;
    for (const kind of ["authority", "verify", "execution"] as const) {
      const one = operationCost(table, kind, 1000).totalUsd;
      expect(operationCost(table, kind, 2000).totalUsd).toBeCloseTo(
        2 * one,
        12,
      );
      expect(operationCost(table, kind, 500).totalUsd).toBeCloseTo(one / 2, 12);
      expect(operationCost(table, kind, 1_000_000).totalUsd).toBeCloseTo(
        1000 * one,
        9,
      );
    }
  });

  it("zero usage gives zero variable cost", () => {
    for (const kind of ["authority", "verify", "execution"] as const) {
      expect(operationCost(DEFAULT_INPUTS, kind, 0).totalUsd).toBe(0);
    }
    const org = costPerActiveOrganization(simpleTable(), {
      ...usageBase,
      authorityEvaluations: 0,
      verifyCalls: 0,
      executions: 0,
      supportMultiplier: 0,
    });
    const variable = org.lines
      .filter((line) => !line.id.startsWith("fixed."))
      .reduce((acc, line) => acc + line.costUsd, 0);
    expect(variable).toBe(0);
    // Only the allocated fixed costs remain: 20/2 + 100*0.36/2 = 28
    expect(org.totalUsd).toBeCloseTo(28, 12);
  });

  it("per-organization cost = variable + support + fixed share", () => {
    const table = simpleTable();
    const org = costPerActiveOrganization(table, usageBase);
    const expected =
      operationCost(table, "authority", 1000).totalUsd +
      operationCost(table, "verify", 1000).totalUsd +
      operationCost(table, "execution", 1000).totalUsd +
      2 * 50 + // support: 2 h x $50
      20 / 2 +
      (100 * 0.36) / 2;
    expect(org.totalUsd).toBeCloseTo(expected, 10);
  });

  it("per-agent cost is the organization cost divided by active agents", () => {
    const table = simpleTable();
    const org = costPerActiveOrganization(table, usageBase);
    const agent = costPerActiveAgent(table, usageBase);
    expect(agent.totalUsd).toBeCloseTo(org.totalUsd / 4, 12);
    expect(() =>
      costPerActiveAgent(table, { ...usageBase, activeAgents: 0 }),
    ).toThrow("NO_ACTIVE_AGENTS");
  });

  it("model calls in the authority path are zero by default and refuse to be silently priced", () => {
    const calls = DEFAULT_INPUTS.find(
      (entry) => entry.id === "profile.modelCallsPerAuthorityEvaluation",
    );
    expect(calls?.value).toBe(0);
    const withCalls = simpleTable().map((entry) =>
      entry.id === "profile.modelCallsPerAuthorityEvaluation"
        ? { ...entry, value: 1 }
        : entry,
    );
    expect(() => costPer1000AuthorityEvaluations(withCalls)).toThrow(
      "MODEL_CALLS_IN_AUTHORITY_PATH_NOT_PRICED",
    );
  });
});

describe("M15 cost model: provenance is surfaced, never silently zeroed", () => {
  it("the default table has UNVERIFIED inputs and results report them", () => {
    const unverifiedIds = DEFAULT_INPUTS.filter(
      (entry) => entry.provenance === "UNVERIFIED",
    ).map((entry) => entry.id);
    expect(unverifiedIds).toContain("vercel.invocationUsdPerMillion");
    for (const entry of DEFAULT_INPUTS) {
      if (entry.provenance === "UNVERIFIED") expect(entry.value).toBeNull();
    }
    const result = costPer1000Executions(DEFAULT_INPUTS);
    expect(result.complete).toBe(false);
    expect(result.unverified).toEqual(["vercel.invocationUsdPerMillion"]);
    expect(
      result.lines.some((line) => line.id === "execution.invocations"),
    ).toBe(false);
    expect(result.estimated.length).toBeGreaterThan(0);
  });

  it("turning an input UNVERIFIED removes its line and flags the result as a lower bound", () => {
    const table = simpleTable();
    const full = costPer1000AuthorityEvaluations(table);
    const patched: UnitCostTable = table.map((entry) =>
      entry.id === "neon.computeUsdPerCuHour"
        ? {
            id: entry.id,
            description: entry.description,
            unit: entry.unit,
            value: null,
            provenance: "UNVERIFIED",
            assumption: "test",
          }
        : entry,
    );
    const partial = costPer1000AuthorityEvaluations(patched);
    expect(partial.complete).toBe(false);
    expect(partial.unverified).toContain("neon.computeUsdPerCuHour");
    expect(partial.totalUsd).toBeCloseTo(full.totalUsd - 0.1, 10);
  });

  it("an UNVERIFIED input carrying a number is rejected", () => {
    const bad: UnitCostTable = [
      {
        id: "a",
        description: "a",
        unit: "u",
        value: 0,
        provenance: "UNVERIFIED",
      },
    ];
    expect(() => validateInputs(bad)).toThrow("UNVERIFIED_INPUT_MUST_BE_NULL");
  });

  it("every VERIFIED default has a URL and a fetch date; every ESTIMATE has an assumption", () => {
    expect(() => validateInputs(DEFAULT_INPUTS)).not.toThrow();
    for (const entry of DEFAULT_INPUTS) {
      if (entry.provenance === "VERIFIED") {
        expect(entry.sourceUrl).toMatch(/^https:\/\//);
        expect(entry.fetchedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      if (entry.provenance === "ESTIMATE") {
        expect((entry.assumption ?? "").length).toBeGreaterThan(10);
      }
    }
    expect(() =>
      validateInputs([
        {
          id: "v",
          description: "v",
          unit: "u",
          value: 1,
          provenance: "VERIFIED",
        },
      ]),
    ).toThrow("VERIFIED_INPUT_NEEDS_SOURCE");
    expect(() =>
      validateInputs([
        {
          id: "e",
          description: "e",
          unit: "u",
          value: 1,
          provenance: "ESTIMATE",
        },
      ]),
    ).toThrow("ESTIMATE_INPUT_NEEDS_ASSUMPTION");
  });
});

describe("M15 cost model: margin and guards", () => {
  it("margin = (revenue - cost) / revenue", () => {
    expect(grossMargin(100, 25)).toBeCloseTo(0.75, 12);
    expect(grossMargin(100, 100)).toBe(0);
    expect(grossMargin(100, 150)).toBeCloseTo(-0.5, 12);
    expect(grossMargin(200, 0)).toBe(1);
  });

  it("rejects non-positive revenue and negative cost", () => {
    expect(() => grossMargin(0, 1)).toThrow("INVALID_REVENUE");
    expect(() => grossMargin(-5, 1)).toThrow("INVALID_REVENUE");
    expect(() => grossMargin(Number.NaN, 1)).toThrow("INVALID_REVENUE");
    expect(() => grossMargin(100, -1)).toThrow("NEGATIVE_COST");
  });

  it("rejects negative or non-finite unit costs", () => {
    expect(() => validateInputs([est("n", -0.01)])).toThrow(
      "NEGATIVE_COST_INPUT",
    );
    expect(() => validateInputs([est("n", Number.NaN)])).toThrow(
      "INPUT_NOT_FINITE",
    );
    expect(() => validateInputs([est("n", Infinity)])).toThrow(
      "INPUT_NOT_FINITE",
    );
    expect(() => validateInputs([est("d", 1), est("d", 2)])).toThrow(
      "DUPLICATE_INPUT",
    );
  });

  it("rejects negative or invalid usage", () => {
    expect(() => operationCost(DEFAULT_INPUTS, "verify", -1)).toThrow(
      "INVALID_USAGE",
    );
    expect(() =>
      costPerActiveOrganization(DEFAULT_INPUTS, {
        ...usageBase,
        orgsSharingFixedCosts: 0,
      }),
    ).toThrow("INVALID_USAGE");
    expect(() =>
      scaleInput(DEFAULT_INPUTS, "neon.storageUsdPerGbMonth", -1),
    ).toThrow("INVALID_SCALE_FACTOR");
    expect(() => scaleInput(DEFAULT_INPUTS, "nope", 1)).toThrow(
      "UNKNOWN_INPUT",
    );
  });

  it("an unknown input id is an error, not a zero", () => {
    expect(() => costPer1000AuthorityEvaluations([est("only.one", 1)])).toThrow(
      "UNKNOWN_INPUT",
    );
  });

  it("PayPal merchant fee is informational and uses the verified US rate", () => {
    expect(paypalMerchantFeeUsd(DEFAULT_INPUTS, 100)).toBeCloseTo(3.98, 10);
    expect(paypalMerchantFeeUsd(DEFAULT_INPUTS, 0)).toBeCloseTo(0.49, 10);
    // PayPal fees never enter PayFlow cost lines.
    const org = costPerActiveOrganization(DEFAULT_INPUTS, usageBase);
    expect(org.lines.some((line) => line.id.includes("paypal"))).toBe(false);
  });
});

describe("M15 illustrative tiers", () => {
  it("tier reports use grossMargin and the sensitivity is monotonic", () => {
    for (const tier of ILLUSTRATIVE_TIERS) {
      const report = reportTier(DEFAULT_INPUTS, tier);
      expect(report.margin).toBeCloseTo(
        (tier.hypotheticalRevenueUsd - report.cost.totalUsd) /
          tier.hypotheticalRevenueUsd,
        12,
      );
      expect(report.cost.complete).toBe(false);
      const costs = report.sensitivity.map((entry) => entry.costUsd);
      for (let i = 1; i < costs.length; i += 1) {
        expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
      }
      expect(tier.revenueBasis).toContain("HYPOTHETICAL");
    }
  });

  it("rendering is deterministic and labels revenue HYPOTHETICAL", () => {
    const a = renderGrossMarginMarkdown(DEFAULT_INPUTS);
    const b = renderGrossMarginMarkdown(DEFAULT_INPUTS);
    expect(a).toBe(b);
    expect(a).toContain("HYPOTHETICAL revenue");
    expect(a).toContain("vercel.invocationUsdPerMillion");
  });
});
