import { describe, expect, it } from "vitest";
import { ENV_CONTRACT, assess } from "../src/ops/env-contract.js";
import { parseHostedConfig } from "../src/console-hosted.js";

/** The contract is checked against the REAL parser, so it cannot drift from the code or from what the owner is told to set. */
const sample = (name: string): string => {
  if (name === "PAYFLOW_M5_DEMO") return "true";
  if (name === "PAYFLOW_M5_ORIGIN") return "https://example.test";
  if (name === "DATABASE_URL") return "postgres://x:y@localhost:5432/z";
  if (name === "PAYFLOW_M5_BOOTSTRAP_KEY") return "k".repeat(40);
  return "x".repeat(40);
};
const hostStart = ENV_CONTRACT.filter((v) => v.need === "HOST_START").map(
  (v) => v.name,
);
const full = Object.fromEntries(hostStart.map((n) => [n, sample(n)]));

describe("hosted environment contract", () => {
  it("the HOST_START set is exactly what the parser needs: all present parses, each one removed fails", () => {
    expect(() => parseHostedConfig(full)).not.toThrow();
    for (const n of hostStart) {
      const { [n]: _drop, ...rest } = full;
      void _drop;
      expect(() => parseHostedConfig(rest), n).toThrow();
    }
  });
  it("enabling the demo agent makes the signing key mandatory, as the contract says", () => {
    const withDemo = { ...full, PAYFLOW_M6_DEMO_AGENT: "true" };
    expect(() => parseHostedConfig(withDemo)).toThrow();
    expect(() =>
      parseHostedConfig({
        ...withDemo,
        PAYFLOW_M6_SIGNING_KEY: "s".repeat(50),
      }),
    ).not.toThrow();
  });
  it("assess reports names only and flags the current payflow-public gap", () => {
    // the plain names that exist on payflow-public today (read from the project in the 2026-11-10 session; values were not read)
    const today = new Set([
      "PAYFLOW_M5_ORIGIN",
      "PAYFLOW_M5_DEMO",
      "PAYFLOW_M6_DEMO_AGENT",
      "PAYFLOW_PUBLIC_SANDBOX",
      "PAYFLOW_M5_PRINCIPAL_ID",
      "PAYFLOW_M5_AGENT_ID",
      "PAYFLOW_M6_SIGNING_KID",
    ]);
    const r = assess(today);
    expect(r.ready).toBe(false);
    expect(r.missingHostStart).toEqual([
      "DATABASE_URL",
      "PAYFLOW_M5_BOOTSTRAP_KEY",
    ]);
    // The host signing key is what mounts the customer application (Proof cannot be signed without
    // it). PAYFLOW_M6_DEMO_AGENT, which this project also has set, only adds financial mode on top,
    // so the key is reported twice: once as the app's own requirement, once as that switch's.
    expect(r.missingCustomerApp).toEqual(["PAYFLOW_M6_SIGNING_KEY"]);
    expect(r.missingForEnabledFeatures).toEqual([
      "PAYFLOW_M6_SIGNING_KEY",
      "CRON_SECRET",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/postgres:|\bx{20}/u);
  });
  it("every variable the contract calls secret is not given a plain-text sample elsewhere in the repo's hosting config", async () => {
    const { readFileSync } = await import("node:fs");
    const vj = readFileSync("hosting/m6/vercel.json", "utf8");
    for (const v of ENV_CONTRACT.filter((x) => x.secret))
      expect(vj).not.toContain(v.name + '": "');
  });
});
