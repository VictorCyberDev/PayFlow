import { createHash } from "node:crypto";
import { runToolSelectionEval } from "../protocols/tool-selection.js";
import { runIntegratedBreakAuthority } from "./break-authority-integrated.js";
import { runBreakAuthorityBenchmark } from "./benchmark.js";
import { runConformanceSuite } from "./conformance.js";
import { runFaultInjectionMatrix } from "./fault-injection.js";
import { LIVE_CONFORMANCE_CASES } from "./live-conformance.js";
import { liveFaultInjector } from "./live-fault-injector.js";

/** Fixed so regenerated artifacts are byte-identical across machines and days. */
export const EVIDENCE_GENERATED_AT = "2026-10-28T03:00:00.000Z";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Deterministic, machine-readable evidence produced by the real modules.
 * Keys are file names under docs/evidence/.
 */
export async function buildEvidenceArtifacts(): Promise<
  Readonly<Record<string, string>>
> {
  const [integrated100, integrated1000, faults, conformance] =
    await Promise.all([
      runIntegratedBreakAuthority(100),
      runIntegratedBreakAuthority(1000),
      runFaultInjectionMatrix(liveFaultInjector),
      runConformanceSuite(LIVE_CONFORMANCE_CASES, EVIDENCE_GENERATED_AT),
    ]);
  const files: Record<string, string> = {
    "break-authority-kernel-1000.json": json(runBreakAuthorityBenchmark(1000)),
    "break-authority-integrated-100.json": json(integrated100),
    "break-authority-integrated-1000.json": json(integrated1000),
    "fault-injection-report.json": json(faults),
    "conformance-report.json": json(conformance),
    "tool-selection-eval.json": json(runToolSelectionEval()),
  };
  return {
    ...files,
    "break-authority-summary.json": json(
      breakAuthoritySummary(files, {
        integrated1000,
        faults,
        conformance,
      }),
    ),
  };
}

interface IntegratedResult {
  readonly category: string;
  readonly contained: boolean;
  readonly evidence: string;
}

/**
 * The public Research page reads this file, so every number shown is generated from the real runs
 * and byte-verified in CI. It reports diversity honestly: scenarios are parameterised variants of
 * a small number of attack families, so the count of DISTINCT containment outcomes is shown beside
 * the scenario count.
 */
function breakAuthoritySummary(
  files: Readonly<Record<string, string>>,
  runs: {
    integrated1000: unknown;
    faults: unknown;
    conformance: unknown;
  },
) {
  const integrated = runs.integrated1000 as {
    scenarioCount: number;
    uncontainedScenarioIds: string[];
    controls: { passed: boolean }[];
    railKind: string;
    providerEffectsExercised: boolean;
    results: IntegratedResult[];
  };
  const faults = runs.faults as { total: number; passed: number };
  const conformance = runs.conformance as {
    passed: number;
    failed: number;
    certificationClaim: boolean;
  };
  const kernel = JSON.parse(files["break-authority-kernel-1000.json"]!) as {
    scenarioCount: number;
    unauthorizedAllows: number;
    results: { family: string }[];
  };
  const tools = JSON.parse(files["tool-selection-eval.json"]!) as {
    total: number;
    passed: number;
  };
  const byCategory = new Map<
    string,
    { total: number; contained: number; outcomes: Set<string> }
  >();
  for (const r of integrated.results) {
    const c = byCategory.get(r.category) ?? {
      total: 0,
      contained: 0,
      outcomes: new Set<string>(),
    };
    c.total += 1;
    if (r.contained) c.contained += 1;
    c.outcomes.add(r.evidence);
    byCategory.set(r.category, c);
  }
  const allOutcomes = new Set(integrated.results.map((r) => r.evidence));
  return {
    version: "break-authority-summary/v1",
    generatedAt: EVIDENCE_GENERATED_AT,
    scope: {
      railKind: integrated.railKind,
      providerEffectsExercised: integrated.providerEffectsExercised,
      realModelRun: false,
      independentReproduction: false,
      certificationClaim: false,
      note: "Production authority modules against a deterministic fake rail. No real money, no real model, no third-party reproduction.",
    },
    integrated: {
      scenarios: integrated.scenarioCount,
      uncontained: integrated.uncontainedScenarioIds.length,
      attackFamilies: byCategory.size,
      distinctContainmentOutcomes: allOutcomes.size,
      validControls: {
        passed: integrated.controls.filter((c) => c.passed).length,
        total: integrated.controls.length,
      },
      categories: [...byCategory.entries()].map(([category, c]) => ({
        category,
        scenarios: c.total,
        contained: c.contained,
        distinctOutcomes: c.outcomes.size,
      })),
    },
    kernelOnly: {
      scenarios: kernel.scenarioCount,
      unauthorizedAllows: kernel.unauthorizedAllows,
      families: new Set(kernel.results.map((r) => r.family)).size,
    },
    faultInjection: { total: faults.total, passed: faults.passed },
    conformance: {
      passed: conformance.passed,
      failed: conformance.failed,
      certificationClaim: conformance.certificationClaim,
    },
    toolSelection: {
      total: tools.total,
      passed: tools.passed,
      kind: "deterministic reference selector; no model was run",
    },
    sourceFileSha256: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        createHash("sha256").update(content, "utf8").digest("hex"),
      ]),
    ),
  };
}
