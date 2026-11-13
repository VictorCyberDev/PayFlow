import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";

/**
 * V4 — PayFlow's own calendar.
 *
 * A founder's week is what every other surface keeps referring to: the flight they booked, the milestone they agreed,
 * the invoice that falls due. PayFlow had nowhere to put any of it, so it could not answer "what does my week look
 * like" and could not do calendar-aware travel at all.
 *
 * This is deliberately PayFlow's own calendar rather than a connection to somebody else's. Reading a founder's whole
 * personal calendar is a large permission to ask for before PayFlow has earned anything, and the mandate is explicit
 * that reading unrelated private events without permission is not acceptable. A calendar the founder fills in, and
 * that PayFlow adds confirmed things to, needs no such permission at all.
 *
 * AN EVENT IS NOT EVIDENCE. "Flight to JFK" in a diary does not mean a seat is held; the booking reference on the
 * order means that. `source` and `source_ref` exist so a reader can always tell a note somebody typed from one PayFlow
 * recorded because a provider confirmed something.
 *
 * Every query is scoped by organization_id. There is no call here that can read across workspaces.
 */
export const CALENDAR_LIMITS = Object.freeze({
  title: 160,
  location: 200,
  notes: 2000,
  maxWindowDays: 400,
  maxEvents: 500,
});

export const SOURCES = Object.freeze([
  "MANUAL",
  "FLIGHT",
  "INVOICE",
  "MILESTONE",
] as const);
export type EventSource = (typeof SOURCES)[number];

const Text = (n: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(n)
    // eslint-disable-next-line no-control-regex -- rejecting control characters before storage is the point
    .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s), "NO_CONTROL");
const Instant = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "NOT_A_TIME");

/**
 * Records which operation failed and the database's own error code, and nothing else.
 *
 * A bare "WRITE_FAILED" cost real time: in production it could equally have meant a missing table, a role without
 * permission, or an unreachable host, and the line said none of them. A PostgreSQL error code is five characters the
 * database chose -- 42P01 undefined_table, 42501 insufficient_privilege -- so it carries no row, no credential and
 * none of the caller's words, which is exactly why it can be logged where the driver's message cannot.
 */
function logStoreFault(operation: "READ" | "WRITE", cause: unknown): void {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String(cause.code).slice(0, 12)
      : "unknown";
  console.error(
    `PAYFLOW_CALENDAR_${operation}_FAILED ` + JSON.stringify({ code }),
  );
}

export const NewEventSchema = z
  .object({
    title: Text(CALENDAR_LIMITS.title),
    startsAt: Instant,
    endsAt: Instant.nullish(),
    allDay: z.boolean().optional(),
    location: Text(CALENDAR_LIMITS.location).nullish(),
    notes: Text(CALENDAR_LIMITS.notes).nullish(),
    source: z.enum(SOURCES).optional(),
    sourceRef: z.string().trim().min(1).max(128).nullish(),
  })
  .strict()
  .refine(
    (e) => !e.endsAt || Date.parse(e.endsAt) >= Date.parse(e.startsAt),
    "ENDS_BEFORE_START",
  );
export type NewEvent = z.infer<typeof NewEventSchema>;

export interface CalendarEvent {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly notes: string | null;
  readonly source: EventSource;
  readonly sourceRef: string | null;
}

export type CalendarFailure =
  "INVALID_INPUT" | "INVALID_RANGE" | "WINDOW_TOO_WIDE" | "STORE_UNAVAILABLE";

type Row = {
  event_id: string;
  title: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  all_day: boolean;
  location: string | null;
  notes: string | null;
  source: string;
  source_ref: string | null;
};
const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);
const toEvent = (r: Row): CalendarEvent => ({
  eventId: r.event_id,
  title: r.title,
  startsAt: iso(r.starts_at)!,
  endsAt: iso(r.ends_at),
  allDay: r.all_day,
  location: r.location,
  notes: r.notes,
  source: (SOURCES as readonly string[]).includes(r.source)
    ? (r.source as EventSource)
    : "MANUAL",
  sourceRef: r.source_ref,
});

