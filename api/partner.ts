import {
  readGuardedBody,
  RequestGuard,
  json,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  GroqPartnerModel,
  planForFounder,
  type PartnerFailure,
  type PartnerModel,
} from "../src/partner/founder-plan.js";

/**
 * POST /api/partner — the founder business partner.
 *
 * The first request-time code the public customer application has ever had. It calls Groq server-side and returns a PLAN.
 * It authorizes nothing, touches no database, and is deliberately not connected to payment execution — PayPal stays on the
 * isolated acceptance host.
 */
const guard = new RequestGuard();

/** Customer-readable. No provider names, no error codes, no infrastructure (mandate section 24.9). */
const MESSAGES: Readonly<Record<PartnerFailure, string>> = Object.freeze({
  MODEL_NOT_CONFIGURED:
    "The planning assistant is not switched on for this site yet. Everything else still works, and you can try the guided demo.",
  MODEL_UNAVAILABLE:
    "The planning assistant is busy right now. Nothing was started. Please try again in a moment.",
  MODEL_TIMEOUT:
    "That took too long, so PayFlow stopped. Nothing was started. Try again, or shorten the goal.",
  MODEL_REJECTED:
    "PayFlow could not plan that one. Try describing the business goal in your own words.",
  INVALID_MODEL_OUTPUT:
    "PayFlow could not read the answer it got back, so it is not showing you a plan it does not trust.",
  INVALID_INPUT:
    "Tell PayFlow a little more about what you want to get done — a sentence is enough.",
});
const STATUS: Readonly<Record<PartnerFailure, number>> = Object.freeze({
  MODEL_NOT_CONFIGURED: 503,
  MODEL_UNAVAILABLE: 503,
  MODEL_TIMEOUT: 504,
  MODEL_REJECTED: 422,
  INVALID_MODEL_OUTPUT: 502,
  INVALID_INPUT: 400,
});

/** Injectable for tests; production resolves the key from the environment at call time. */
export async function handlePartnerRequest(
  request: Request,
  model: PartnerModel | undefined,
  now: number = Date.now(),
): Promise<Response> {
  const read = await readGuardedBody(request, guard, now);
  if ("refusal" in read) return read.refusal;
  const input = read.body;
  const result = await planForFounder(model, {
    goal: typeof input.goal === "string" ? input.goal : "",
    currency: typeof input.currency === "string" ? input.currency : undefined,
    budgetMinor:
      typeof input.budgetMinor === "number" ? input.budgetMinor : null,
  });
  if (result.status !== "PLANNED")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, {
    status: "PLANNED",
    plan: result.plan,
    // Stated so no reader can mistake a proposal for something that happened.
    disclosure:
      "This is a proposal. PayFlow has not bought, booked, hired, sent or paid anything.",
  });
}

export function POST(request: Request): Promise<Response> {
  return handlePartnerRequest(request, GroqPartnerModel.fromEnvironment());
}
