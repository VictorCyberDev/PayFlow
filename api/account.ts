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
  UserAuthService,
  SESSION_ABSOLUTE_MS,
  type SessionView,
} from "../src/network/user-auth.js";

/**
 * /api/account — sign up, sign in, sign out, and "who am I".
 *
 * This is the public application's door to the account system that already existed in src/network/user-auth.ts and was only
 * ever reachable from the undeployed gateway. None of the security lives here: passwords are scrypt-hashed, sessions are
 * opaque server-side records, only digests are stored, and lockout, idle and absolute expiry are enforced by that service.
 * This file is the adapter — origin, rate limiting, cookie flags, CSRF on state changes, and customer-readable refusals.
 *
 * A session is NOT a new kind of authority. It resolves to exactly one organization member, and nothing here can spend money:
 * there is no payment code on this host at all.
 *
 * With no DATABASE_URL the endpoint says so plainly rather than pretending accounts exist.
 */
const writes = new RequestGuard();
const reads = new RequestGuard();

let sql: Sql | undefined;
let service: UserAuthService | undefined;
function auth(): UserAuthService | undefined {
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

const NOT_CONFIGURED =
  "Accounts are not switched on for this site yet. You can still plan, explore and try the guided demo without one.";
const TROUBLE =
  "PayFlow could not reach your account just now. Nothing was changed. Please try again in a moment.";

/** Deliberately identical for every credential failure, so an answer never reveals whether an email is registered. */
const SIGN_IN_REFUSED =
  "That email and password did not match. Check them and try again.";

function who(view: SessionView, sessionToken: string) {
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

/** GET /api/account — who the caller is. Cheap, read-only, and never a reason to refuse a page. */
export async function GET(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return unavailable(
      403,
      "This endpoint only answers the PayFlow application.",
    );
  const service = auth();
  if (!service)
    return json(200, { status: "UNCONFIGURED", message: NOT_CONFIGURED });
  const token = readSessionCookie(request.headers.get("cookie") ?? undefined);
  if (!token) return json(200, { status: "SIGNED_OUT" });
  if (!reads.allow(callerKey(request), Date.now()))
    return unavailable(429, "Too many requests in a row. Give it a moment.");
  try {
    const view = await service.authenticate(token);
    if (!view)
      return new Response(JSON.stringify({ status: "SIGNED_OUT" }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          // A token the server no longer honours should not stay in the browser.
          "set-cookie": clearedSessionCookie(isSecureRequest(request)),
        },
      });
    return json(200, who(view, token));
  } catch {
    console.error("PAYFLOW_ACCOUNT_READ_FAILED");
    return unavailable(503, TROUBLE);
  }
}

function signedIn(
  request: Request,
  body: Record<string, unknown>,
  token: string,
  expiresAt: string,
): Response {
  const maxAge = Math.max(
    0,
    Math.floor(
      Math.min(SESSION_ABSOLUTE_MS, Date.parse(expiresAt) - Date.now()) / 1000,
    ),
  );
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "set-cookie": sessionCookie(token, maxAge, isSecureRequest(request)),
    },
  });
}

/** POST /api/account — {action: "signup" | "login" | "logout"}. */
export async function POST(request: Request): Promise<Response> {
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
  const service = auth();
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

  try {
    switch (input.action) {
      case "signup": {
        const r = await service.signup({
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          organizationName: input.organizationName,
        });
        if (!r.ok)
          return unavailable(
            r.refusal === "EMAIL_UNAVAILABLE" ? 409 : 400,
            r.refusal === "WEAK_PASSWORD"
              ? "Choose a longer password that is not your email address and not a handful of repeated characters."
              : r.refusal === "EMAIL_UNAVAILABLE"
                ? "That email cannot be used to create a new account. If it is yours, sign in instead."
                : "Check the details and try again: PayFlow needs your name, a workspace name, a valid email and a password.",
          );
        // Signing up signs you in: a founder should not have to type the same password twice in a row.
        const login = await service.login({
          email: input.email,
          password: input.password,
        });
        if (!login.ok || !("grant" in login))
          return json(200, {
            status: "CREATED",
            message: "Your account is ready. Sign in to continue.",
          });
        return signedIn(
          request,
          {
            status: "SIGNED_IN",
            user: {
              displayName: login.grant.user.displayName,
              email: login.grant.user.email,
              emailVerified: login.grant.user.emailVerified,
            },
            workspace: {
              organizationId: login.grant.member.organizationId,
              role: login.grant.member.role,
              environment: login.grant.member.environment,
            },
            csrfToken: login.grant.csrfToken,
            expiresAt: login.grant.expiresAt,
          },
          login.grant.sessionToken,
          login.grant.expiresAt,
        );
      }

      case "login": {
        const r = await service.login({
          email: input.email,
          password: input.password,
          ...(typeof input.organizationId === "string"
            ? { organizationId: input.organizationId }
            : {}),
        });
        if (!r.ok) return unavailable(401, SIGN_IN_REFUSED);
        if (!("grant" in r))
          // A second factor is configured but this surface cannot carry it yet; say so rather than fail opaquely.
          return unavailable(
            503,
            "This account needs a second step to sign in, which this page cannot do yet.",
          );
        return signedIn(
          request,
          {
            status: "SIGNED_IN",
            user: {
              displayName: r.grant.user.displayName,
              email: r.grant.user.email,
              emailVerified: r.grant.user.emailVerified,
            },
            workspace: {
              organizationId: r.grant.member.organizationId,
              role: r.grant.member.role,
              environment: r.grant.member.environment,
            },
            csrfToken: r.grant.csrfToken,
            expiresAt: r.grant.expiresAt,
          },
          r.grant.sessionToken,
          r.grant.expiresAt,
        );
      }

      case "logout": {
        const token = readSessionCookie(
          request.headers.get("cookie") ?? undefined,
        );
        // Signing out always clears the cookie, even when the session was already gone.
        const clear = (status: number, body: Record<string, unknown>) =>
          new Response(JSON.stringify(body), {
            status,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "set-cookie": clearedSessionCookie(isSecureRequest(request)),
            },
          });
        if (!token) return clear(200, { status: "SIGNED_OUT" });
        const view = await service.authenticate(token);
        if (!view) return clear(200, { status: "SIGNED_OUT" });
        // A state change needs the token only this origin's page could have read.
        if (
          !service.csrfMatches(
            view,
            request.headers.get("x-payflow-csrf") ?? undefined,
          )
        )
          return clear(403, {
            status: "SIGNED_OUT",
            message:
              "That sign-out could not be verified, so you were signed out anyway.",
          });
        await service.logout(token);
        return clear(200, { status: "SIGNED_OUT" });
      }

      default:
        return unavailable(400, "PayFlow could not read that request.");
    }
  } catch {
    console.error("PAYFLOW_ACCOUNT_WRITE_FAILED");
    return unavailable(503, TROUBLE);
  }
}
