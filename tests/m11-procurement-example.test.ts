import { describe, expect, it } from "vitest";
import { runProcurementExample } from "../examples/procurement-ap-agent.js";

describe("M11 procurement / AP reference external agent", () => {
  it("runs the whole journey: pack clean, kernel ALLOW, UNKNOWN then reconciled with one effect, drift denied", async () => {
    const result = await runProcurementExample();
    expect(result.packViolations).toEqual([]);
    expect(result.kernelDecision).toBe("ALLOW");
    expect(result.executionOutcomeBeforeReconciliation).toBe("UNKNOWN");
    expect(result.reconciledState).toBe("SUCCEEDED");
    expect(result.providerEffects).toBe(1);
    expect(result.driftDecision).toBe("DENY");
    expect(result.driftCapability).toBeNull();
  });
});
