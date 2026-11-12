import postgres, { type Sql } from "postgres";
import {
  callerKey,
  GUARD_LIMITS,
  isSecureRequest,
  json,
  RequestGuard,
  sameOrigin,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  clearedSessionCookie,
  csrfFor,
  readSessionCookie,
  sessionCookie,
  SESSION_ABSOLUTE_MS,
  UserAuthService,
  type SessionView,
} from "../src/network/user-auth.js";

/**
 * /api/account — sign up, sign in, sign out, and "who am I".
 *
 * This is the public application's door to the account system that already existed in src/network/user-auth.ts and was
 * only ever reachable from the gateway nobody deployed. None of the security lives here: passwords are scrypt-hashed,
 * sessions are opaque server-side records, only digests are stored, and lockout, idle and absolute expiry are enforced by
 * that service. This file is the adapter — origin, rate limiting, cookie flags, CSRF on state changes, and refusals a
 * founder can read.
 *
 * A session is NOT a new kind of authority. It resolves to exactly one organization member, and nothing reachable from
 * here can spend money: there is no payment code on this host at all.
 *
 * With no DATABASE_URL the endpoint says so plainly rather than pretending accounts exist.
 */
// Brute force is answered by the account lockout (five wrong passwords, then a window), not by this; this is the coarse
// backstop, and it has to leave room for signing in, out and back in without telling an honest founder to wait a minute.
const writes = new RequestGuard({ perCaller: 15, perInstance: 120 });
const reads = new RequestGuard({ perCaller: 40, perInstance: 400 });

const NOT_CONFIGURED =
  "Accounts are not switched on for this site yet. You can still plan, explore and try the guided demo without one.";
const TROUBLE =
  "PayFlow could not reach your account just now. Nothing was changed. Please try again in a moment.";
/** Deliberately identical for every credential failure, so an answer never reveals whether an email is registered. */
const SIGN_IN_REFUSED =
  "That email and password did not match. Check them and try again.";

let sql: Sql | undefined;
let service: UserAuthService | undefined;
/** Resolved at call time so a deployment without a database degrades instead of failing to boot. */
function configured(): UserAuthService | undefined {
  if (service) return service;
  const url = process.env["DATABASE_URL"];
  if (!url) return undefined;
  try {
    sql ??= postgres(url, {
      max: 2,
      connect_timeout: 5,
      idle_timeout: 20,
      prepare: false,
    });
  } catch {
    // Fixed token only: a connection string is never logged.
    console.error("PAYFLOW_ACCOUNT_STORE_CONFIGURATION_INVALID");
    return undefined;
  }
  service = new UserAuthService({ sql, now: () => new Date().toISOString() });
  return service;
}

function noStore(
  status: number,
  body: Record<string, unknown>,
  cookie?: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(cookie ? { "set-cookie": cookie } : {}),
    },
  });
}

function identity(view: SessionView, sessionToken: string) {
  return {
    status: "SIGNED_IN" as const,
    user: {
      displayName: view.user.displayName,
      email: view.user.email,
      emailVerified: view.user.emailVerified,
    },
    workspace: {
      organizationId: view.member.organizationId,
      role: view.member.role,
      environment: view.member.environment,
    },
    // Derived from the session secret, which the browser cannot read: this is how a reloaded page gets its CSRF token back.
    csrfToken: csrfFor(sessionToken),
    expiresAt: view.expiresAt,
  };
}

function grantResponse(
  request: Request,
  grant: {
    sessionToken: string;
    csrfToken: string;
    expiresAt: string;
    user: { displayName: string; email: string; emailVerified: boolean };
    member: { organizationId: string; role: string; environment: string };
  },
): Response {
  const maxAge = Math.max(
    0,
    Math.floor(
      Math.min(SESSION_ABSOLUTE_MS, Date.parse(grant.expiresAt) - Date.now()) /
        1000,
    ),
  );
  return noStore(
    200,
    {
      status: "SIGNED_IN",
      user: {
        displayName: grant.user.displayName,
        email: grant.user.email,
        emailVerified: grant.user.emailVerified,
      },
      workspace: {
        organizationId: grant.member.organizationId,
        role: grant.member.role,
        environment: grant.member.environment,
      },
      csrfToken: grant.csrfToken,
      expiresAt: grant.expiresAt,
    },
    sessionCookie(grant.sessionToken, maxAge, isSecureRequest(request)),
  );
}

