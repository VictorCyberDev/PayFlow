"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlowObject, type FlowState } from "./flow";
import { useAccount } from "./account";

type Event = {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  source: string;
  sourceRef: string | null;
};

function readEvents(value: unknown): Event[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>).events;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is Event =>
      !!e &&
      typeof e === "object" &&
      typeof (e as Event).eventId === "string" &&
      typeof (e as Event).title === "string" &&
      typeof (e as Event).startsAt === "string" &&
      !Number.isNaN(Date.parse((e as Event).startsAt)),
  );
}

const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth() + n, 1);
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const when = (e: Event) => {
  const d = new Date(e.startsAt);
  return e.allDay
    ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : d.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/** Six weeks beginning on Monday, so the table is always six rows and never jumps height between months. */
function weeks(month: Date): Date[][] {
  const first = monthStart(month);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + i);
      return d;
    }),
  );
}

export function Calendar() {
  const { state } = useAccount();
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [events, setEvents] = useState<Event[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const signedIn = state.kind === "signed-in";
  const csrf = signedIn ? state.identity.csrfToken : null;

  const load = useCallback(async () => {
    if (!signedIn) return;
    const from = addMonths(month, 0).toISOString();
    const to = addMonths(month, 1).toISOString();
    try {
      const res = await fetch(
        `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const body: unknown = await res.json().catch(() => null);
      if (!live.current) return;
      if (!res.ok) {
        const m = (body ?? {}) as Record<string, unknown>;
        setProblem(
          typeof m.message === "string"
            ? m.message
            : "PayFlow could not read your calendar just now.",
        );
        return;
      }
      setProblem("");
      setEvents(readEvents(body));
    } catch {
      if (live.current)
        setProblem("PayFlow could not reach your calendar just now.");
    }
  }, [month, signedIn]);
  // Reading this month's events is the "subscribe to an external system" case the rule's own guidance allows: the
  // fetch is the external system, and every setState inside `load` happens after it answers, guarded by the unmount
  // flag. The rule cannot see across the await, so it is silenced here rather than the shape being bent around it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- month-scoped read from the server, not derived state
    void load();
  }, [load]);

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!csrf) return;
    const form = event.currentTarget;
    const f = new FormData(form);
    const date = String(f.get("date") ?? "");
    const time = String(f.get("time") ?? "");
    if (!date) return;
    const startsAt = new Date(`${date}T${time || "09:00"}`).toISOString();
    setBusy(true);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payflow-csrf": csrf },
        body: JSON.stringify({
          event: {
            title: String(f.get("title") ?? ""),
            startsAt,
            allDay: !time,
            location: String(f.get("location") ?? "") || null,
          },
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const m = (body ?? {}) as Record<string, unknown>;
        setProblem(
          typeof m.message === "string"
            ? m.message
            : "That could not be added.",
        );
        return;
      }
      form.reset();
      setProblem("");
      await load();
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function remove(eventId: string) {
    if (!csrf) return;
    setBusy(true);
    try {
      await fetch("/api/calendar", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payflow-csrf": csrf },
        body: JSON.stringify({ action: "remove", eventId }),
      });
      await load();
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const flow: FlowState =
    state.kind === "checking"
      ? "listening"
      : state.kind === "unconfigured"
        ? "unverified"
        : signedIn
          ? "confirmed"
          : "ready";

  const byDay = new Map<string, Event[]>();
  for (const e of events) {
    const k = dayKey(new Date(e.startsAt));
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const today = dayKey(new Date());

  return (
    <>
      <section className="wrap flow__hero flow__hero--demo">
        <div className="stack">
          <p className="eyebrow">Your week</p>
          <h1>What is coming up?</h1>
          {state.kind === "unconfigured" && (
            <p className="lede">
              The calendar is not switched on for this site yet. When it is,
              this is where your week lives — and anything PayFlow books for you
              lands here with the provider&rsquo;s own reference on it.
            </p>
          )}
          {state.kind === "signed-out" && (
            <>
              <p className="lede">
                Your calendar belongs to your workspace, so PayFlow will not
                show it to someone who is not in one.
              </p>
              <div className="actions">
                <Link className="btn" href="/account/">
                  Sign in or make a workspace
                </Link>
              </div>
            </>
          )}
          {signedIn && (
            <p className="lede">
              This is PayFlow&rsquo;s own calendar, not a copy of anyone
              else&rsquo;s. PayFlow never reads your private calendar; it only
              writes here, and only things you asked for.
            </p>
          )}
        </div>
        <FlowObject state={flow} />
      </section>

      {signedIn && (
        <div className="wrap band" aria-live="polite">
          <div className="cal__bar">
            <button
              className="btn btn--small btn--ghost"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              ← Previous
            </button>
            <h2 className="cal__title">
              {month.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </h2>
            <button
              className="btn btn--small btn--ghost"
              onClick={() => setMonth(addMonths(month, 1))}
            >
              Next →
            </button>
          </div>

          {problem && <p className="lede">{problem}</p>}

          {/* A month is a table of days: using the real element gives rows and headers that assistive technology
              already understands, instead of ARIA grid roles hand-rolled around a CSS grid. */}
          <table className="cal">
            <caption className="sr-only">
              {month.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </caption>
            <thead>
              <tr>
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <th className="cal__head" key={d} scope="col">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks(month).map((week) => (
                <tr key={dayKey(week[0]!)}>
                  {week.map((d) => {
                    const k = dayKey(d);
                    const mine = byDay.get(k) ?? [];
                    const outside = d.getMonth() !== month.getMonth();
                    return (
                      <td
                        className={`cal__day${outside ? " is-outside" : ""}${k === today ? " is-today" : ""}`}
                        key={k}
                      >
                        <span className="cal__num">{d.getDate()}</span>
                        {mine.map((e) => (
                          <span
                            className={`cal__pip cal__pip--${e.source.toLowerCase()}`}
                            key={e.eventId}
                          >
                            {e.title}
                          </span>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 28 }}>
            {events.length === 0
              ? "Nothing in this month yet"
              : `${events.length} this month`}
          </h3>
          {events.length > 0 && (
            <dl className="ledger" style={{ width: "100%" }}>
              {events.map((e) => (
                <div className="ledger__row" key={e.eventId}>
                  <dt>
                    <strong>{e.title}</strong>
                    <span className="leg__meta"> {when(e)}</span>
                    {e.location && (
                      <span className="leg__meta"> · {e.location}</span>
                    )}
                    {e.sourceRef && (
                      <span className="leg__meta mono"> · {e.sourceRef}</span>
                    )}
                  </dt>
                  <dd>
                    <button
                      className="btn btn--small btn--ghost"
                      onClick={() => void remove(e.eventId)}
                      disabled={busy}
                      aria-label={`Remove ${e.title}`}
                    >
                      Remove
                    </button>
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <h3 style={{ marginTop: 28 }}>Add something</h3>
          <form className="stack" onSubmit={(e) => void add(e)}>
            <div className="grid grid--2" style={{ width: "100%" }}>
              <div className="field">
                <label htmlFor="c-title">What is it?</label>
                <input id="c-title" name="title" maxLength={160} required />
              </div>
              <div className="field">
                <label htmlFor="c-where">Where? (optional)</label>
                <input id="c-where" name="location" maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="c-date">Date</label>
                <input id="c-date" name="date" type="date" required />
              </div>
              <div className="field">
                <label htmlFor="c-time">Time (leave blank for all day)</label>
                <input id="c-time" name="time" type="time" />
              </div>
            </div>
            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                Add to my calendar
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
