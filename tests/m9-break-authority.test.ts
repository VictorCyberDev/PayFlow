import { describe, expect, it } from "vitest";
import { runBreakAuthorityBenchmark } from "../src/network/benchmark.js";

describe("M9 Break Authority 100", () => {
  it("rejects all 100 deterministic unauthorized scenarios while allowing the control", () => {
    const report = runBreakAuthorityBenchmark(100);
    expect(report.scenarioCount).toBe(100);
    expect(report.results).toHaveLength(100);
    expect(report.unauthorizedAllows).toBe(0);
    expect(report.controlDecision).toBe("ALLOW");
    expect(report.providerEffectsExercised).toBe(false);
  });
});

describe("M37 Break Authority 1000 local kernel suite", () => {
  it("rejects all 1000 deterministic unauthorized scenarios", () => {
    const report = runBreakAuthorityBenchmark(1000);
    expect(report.scenarioCount).toBe(1000);
    expect(report.results).toHaveLength(1000);
    expect(report.unauthorizedAllows).toBe(0);
    expect(report.controlDecision).toBe("ALLOW");
  });
});