export class WorkspaceCalendar {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** This organization's events in a window, oldest first. The window is bounded so one call cannot read a decade. */
  async list(
    organizationId: string,
    fromIso: unknown,
    toIso: unknown,
  ): Promise<
    { status: "OK"; events: CalendarEvent[] } | { status: CalendarFailure }
  > {
    // A bad window on a READ is not a bad event: it used to borrow the write's "needs a title" message, which told a
    // caller to fix a field the request does not even have.
    const from = Instant.safeParse(fromIso);
    const to = Instant.safeParse(toIso);
    if (!from.success || !to.success) return { status: "INVALID_RANGE" };
    const span = Date.parse(to.data) - Date.parse(from.data);
    if (span < 0) return { status: "INVALID_RANGE" };
    if (span > CALENDAR_LIMITS.maxWindowDays * 86_400_000)
      return { status: "WINDOW_TOO_WIDE" };
    try {
      const rows = (await this.sql`
        select event_id, title, starts_at, ends_at, all_day, location, notes, source, source_ref
        from workspace_events
        where organization_id = ${organizationId}
          and starts_at >= ${from.data} and starts_at < ${to.data}
        order by starts_at asc
        limit ${CALENDAR_LIMITS.maxEvents}
      `) as unknown as Row[];
      return { status: "OK", events: rows.map(toEvent) };
    } catch (cause) {
      logStoreFault("READ", cause);
      return { status: "STORE_UNAVAILABLE" };
    }
  }

  /**
   * Adds one event. A provider-sourced event carries the provider's own reference and is recorded once: booking the
   * same flight twice does not put it in the diary twice, which the unique index enforces and this returns honestly.
   */
  async add(
    organizationId: string,
    memberId: string,
    raw: unknown,
  ): Promise<
    | { status: "OK"; event: CalendarEvent; alreadyThere: boolean }
    | { status: CalendarFailure }
  > {
    const parsed = NewEventSchema.safeParse(raw);
    if (!parsed.success) return { status: "INVALID_INPUT" };
    const e = parsed.data;
    const at = this.now();
    const eventId = `evt_${randomBytes(12).toString("hex")}`;
    try {
      const rows = (await this.sql`
        insert into workspace_events
          (event_id, organization_id, created_by, title, starts_at, ends_at, all_day, location, notes, source, source_ref, created_at, updated_at)
        values
          (${eventId}, ${organizationId}, ${memberId}, ${e.title}, ${e.startsAt}, ${e.endsAt ?? null},
           ${e.allDay ?? false}, ${e.location ?? null}, ${e.notes ?? null}, ${e.source ?? "MANUAL"},
           ${e.sourceRef ?? null}, ${at}, ${at})
        on conflict do nothing
        returning event_id, title, starts_at, ends_at, all_day, location, notes, source, source_ref
      `) as unknown as Row[];
      if (rows.length > 0)
        return { status: "OK", event: toEvent(rows[0]!), alreadyThere: false };
      // The unique index refused it: the same provider reference is already in this workspace's diary. Return that one.
      const existing = (await this.sql`
        select event_id, title, starts_at, ends_at, all_day, location, notes, source, source_ref
        from workspace_events
        where organization_id = ${organizationId}
          and source = ${e.source ?? "MANUAL"} and source_ref = ${e.sourceRef ?? null}
        limit 1
      `) as unknown as Row[];
      return existing.length > 0
        ? { status: "OK", event: toEvent(existing[0]!), alreadyThere: true }
        : { status: "INVALID_INPUT" };
    } catch (cause) {
      logStoreFault("WRITE", cause);
      return { status: "STORE_UNAVAILABLE" };
    }
  }

  /** Removes one of this organization's events. Another workspace's id simply matches nothing. */
  async remove(
    organizationId: string,
    eventId: unknown,
  ): Promise<{ status: "OK"; removed: boolean } | { status: CalendarFailure }> {
    if (typeof eventId !== "string" || !/^evt_[a-f0-9]{24}$/u.test(eventId))
      return { status: "INVALID_INPUT" };
    try {
      const rows = (await this.sql`
        delete from workspace_events
        where organization_id = ${organizationId} and event_id = ${eventId}
        returning event_id
      `) as unknown as { event_id: string }[];
      return { status: "OK", removed: rows.length > 0 };
    } catch (cause) {
      logStoreFault("WRITE", cause);
      return { status: "STORE_UNAVAILABLE" };
    }
  }
}

/** Turns a confirmed flight booking into a diary entry. Called only after a provider returned a reference. */
export function eventFromFlight(booking: {
  bookingReference: string;
  from: string;
  to: string;
  departingAt: string | null;
  arrivingAt: string | null;
  airline: string | null;
}): NewEvent | null {
  if (!booking.departingAt || Number.isNaN(Date.parse(booking.departingAt)))
    return null;
  return {
    title: `Flight ${booking.from} → ${booking.to}`,
    startsAt: booking.departingAt,
    ...(booking.arrivingAt && !Number.isNaN(Date.parse(booking.arrivingAt))
      ? { endsAt: booking.arrivingAt }
      : {}),
    allDay: false,
    location: booking.from.slice(0, CALENDAR_LIMITS.location),
    notes: [
      booking.airline ? `With ${booking.airline}.` : null,
      `Booking reference ${booking.bookingReference}.`,
    ]
      .filter(Boolean)
      .join(" "),
    source: "FLIGHT",
    sourceRef: booking.bookingReference,
  };
}
