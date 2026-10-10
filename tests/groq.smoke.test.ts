import { expect, it } from "vitest";
import {
  GroqIntentModelProvider,
  interpretIntent,
} from "../src/intent-model.js";

// Explicit opt-in only: normal test/CI evaluation constructs no real provider.
const enabled = process.env.RUN_GROQ_SMOKE_TEST === "true";
it.skipIf(!enabled)(
  "opt-in real Groq interpretation, strict validation and safe compiler result",
  async () => {
    if (!process.env.GROQ_API_KEY)
      throw new Error("GROQ_SMOKE_CREDENTIAL_UNAVAILABLE");
    const result = await interpretIntent(
      GroqIntentModelProvider.fromEnvironment(),
      {
        source: {
          reference: "groq-smoke",
          text: "Buy me a new wireless keyboard under $100. You don't need to ask again if it stays within those rules.",
        },
        now: new Date().toISOString(),
        reviewBounds: {
          maximumMinor: 9999,
          quantity: 1,
          conditions: ["NEW"],
          capabilities: [
            "SEARCH_PRODUCTS",
            "EVALUATE_PRODUCTS",
            "CREATE_ORDER",
            "CAPTURE_PAYMENT",
          ],
        },
      },
    );
    // Report only fixed states, never raw model text/HTTP errors/credentials.
    if (result.status !== "INTERPRETED")
      throw new Error(`GROQ_SMOKE_${result.status}`);
    if (result.compilation.status !== "NEEDS_CLARIFICATION")
      throw new Error("GROQ_SMOKE_EXPECTED_CLARIFICATION");
    expect(result.questions.length).toBeGreaterThan(0);
    expect("draft" in result.compilation).toBe(false);
  },
  20000,
);
