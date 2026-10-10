import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  smokeTestEnabled,
  requireSmokeConfiguration,
  type SmokeProvider,
} from "./provider-smoke-guard.js";

const credentials = {
  GROQ_API_KEY: "synthetic-groq",
  CHANNEL3_API_KEY: "synthetic-channel",
  PAYPAL_CLIENT_ID: "synthetic-id",
  PAYPAL_CLIENT_SECRET: "synthetic-secret",
  PAYPAL_ENVIRONMENT: "sandbox",
};
describe("explicit live-provider smoke guards (no network)", () => {
  it.each(["GROQ", "PAYPAL_SANDBOX", "CHANNEL3"] as SmokeProvider[])(
    "%s credentials cannot opt in",
    (provider) => {
      for (const flag of [
        undefined,
        "false",
        "1",
        "yes",
        "TRUE",
        "TRUE-ish",
        "enabled",
        " true",
        "true ",
        "",
      ]) {
        for (const secrets of [{}, credentials]) {
          const env = { ...secrets, [`RUN_${provider}_SMOKE_TEST`]: flag };
          const effect = vi.fn();
          if (smokeTestEnabled(provider, env)) {
            requireSmokeConfiguration(provider, env);
            effect();
          }
          expect(effect, `${provider}:${String(flag)}`).not.toHaveBeenCalled();
        }
      }
    },
  );
  it.each(["GROQ", "PAYPAL_SANDBOX", "CHANNEL3"] as SmokeProvider[])(
    "%s exact opt-in plus configuration is eligible",
    (provider) => {
      const env = { ...credentials, [`RUN_${provider}_SMOKE_TEST`]: "true" };
      const effect = vi.fn();
      expect(smokeTestEnabled(provider, env)).toBe(true);
      requireSmokeConfiguration(provider, env);
      effect();
      expect(effect).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["GROQ", "PAYPAL_SANDBOX", "CHANNEL3"] as SmokeProvider[])(
    "%s explicit opt-in without configuration fails before effect",
    (provider) => {
      const env = { [`RUN_${provider}_SMOKE_TEST`]: "true" };
      const effect = vi.fn();
      expect(smokeTestEnabled(provider, env)).toBe(true);
      expect(() => {
        requireSmokeConfiguration(provider, env);
        effect();
      }).toThrow(`${provider}_SMOKE_CONFIGURATION_UNAVAILABLE`);
      expect(effect).not.toHaveBeenCalled();
    },
  );
  it.each(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT"])(
    "missing/invalid %s prevents PayPal provider construction",
    (key) => {
      for (const value of [
        undefined,
        "",
        " ",
        ...(key === "PAYPAL_ENVIRONMENT" ? ["live", "Sandbox"] : []),
      ]) {
        expect(() =>
          requireSmokeConfiguration("PAYPAL_SANDBOX", {
            ...credentials,
            [key]: value,
          }),
        ).toThrow("PAYPAL_SANDBOX_SMOKE_CONFIGURATION_UNAVAILABLE");
      }
    },
  );
  it("real smoke suites use guard before provider construction and templates default off", async () => {
    const paypal = await readFile("tests/paypal.sandbox.test.ts", "utf8");
    const groq = await readFile("tests/groq.smoke.test.ts", "utf8");
    expect(paypal).toContain('smokeTestEnabled("PAYPAL_SANDBOX", process.env)');
    expect(
      paypal.indexOf(
        'requireSmokeConfiguration("PAYPAL_SANDBOX", process.env)',
      ),
    ).toBeLessThan(paypal.indexOf("const provider = paypalProviderFromEnv()"));
    expect(groq).toContain('smokeTestEnabled("GROQ", process.env)');
    expect(
      groq.indexOf('requireSmokeConfiguration("GROQ", process.env)'),
    ).toBeLessThan(groq.indexOf("GroqIntentModelProvider.fromEnvironment()"));
    const template = await readFile(".env.example", "utf8");
    for (const provider of [
      "GROQ",
      "PAYPAL_SANDBOX",
      "CHANNEL3",
    ] as SmokeProvider[]) {
      expect(template).toContain(`RUN_${provider}_SMOKE_TEST=false`);
      expect(smokeTestEnabled(provider, {})).toBe(false);
    }
  });
});
