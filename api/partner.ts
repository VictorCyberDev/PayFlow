import {
  GroqPartnerModel,
  planForFounder,
  type PartnerFailure,
  type PartnerModel,
} from "../src/partner/founder-plan.js";

/**
 * POST /api/partner — the founder business partner.
 *
 * This is the first request-time code the public customer application has ever had. It exists so the AI partner is real rather
 * than theatre: it calls Groq with the key this project already holds, server-side, and returns a PLAN. It authorizes nothing,
 * touches no database, and is deliberately not connected to payment execution — PayPal stays on the isolated acceptance host.
 *
 * It is unauthenticated because a founder must be able to start without an account (mandate §7). That makes abuse the real
 * risk, so the endpoint is same-origin only, bounded in body size, and rate limited. The limiter is per warm instance and
 * therefore BEST EFFORT: serverless instances are ephemeral and concurrent, so it bounds a burst from one caller, not a
 * distributed flood. It is the honest ceiling available without shared state, and it is documented as such rather than
 * presented as a guarantee.
 */
const MAX_BODY_BYTES = 4_096;
const WINDOW_MS = 60_000;
const PER_CALLER_PER_WINDOW = 5;
const PER_INSTANCE_PER_WINDOW = 60;

type Bucket = { count: number; resetAt: number };
const callers = new Map<string, Bucket>();
let instance: Bucket = { count: 0, resetAt: 0 };

function allow(caller: string, now: number): boolean {
  if (now >= instance.resetAt)
    instance = { count: 0, resetAt: now + WINDOW_MS };
  if (instance.count >= PER_INSTANCE_PER_WINDOW) return false;
  if (callers.size > 2_000) callers.clear();
  const existing = callers.get(caller);
  const bucket =
    !existing || now >= existing.resetAt
      ? { count: 0, resetAt: now + WINDOW_MS }
      : existing;
  if (bucket.count >= PER_CALLER_PER_WINDOW) {
    callers.set(caller, bucket);
    return false;
  }
  bucket.count += 1;
  instance.count += 1;
  callers.set(caller, bucket);
  return true;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Customer-readable. No provider names, no error codes, no infrastructure (mandate §24.9). */
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

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetch may omit it; the body shape still has to be right
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return (forwarded.split(",")[0] ?? "").trim().slice(0, 64) || "unknown";
}

/** Injectable for tests; production resolves the key from the environment at call time. */
export async function handlePartnerRequest(
  request: Request,
  model: PartnerModel | undefined,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method !== "POST")
    return json(405, {
      status: "UNAVAILABLE",
      message: "Send your goal with a POST request.",
    });
  if (!sameOrigin(request))
    return json(403, {
      status: "UNAVAILABLE",
      message: "This endpoint only answers the PayFlow application.",
    });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return json(413, {
      status: "UNAVAILABLE",
      message: "That goal is too long. A few sentences is plenty.",
    });
  if (!allow(callerKey(request), now))
    return json(429, {
      status: "UNAVAILABLE",
      message:
        "You have asked for several plans in a row. Give it a minute and try again.",
    });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json(400, {
      status: "UNAVAILABLE",
      message: "PayFlow could not read that request.",
    });
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES)
    return json(413, {
      status: "UNAVAILABLE",
      message: "That goal is too long. A few sentences is plenty.",
    });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, {
      status: "UNAVAILABLE",
      message: "PayFlow could not read that request.",
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json(400, {
      status: "UNAVAILABLE",
      message: "PayFlow could not read that request.",
    });
  const input = body as Record<string, unknown>;

  const result = await planForFounder(model, {
    goal: typeof input.goal === "string" ? input.goal : "",
    currency: typeof input.currency === "string" ? input.currency : undefined,
    budgetMinor:
      typeof input.budgetMinor === "number" ? input.budgetMinor : null,
  });
  if (result.status !== "PLANNED")
    return json(STATUS[result.status], {
      status: "UNAVAILABLE",
      message: MESSAGES[result.status],
    });
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
