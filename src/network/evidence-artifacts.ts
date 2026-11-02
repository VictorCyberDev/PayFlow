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
  return {
    "break-authority-kernel-1000.json": json(runBreakAuthorityBenchmark(1000)),
    "break-authority-integrated-100.json": json(integrated100),
    "break-authority-integrated-1000.json": json(integrated1000),
    "fault-injection-report.json": json(faults),
    "conformance-report.json": json(conformance),
    "tool-selection-eval.json": json(runToolSelectionEval()),
  };
}
