"use client";
import Link from "next/link";
import { useState } from "react";
import { EvidenceChip, FlowObject, type FlowState } from "./flow";
import { ExploreTabs } from "./explore-tabs";
import { useAccount } from "./account";

type Segment = {
  from: string;
  to: string;
  departingAt: string | null;
  arrivingAt: string | null;
  operatedBy: string | null;
  flightNumber: string | null;
};
type Leg = {
  from: string;
  to: string;
  durationMinutes: number | null;
  stops: number;
  segments: Segment[];
};
type Offer = {
  id: string;
  airline: string | null;
  totalMinor: number;
  currency: string;
  taxMinor: number | null;
  expiresAt: string | null;
  legs: Leg[];
  refundable: boolean | null;
  changeable: boolean | null;
};
type Search = {
  offers: Offer[];
  observedAt: string;
  evidence: string;
  excludes: string[];
  cheapestIndex: number | null;
  fastestIndex: number | null;
};
type Booking = {
  orderId: string;
  bookingReference: string;
  totalMinor: number;
  currency: string;
  liveMode: boolean;
};

function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
function clock(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
const hours = (m: number | null) =>
  m === null
    ? "—"
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

/** A reply from the network is data, not truth. */
function readSearch(value: unknown): Search | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (s.evidence !== "PROVIDER_OBSERVED" || !Array.isArray(s.offers))
    return null;
  const offers = s.offers.filter(
    (o): o is Offer =>
      !!o &&
      typeof o === "object" &&
      typeof (o as Offer).id === "string" &&
      typeof (o as Offer).totalMinor === "number" &&
      typeof (o as Offer).currency === "string" &&
      Array.isArray((o as Offer).legs),
  );
  return {
    offers,
    observedAt: typeof s.observedAt === "string" ? s.observedAt : "",
    evidence: "PROVIDER_OBSERVED",
    excludes: Array.isArray(s.excludes)
      ? s.excludes.filter((e): e is string => typeof e === "string")
      : [],
    cheapestIndex: typeof s.cheapestIndex === "number" ? s.cheapestIndex : null,
    fastestIndex: typeof s.fastestIndex === "number" ? s.fastestIndex : null,
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; search: Search; mode: string }
  | { kind: "approving"; search: Search; offer: Offer; mode: string }
  | { kind: "booking"; offer: Offer }
  | { kind: "booked"; booking: Booking; offer: Offer }
  | { kind: "unavailable"; message: string };

const FALLBACK =
  "PayFlow could not reach the airlines just now. Nothing was booked. You can still walk the guided demo.";

export function Flights() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const { state: account } = useAccount();
  const [diary, setDiary] = useState<
    "none" | "adding" | "added" | "already" | "failed"
  >("none");

  /** Only a booking the provider confirmed becomes a diary entry, keyed by the airline's own reference. */
  async function addToCalendar(booking: Booking, offer: Offer) {
    if (account.kind !== "signed-in") return;
    const leg = offer.legs[0];
    const first = leg?.segments[0];
    if (!leg || !first?.departingAt) return;
    setDiary("adding");
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payflow-csrf": account.identity.csrfToken,
        },
        body: JSON.stringify({
          event: {
            title: `Flight ${leg.from} \u2192 ${leg.to}`,
            startsAt: new Date(first.departingAt).toISOString(),
            ...(first.arrivingAt
              ? { endsAt: new Date(first.arrivingAt).toISOString() }
              : {}),
            allDay: false,
            location: leg.from,
            notes: `With ${offer.airline ?? "the airline"}. Booking reference ${booking.bookingReference}.`,
            source: "FLIGHT",
            sourceRef: booking.bookingReference,
          },
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        alreadyThere?: boolean;
      } | null;
      setDiary(res.ok ? (body?.alreadyThere ? "already" : "added") : "failed");
    } catch {
      setDiary("failed");
    }
  }

  const flow: FlowState =
    phase.kind === "searching"
      ? "searching"
      : phase.kind === "found"
        ? "comparing"
        : phase.kind === "approving"
          ? "deciding"
          : phase.kind === "booking"
            ? "executing"
            : phase.kind === "booked"
              ? "confirmed"
              : phase.kind === "unavailable"
                ? "unverified"
                : "ready";

  async function call(body: unknown): Promise<Record<string, unknown> | null> {
    const res = await fetch("/api/flights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await res.json().catch(() => null);
    const record = (parsed ?? {}) as Record<string, unknown>;
    if (res.ok) return record;
    setPhase({
      kind: "unavailable",
      message: typeof record.message === "string" ? record.message : FALLBACK,
    });
    return null;
  }

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setPhase({ kind: "searching" });
    try {
      const body = await call({
        action: "search",
        origin: String(f.get("origin") ?? ""),
        destination: String(f.get("destination") ?? ""),
        departureDate: String(f.get("departureDate") ?? ""),
        returnDate: String(f.get("returnDate") ?? "") || null,
        adults: Number(f.get("adults") ?? 1),
        cabin: String(f.get("cabin") ?? "economy"),
      });
      if (!body) return;
      const found = readSearch(body.search);
      if (!found) {
        setPhase({ kind: "unavailable", message: FALLBACK });
        return;
      }
      setPhase({
        kind: "found",
        search: found,
        mode:
          typeof body.bookingMode === "string"
            ? body.bookingMode
            : "UNAVAILABLE",
      });
    } catch {
      setPhase({ kind: "unavailable", message: FALLBACK });
    }
  }

  async function book(offer: Offer, event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setPhase({ kind: "booking", offer });
    try {
      const body = await call({
        action: "book",
        offerId: offer.id,
        passengers: [
          {
            title: String(f.get("title") ?? ""),
            gender: String(f.get("gender") ?? ""),
            givenName: String(f.get("givenName") ?? ""),
            familyName: String(f.get("familyName") ?? ""),
            bornOn: String(f.get("bornOn") ?? ""),
            email: String(f.get("email") ?? ""),
            phoneNumber: String(f.get("phoneNumber") ?? ""),
          },
        ],
      });
      if (!body) return;
      const b = body.booking as Booking | undefined;
      if (!b || typeof b.bookingReference !== "string") {
        setPhase({ kind: "unavailable", message: FALLBACK });
        return;
      }
      setPhase({ kind: "booked", booking: b, offer });
    } catch {
      setPhase({ kind: "unavailable", message: FALLBACK });
    }
  }

  const itinerary = (offer: Offer) => (
    <>
      {offer.legs.map((leg, i) => (
        <div className="leg" key={`${leg.from}-${leg.to}-${i}`}>
          <p className="leg__head">
            {leg.from} → {leg.to}
            <span className="leg__meta">
              {hours(leg.durationMinutes)} ·{" "}
              {leg.stops === 0
                ? "direct"
                : `${leg.stops} stop${leg.stops > 1 ? "s" : ""}`}
            </span>
          </p>
          {leg.segments.map((s, j) => (
            <p className="leg__seg" key={`${s.from}-${s.to}-${j}`}>
              <span>
                {clock(s.departingAt)} → {clock(s.arrivingAt)}
              </span>
              {/* US rules require the airline that actually operates the flight to be shown, not just the seller. */}
              <span className="leg__carrier">
                {s.operatedBy ?? "Operating airline not stated"}
                {s.flightNumber ? ` ${s.flightNumber}` : ""}
              </span>
            </p>
          ))}
        </div>
      ))}
    </>
  );

  return (
    <>
      <section className="wrap flow__hero flow__hero--demo">
        <div className="stack">
          <p className="eyebrow">Explore</p>
          <h1>Where do you need to be?</h1>
          <ExploreTabs />
          <form className="stack" onSubmit={(e) => void search(e)}>
            <div className="grid grid--2" style={{ width: "100%" }}>
              <div className="field">
                <label htmlFor="f-from">From (airport code)</label>
                <input
                  id="f-from"
                  name="origin"
                  maxLength={3}
                  required
                  placeholder="LHR"
                />
              </div>
              <div className="field">
                <label htmlFor="f-to">To (airport code)</label>
                <input
                  id="f-to"
                  name="destination"
                  maxLength={3}
                  required
                  placeholder="JFK"
                />
              </div>
              <div className="field">
                <label htmlFor="f-out">Leaving</label>
                <input id="f-out" name="departureDate" type="date" required />
              </div>
              <div className="field">
                <label htmlFor="f-back">Coming back (optional)</label>
                <input id="f-back" name="returnDate" type="date" />
              </div>
              <div className="field">
                <label htmlFor="f-adults">Travellers</label>
                <input
                  id="f-adults"
                  name="adults"
                  type="number"
                  min="1"
                  max="6"
                  defaultValue="1"
                />
              </div>
              <div className="field">
                <label htmlFor="f-cabin">Cabin</label>
                <select id="f-cabin" name="cabin" defaultValue="economy">
                  <option value="economy">Economy</option>
                  <option value="premium_economy">Premium economy</option>
                  <option value="business">Business</option>
                  <option value="first">First</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={phase.kind === "searching"}
              >
                {phase.kind === "searching"
                  ? "Asking the airlines…"
                  : "Find flights"}
              </button>
              <Link className="btn btn--ghost" href="/partner/">
                Plan the whole trip
              </Link>
            </div>
          </form>
        </div>
        <FlowObject state={flow} />
      </section>

      <div aria-live="polite" className="wrap band">
        {phase.kind === "unavailable" && (
          <section className="stack">
            <h2>No flights to show</h2>
            <p className="lede">{phase.message}</p>
            <Link className="btn" href="/try/">
              Walk the guided demo instead
            </Link>
          </section>
        )}

        {phase.kind === "found" && phase.search.offers.length === 0 && (
          <section className="stack">
            <h2>Nothing came back for those dates</h2>
            <p className="lede">
              The airlines answered, but with nothing for that route on that
              day. Try a different date or a nearby airport.
            </p>
          </section>
        )}

        {phase.kind === "found" && phase.search.offers.length > 0 && (
          <section className="stack">
            <EvidenceChip kind="PROVIDER_OBSERVED" />
            <h2>{phase.search.offers.length} fares, quoted just now</h2>
            <div className="banner">
              <span aria-hidden="true">●</span>
              <p>
                <strong>These are quotes, not a reservation.</strong> Airlines
                hold a fare for a few minutes and then it is gone. The price
                excludes {phase.search.excludes.join(", ")}. PayFlow has not
                booked anything.
              </p>
            </div>
            <div className="grid grid--2" style={{ width: "100%" }}>
              {phase.search.offers.map((offer, i) => (
                <article className="card" key={offer.id}>
                  <div className="actions" style={{ gap: 6 }}>
                    {i === phase.search.cheapestIndex && (
                      <span className="offer__tag offer__tag--best">
                        Cheapest
                      </span>
                    )}
                    {i === phase.search.fastestIndex && (
                      <span className="offer__tag">Fastest</span>
                    )}
                  </div>
                  <p className="offer__price">
                    {money(offer.totalMinor, offer.currency)}
                  </p>
                  <p>{offer.airline ?? "Airline not stated"}</p>
                  {itinerary(offer)}
                  <dl className="ledger" style={{ width: "100%" }}>
                    <div className="ledger__row">
                      <dt>Of which tax</dt>
                      <dd>
                        {offer.taxMinor === null
                          ? "not stated"
                          : money(offer.taxMinor, offer.currency)}
                      </dd>
                    </div>
                    <div className="ledger__row">
                      <dt>Refundable</dt>
                      <dd>
                        {offer.refundable === null
                          ? "not stated"
                          : offer.refundable
                            ? "yes"
                            : "no"}
                      </dd>
                    </div>
                    <div className="ledger__row">
                      <dt>Changeable</dt>
                      <dd>
                        {offer.changeable === null
                          ? "not stated"
                          : offer.changeable
                            ? "yes"
                            : "no"}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="btn btn--small"
                    onClick={() =>
                      setPhase({
                        kind: "approving",
                        search: phase.search,
                        offer,
                        mode: phase.mode,
                      })
                    }
                  >
                    Choose this one
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {phase.kind === "approving" && (
          <section className="stack">
            <span className="chip chip--decision">Needs you</span>
            <h2>Book this flight?</h2>
            <div className="card card--decision" style={{ maxWidth: "46rem" }}>
              <p className="offer__price">
                {money(phase.offer.totalMinor, phase.offer.currency)}
              </p>
              <p>{phase.offer.airline ?? "Airline not stated"}</p>
              {itinerary(phase.offer)}
              <p>
                <strong>Approving this allows exactly one thing:</strong> one
                booking of this itinerary at{" "}
                {money(phase.offer.totalMinor, phase.offer.currency)}. PayFlow
                re-reads the fare from the airline first and books at whatever
                the airline says then — if it has changed or expired, it stops
                and tells you rather than booking something else.
              </p>
              {phase.mode === "SANDBOX" ? (
                <div className="banner banner--sim">
                  <span aria-hidden="true">●</span>
                  <p>
                    <strong>This is a test booking.</strong> It is made against
                    the airline sandbox with a test credential. You will get a
                    real booking reference in that sandbox, and no money moves
                    and no seat is actually held.
                  </p>
                </div>
              ) : (
                <div className="banner banner--sim">
                  <span aria-hidden="true">●</span>
                  <p>
                    <strong>Booking is not available here.</strong> PayFlow only
                    makes test bookings on this site, and this deployment is not
                    set up for them. Nothing will be booked.
                  </p>
                </div>
              )}
              <h3>Who is travelling?</h3>
              <form
                className="stack"
                onSubmit={(e) => void book(phase.offer, e)}
              >
                <div className="grid grid--2" style={{ width: "100%" }}>
                  <div className="field">
                    <label htmlFor="p-title">Title</label>
                    <select id="p-title" name="title" defaultValue="mr">
                      {["mr", "mrs", "ms", "miss", "dr"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="p-gender">Gender on the passport</label>
                    <select id="p-gender" name="gender" defaultValue="f">
                      <option value="f">Female</option>
                      <option value="m">Male</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="p-given">Given name</label>
                    <input
                      id="p-given"
                      name="givenName"
                      maxLength={40}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="p-family">Family name</label>
                    <input
                      id="p-family"
                      name="familyName"
                      maxLength={40}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="p-born">Date of birth</label>
                    <input id="p-born" name="bornOn" type="date" required />
                  </div>
                  <div className="field">
                    <label htmlFor="p-email">Email</label>
                    <input
                      id="p-email"
                      name="email"
                      type="email"
                      maxLength={254}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="p-phone">Phone, with country code</label>
                    <input
                      id="p-phone"
                      name="phoneNumber"
                      type="tel"
                      placeholder="+442080160509"
                      pattern="\+[1-9][0-9]{6,15}"
                      required
                    />
                  </div>
                </div>
                <div className="actions">
                  <button
                    className="btn"
                    type="submit"
                    disabled={phase.mode !== "SANDBOX"}
                  >
                    Book {money(phase.offer.totalMinor, phase.offer.currency)}
                  </button>
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={() =>
                      setPhase({
                        kind: "found",
                        search: phase.search,
                        mode: phase.mode,
                      })
                    }
                  >
                    Show me the other fares
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}

        {phase.kind === "booking" && (
          <section className="stack">
            <h2>Booking…</h2>
            <p className="lede">
              PayFlow is re-reading the fare and placing the booking. Do not
              refresh — if anything goes wrong it will say so rather than guess.
            </p>
          </section>
        )}

        {phase.kind === "booked" && (
          <section className="stack">
            <EvidenceChip kind="PROVIDER_CONFIRMED" />
            <h2>Booked. Here is the reference.</h2>
            <dl className="ledger" style={{ maxWidth: "40rem" }}>
              <div className="ledger__row ledger__row--total">
                <dt>Booking reference</dt>
                <dd className="mono">{phase.booking.bookingReference}</dd>
              </div>
              <div className="ledger__row">
                <dt>Charged</dt>
                <dd>
                  {money(phase.booking.totalMinor, phase.booking.currency)}
                </dd>
              </div>
              <div className="ledger__row">
                <dt>Order</dt>
                <dd className="mono">{phase.booking.orderId}</dd>
              </div>
            </dl>
            {itinerary(phase.offer)}
            <div className="banner banner--sim">
              <span aria-hidden="true">●</span>
              <p>
                <strong>This is a sandbox booking.</strong> The reference above
                is real in the airline&rsquo;s test environment and nowhere
                else. No money moved and no seat is held. PayFlow refuses to
                make a live booking from this site at all.
              </p>
            </div>
            <div className="actions">
              {account.kind === "signed-in" && (
                <button
                  className="btn"
                  onClick={() => void addToCalendar(phase.booking, phase.offer)}
                  disabled={
                    diary === "adding" ||
                    diary === "added" ||
                    diary === "already"
                  }
                >
                  {diary === "added"
                    ? "In your calendar"
                    : diary === "already"
                      ? "Already in your calendar"
                      : diary === "adding"
                        ? "Adding…"
                        : "Add to my calendar"}
                </button>
              )}
              <button
                className="btn btn--ghost"
                onClick={() => setPhase({ kind: "idle" })}
              >
                Search again
              </button>
            </div>
            {diary === "failed" && (
              <p className="quiet-note">
                PayFlow could not add it to your calendar just now. The booking
                itself is unaffected — the reference above still stands.
              </p>
            )}
            {account.kind === "signed-out" && (
              <p className="quiet-note">
                <Link className="text-link" href="/account/">
                  Sign in
                </Link>{" "}
                and PayFlow can put this in your calendar with the reference on
                it.
              </p>
            )}
          </section>
        )}
      </div>
    </>
  );
}
