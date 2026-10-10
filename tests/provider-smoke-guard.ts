type Environment = Readonly<Record<string, string | undefined>>;
export type SmokeProvider = "GROQ" | "PAYPAL_SANDBOX" | "CHANNEL3";

/** Test-only guard. Credentials never opt a test in; exact lowercase true does. */
export function smokeTestEnabled(
  provider: SmokeProvider,
  env: Environment,
): boolean {
  return env[`RUN_${provider}_SMOKE_TEST`] === "true";
}

/** Run only after explicit opt-in, before constructing a real provider. */
export function requireSmokeConfiguration(
  provider: SmokeProvider,
  env: Environment,
): void {
  const required =
    provider === "GROQ"
      ? ["GROQ_API_KEY"]
      : provider === "CHANNEL3"
        ? ["CHANNEL3_API_KEY"]
        : ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"];
  if (
    !required.every((key) => Boolean(env[key]?.trim())) ||
    (provider === "PAYPAL_SANDBOX" && env.PAYPAL_ENVIRONMENT !== "sandbox")
  )
    throw new Error(`${provider}_SMOKE_CONFIGURATION_UNAVAILABLE`);
}
