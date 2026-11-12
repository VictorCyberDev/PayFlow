import { Buffer } from "node:buffer";

/**
 * The shared guard for the public customer endpoints.
 *
 * These endpoints are unauthenticated on purpose: a founder must be able to start without an account (mandate section 7).
 * That makes abuse the real risk, so every one of them is same-origin, bounded in body size, and rate limited.
 *
 * The limiter is per warm instance and therefore BEST EFFORT. Serverless instances are ephemeral and concurrent, so it bounds
 * a burst from one caller, not a distributed flood. It is the honest ceiling available without shared state, and it is said
 * here rather than presented as a guarantee.
 */
export const GUARD_LIMITS = Object.freeze({
  bodyBytes: 4_096,
  windowMs: 60_000,
  perCallerPerWindow: 5,
  perInstancePerWindow: 60,
  maxTrackedCallers: 2_000,
});

type Bucket = { count: number; resetAt: number };

export class RequestGuard {
  readonly #callers = new Map<string, Bucket>();
  #instance: Bucket = { count: 0, resetAt: 0 };

  allow(caller: string, now: number): boolean {
    if (now >= this.#instance.resetAt)
      this.#instance = { count: 0, resetAt: now + GUARD_LIMITS.windowMs };
    if (this.#instance.count >= GUARD_LIMITS.perInstancePerWindow) return false;
    if (this.#callers.size > GUARD_LIMITS.maxTrackedCallers)
      this.#callers.clear();
    const existing = this.#callers.get(caller);
    const bucket =
      !existing || now >= existing.resetAt
        ? { count: 0, resetAt: now + GUARD_LIMITS.windowMs }
        : existing;
    if (bucket.count >= GUARD_LIMITS.perCallerPerWindow) {
      this.#callers.set(caller, bucket);
      return false;
    }
    bucket.count += 1;
    this.#instance.count += 1;
    this.#callers.set(caller, bucket);
    return true;
  }
}

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function unavailable(status: number, message: string): Response {
  return json(status, { status: "UNAVAILABLE", message });
}

/**
 * Same-origin check that survives a reverse proxy.
 *
 * Behind Vercel the request URL a function sees is not guaranteed to carry the host the browser typed, so comparing the
 * Origin against it alone risks rejecting every legitimate request. The public host arrives in `x-forwarded-host` (and
 * `host`), so any of the three matching is accepted. A genuine cross-origin POST still fails all three.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // a same-origin fetch may omit it; the body shape still has to be right
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (!originHost) return false;
  const candidates = new Set<string>();
  for (const header of ["x-forwarded-host", "host"]) {
    const value = request.headers.get(header);
    // A proxy may append; the first entry is the one the browser asked for.
    const first = (value ?? "").split(",")[0]?.trim().toLowerCase();
    if (first) candidates.add(first);
  }
  try {
    candidates.add(new URL(request.url).host.toLowerCase());
  } catch {
    /* a relative or malformed request URL simply contributes no candidate */
  }
  return candidates.has(originHost);
}

function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return (forwarded.split(",")[0] ?? "").trim().slice(0, 64) || "unknown";
}

/** Returns the parsed body, or the Response to send instead. Customer-readable messages only: no codes, no provider names. */
export async function readGuardedBody(
  request: Request,
  guard: RequestGuard,
  now: number,
): Promise<{ body: Record<string, unknown> } | { refusal: Response }> {
  if (request.method !== "POST")
    return { refusal: unavailable(405, "Send your request with a POST.") };
  if (!sameOrigin(request))
    return {
      refusal: unavailable(
        403,
        "This endpoint only answers the PayFlow application.",
      ),
    };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > GUARD_LIMITS.bodyBytes)
    return {
      refusal: unavailable(413, "That is too long. A few sentences is plenty."),
    };
  if (!guard.allow(callerKey(request), now))
    return {
      refusal: unavailable(
        429,
        "You have asked for several things in a row. Give it a minute and try again.",
      ),
    };
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return {
      refusal: unavailable(400, "PayFlow could not read that request."),
    };
  }
  if (Buffer.byteLength(raw) > GUARD_LIMITS.bodyBytes)
    return {
      refusal: unavailable(413, "That is too long. A few sentences is plenty."),
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      refusal: unavailable(400, "PayFlow could not read that request."),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {
      refusal: unavailable(400, "PayFlow could not read that request."),
    };
  return { body: parsed as Record<string, unknown> };
}