/** GET /api/account — who the caller is. Read-only, and never a reason to refuse a page. */
export async function handleAccountRead(
  request: Request,
  service: UserAuthService | undefined,
): Promise<Response> {
  if (!sameOrigin(request))
    return unavailable(
      403,
      "This endpoint only answers the PayFlow application.",
    );
  if (!service)
    return json(200, { status: "UNCONFIGURED", message: NOT_CONFIGURED });
  const token = readSessionCookie(request.headers.get("cookie") ?? undefined);
  if (!token) return json(200, { status: "SIGNED_OUT" });
  if (!reads.allow(callerKey(request), Date.now()))
    return unavailable(429, "Too many requests in a row. Give it a moment.");
  try {
    const view = await service.authenticate(token);
    // A token the server no longer honours should not stay in the browser.
    return view
      ? json(200, identity(view, token))
      : noStore(
          200,
          { status: "SIGNED_OUT" },
          clearedSessionCookie(isSecureRequest(request)),
        );
  } catch {
    console.error("PAYFLOW_ACCOUNT_READ_FAILED");
    return unavailable(503, TROUBLE);
  }
}

/** POST /api/account — {action: "signup" | "login" | "logout"}. */
export async function handleAccountWrite(
  request: Request,
  service: UserAuthService | undefined,
): Promise<Response> {
  if (!sameOrigin(request))
    return unavailable(
      403,
      "This endpoint only answers the PayFlow application.",
    );
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > GUARD_LIMITS.bodyBytes)
    return unavailable(413, "That request is too long.");
  if (!writes.allow(callerKey(request), Date.now()))
    return unavailable(
      429,
      "Too many attempts in a row. Give it a minute and try again.",
    );
  if (!service) return unavailable(503, NOT_CONFIGURED);

  let input: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > GUARD_LIMITS.bodyBytes)
      return unavailable(413, "That request is too long.");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("shape");
    input = parsed as Record<string, unknown>;
  } catch {
    return unavailable(400, "PayFlow could not read that request.");
  }

  const secure = isSecureRequest(request);
  try {
    if (input.action === "signup") {
      const created = await service.signup({
        email: input.email,
        password: input.password,
        displayName: input.displayName,
        organizationName: input.organizationName,
      });
      if (!created.ok)
        return unavailable(
          created.refusal === "EMAIL_UNAVAILABLE" ? 409 : 400,
          created.refusal === "WEAK_PASSWORD"
            ? "Choose a longer password that is not your email address and not a handful of repeated characters."
            : created.refusal === "EMAIL_UNAVAILABLE"
              ? "That email cannot be used to create a new account. If it is yours, sign in instead."
              : "Check the details and try again: PayFlow needs your name, a workspace name, a valid email and a password.",
        );
      // Signing up signs you in: a founder should not type the same password twice in a row.
      const entered = await service.login({
        email: input.email,
        password: input.password,
      });
      return entered.ok && "grant" in entered
        ? grantResponse(request, entered.grant)
        : json(200, {
            status: "CREATED",
            message: "Your account is ready. Sign in to continue.",
          });
    }

    if (input.action === "login") {
      const entered = await service.login({
        email: input.email,
        password: input.password,
        ...(typeof input.organizationId === "string"
          ? { organizationId: input.organizationId }
          : {}),
      });
      if (!entered.ok) return unavailable(401, SIGN_IN_REFUSED);
      if (!("grant" in entered))
        // A second factor is configured but this surface cannot carry it yet; say so rather than fail opaquely.
        return unavailable(
          503,
          "This account needs a second step to sign in, which this page cannot do yet.",
        );
      return grantResponse(request, entered.grant);
    }

    if (input.action === "logout") {
      const token = readSessionCookie(
        request.headers.get("cookie") ?? undefined,
      );
      // Signing out always clears the cookie, even when the session was already gone.
      const cleared = clearedSessionCookie(secure);
      if (!token) return noStore(200, { status: "SIGNED_OUT" }, cleared);
      const view = await service.authenticate(token);
      if (!view) return noStore(200, { status: "SIGNED_OUT" }, cleared);
      // A state change needs the token only this origin's own page could have read.
      if (
        !service.csrfMatches(
          view,
          request.headers.get("x-payflow-csrf") ?? undefined,
        )
      )
        return noStore(
          403,
          {
            status: "SIGNED_OUT",
            message:
              "That sign-out could not be verified, so you were signed out here anyway.",
          },
          cleared,
        );
      await service.logout(token);
      return noStore(200, { status: "SIGNED_OUT" }, cleared);
    }

    return unavailable(400, "PayFlow could not read that request.");
  } catch {
    console.error("PAYFLOW_ACCOUNT_WRITE_FAILED");
    return unavailable(503, TROUBLE);
  }
}

export function GET(request: Request): Promise<Response> {
  return handleAccountRead(request, configured());
}
export function POST(request: Request): Promise<Response> {
  return handleAccountWrite(request, configured());
}
