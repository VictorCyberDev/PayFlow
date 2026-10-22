import { describe, expect, it } from "vitest";
import { paypalProviderFromEnv } from "../src/paypal.js";

const env = {
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_RETURN_URL: "https://payflow.test/paypal/return",
  PAYPAL_CANCEL_URL: "https://payflow.test/paypal/cancel",
};
describe("payer destination fail-closed configuration", () => {
  it.each(["PAYPAL_RETURN_URL", "PAYPAL_CANCEL_URL"])(
    "requires %s as part of a pair",
    (key) => {
      expect(() => paypalProviderFromEnv({ ...env, [key]: "" })).toThrow(
        "PAYPAL_PAYER_RETURN_CONFIGURATION_REQUIRED",
      );
    },
  );
  it.each([
    "http://payflow.test/paypal/return",
    "https://payflow.test/paypal/return?next=other",
    "https://payflow.test/paypal/return?",
    "https://payflow.test/paypal/return#fragment",
    "https://payflow.test/paypal/return#",
    "https://user:secret@payflow.test/paypal/return",
    "not a URL",
    " https://payflow.test/paypal/return",
    "https://payflow.test/\nreturn",
  ])("rejects unsafe destination %s", (value) => {
    for (const key of ["PAYPAL_RETURN_URL", "PAYPAL_CANCEL_URL"])
      expect(() => paypalProviderFromEnv({ ...env, [key]: value })).toThrow();
  });
});
