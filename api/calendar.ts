import postgres, { type Sql } from "postgres";
import {
  callerKey,
  GUARD_LIMITS,
  json,
  RequestGuard,
  sameOrigin,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  readSessionCookie,
  UserAuthService,
  type SessionView,
} from "../src/network/user-auth.js";
import {
  WorkspaceCalendar,
  type CalendarFailure,
} from "../src/partner/calendar.js";

/**
 * /api/calendar — PayFlow's own calendar, scoped to the signed-in workspace.
 *
 * Unlike the other surfaces on this host, this one REQUIRES a session, because a calendar belongs to somebody. The
 * organization is taken from the session, never from the request, so no caller can read or write another workspace's
 * week by asking. Writes additionally need the CSRF token, like every other state change here.
 */
const reads = new RequestGuard({ perCaller: 40, perInstance: 400 });
const writes = new RequestGuard({ perCaller: 20, perInstance: 150 });

const NOT_CONFIGURED =
  "The calendar is not switched on for this site yet. You can still plan, explore and try the guided demo.";
const NEEDS_SIGN_IN =
  "Sign in to see your calendar. It belongs to your workspace, so PayFlow will not show it to someone who is not in one.";

const MESSAGES: Readonly<Record<CalendarFailure, string>> = Object.freeze({
  INVALID_INPUT:
    "Check the details: PayFlow needs a title and a start time it can read.",
  WINDOW_TOO_WIDE:
    "That is too long a stretch to show at once. Ask for a year or less.",
  STORE_UNAVAILABLE:
    "PayFlow could not reach your calendar just now. Nothing was changed. Please try again in a moment.",
});
const STATUS: Readonly<Record<CalendarFailure, number>> = Object.freeze({
  INVALID_INPUT: 400,
  WINDOW_TOO_WIDE: 400,
  STORE_UNAVAILABLE: 503,
});

let sql: Sql | undefined;
let auth: UserAuthService | undefined;
let calendar: WorkspaceCalendar | undefined;
function configured():
  { auth: UserAuthService; calendar: WorkspaceCalendar } | undefined {
  if (auth && calendar) return { auth, calendar };
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
    console.error("PAYFLOW_CALENDAR_STORE_CONFIGURATION_INVALID");
    return undefined;
  }
  const now = () => new Date().toISOString();
  auth ??= new UserAuthService({ sql, now });
  calendar ??= new WorkspaceCalendar(sql, now);
  return { auth, calendar };
}

/** Resolves the caller to one workspace, or refuses. The organization never comes from the request body. */
async function workspace(
  request: Request,
  service: UserAuthService,
): Promise<SessionView | Response> {
  const token = readSessionCookie(request.headers.get("cookie") ?? undefined);
  if (!token) return unavailable(401, NEEDS_SIGN_IN);
  let view: SessionView | null;
  try {
    view = await service.authenticate(token);
  } catch {
    console.error("PAYFLOW_CALENDAR_SESSION_READ_FAILED");
    return unavailable(503, MESSAGES.STORE_UNAVAILABLE);
  }
  return view ?? unavailable(401, NEEDS_SIGN_IN);
}

export async function handleCalendarRead(
  request: Request,
  deps: { auth: UserAuthService; calendar: WorkspaceCalendar } | undefined,
  now: number = Date.now(),
): Promise<Response> {
  if (!sameOrigin(request))
    return unavailable(
      403,
      "This endpoint only answers the PayFlow application.",
    );
  if (!deps)
    return json(200, { status: "UNCONFIGURED", message: NOT_CONFIGURED });
  if (!reads.allow(callerKey(request), now))
    return unavailable(429, "Too many requests in a row. Give it a moment.");
  const view = await workspace(request, deps.auth);
  if (view instanceof Response) return view;
  const url = new URL(request.url);
  const result = await deps.calendar.list(
    view.member.organizationId,
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  if (result.status !== "OK")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, { status: "OK", events: result.events });
}

export async function handleCalendarWrite(
  request: Request,
  deps: { auth: UserAuthService; calendar: WorkspaceCalendar } | undefined,
  now: number = Date.now(),
): Promise<Response> {
  if (!sameOrigin(request))
    return unavailable(
      403,
      "This endpoint only answers the PayFlow application.",
    );
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > GUARD_LIMITS.bodyBytes)
    return unavailable(413, "That is too long.");
  if (!writes.allow(callerKey(request), now))
    return unavailable(429, "Too many changes in a row. Give it a minute.");
  if (!deps) return unavailable(503, NOT_CONFIGURED);
  const view = await workspace(request, deps.auth);
  if (view instanceof Response) return view;
  // A state change needs the token only this origin's own page could have read.
  if (
    !deps.auth.csrfMatches(
      view,
      request.headers.get("x-payflow-csrf") ?? undefined,
    )
  )
    return unavailable(
      403,
      "That change could not be verified. Reload the page and try again.",
    );

  let input: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > GUARD_LIMITS.bodyBytes)
      return unavailable(413, "That is too long.");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("shape");
    input = parsed as Record<string, unknown>;
  } catch {
    return unavailable(400, "PayFlow could not read that request.");
  }

  if (input.action === "remove") {
    const result = await deps.calendar.remove(
      view.member.organizationId,
      input.eventId,
    );
    if (result.status !== "OK")
      return unavailable(STATUS[result.status], MESSAGES[result.status]);
    return json(200, { status: "OK", removed: result.removed });
  }

  const result = await deps.calendar.add(
    view.member.organizationId,
    view.member.memberId,
    input.event,
  );
  if (result.status !== "OK")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, {
    status: "OK",
    event: result.event,
    alreadyThere: result.alreadyThere,
  });
}

export function GET(request: Request): Promise<Response> {
  return handleCalendarRead(request, configured());
}
export function POST(request: Request): Promise<Response> {
  return handleCalendarWrite(request, configured());
}
