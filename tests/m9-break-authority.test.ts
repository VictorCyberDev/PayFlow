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

describe("Integrated Break Authority (production modules, fake rail)", () => {
  it.each([100, 1000] as const)(
    "contains all %i scenarios across all 16 categories while valid controls still complete",
    async (count) => {
      const { runIntegratedBreakAuthority, INTEGRATED_CATEGORIES } =
        await import("../src/network/break-authority-integrated.js");
      const report = await runIntegratedBreakAuthority(count);
      expect(report.scenarioCount).toBe(count);
      expect(report.results).toHaveLength(count);
      expect(report.uncontainedScenarioIds).toEqual([]);
      expect(Object.keys(report.categories)).toEqual([
        ...INTEGRATED_CATEGORIES,
      ]);
      for (const category of INTEGRATED_CATEGORIES) {
        expect(report.categories[category].total).toBeGreaterThan(0);
        expect(report.categories[category].contained).toBe(
          report.categories[category].total,
        );
      }
      expect(report.controls.every((control) => control.passed)).toBe(true);
      expect(report.providerEffectsExercised).toBe(false);
      expect(report.railKind).toBe("deterministic-fake");
    },
  );
});

describe("committed evidence artifacts", () => {
  it("are byte-identical to what the production modules produce today", async () => {
    const { readFile } = await import("node:fs/promises");
    const { buildEvidenceArtifacts } =
      await import("../src/network/evidence-artifacts.js");
    const artifacts = await buildEvidenceArtifacts();
    for (const [name, content] of Object.entries(artifacts)) {
      const committed = await readFile(`docs/evidence/${name}`, "utf8");
      expect(
        committed === content,
        `${name} is stale; run npm run evidence:generate`,
      ).toBe(true);
    }
  });
});
