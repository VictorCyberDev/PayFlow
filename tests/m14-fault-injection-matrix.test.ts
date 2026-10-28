import { describe, expect, it } from "vitest";
import {
  FAULT_INJECTION_MATRIX,
  runFaultInjectionMatrix,
} from "../src/network/fault-injection.js";

const requiredTitles = [
  "agent changes amount",
  "merchant substitution",
  "SKU substitution",
  "condition substitution",
  "quantity widening",
  "currency change",
  "fee widening",
  "revoked Authority",
  "expired Authority",
  "suspended Authority",
  "wrong agent",
  "stale assertion",
  "forged assertion",
  "replay",
  "duplicate callback",
  "concurrent execution",
  "duplicated webhook",
  "delayed webhook",
  "dropped response",
  "provider timeout",
  "provider effect followed by network failure",
  "ambiguous provider state",
  "database retry",
  "crash after reservation",
  "crash after grant",
  "crash after provider create",
  "crash after capture",
  "reconciliation racing new execution",
  "tampered Proof",
  "stale Proof",
  "downstream delegation widening",
  "privilege escalation",
  "duplicate A2A request",
  "duplicated MCP invocation",
  "malformed commerce context",
  "unsupported action type",
  "unsupported rail",
  "negative/zero/extreme amounts",
  "precision/rounding cases",
  "cross-currency mismatch",
  "fee mismatch",
] as const;

describe("M14 reusable fault-injection matrix", () => {
  it("contains every mandated fault family exactly once", () => {
    const titles = FAULT_INJECTION_MATRIX.map((scenario) => scenario.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of requiredTitles) expect(titles).toContain(title);
  });

  it("produces machine-readable pass/fail evidence from a pluggable injector", async () => {
    const report = await runFaultInjectionMatrix((scenario) => ({
      scenarioId: scenario.id,
      actual: scenario.expected,
      evidence: `reference-harness:${scenario.domain}:${scenario.invariant}`,
    }));
    expect(report.total).toBe(requiredTitles.length);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
  });

  it("does not hide a boundary failure", async () => {
    const report = await runFaultInjectionMatrix((scenario) => ({
      scenarioId: scenario.id,
      actual:
        scenario.id === "forged-assertion" ? "UNKNOWN" : scenario.expected,
      evidence: "deliberate-negative-control",
    }));
    expect(report.failed).toBe(1);
    expect(
      report.results.find((result) => result.scenarioId === "forged-assertion")
        ?.pass,
    ).toBe(false);
  });
});
