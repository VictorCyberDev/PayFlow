import { z } from "zod";

/**
 * V4 — real flight search, comparison and sandbox booking through Duffel.
 *
 * Contract read from duffel.com/docs/api/v2 on 2026-11-12: `POST /air/offer_requests` searches, `GET /air/offers/{id}`
 * re-reads one offer, and `POST /air/orders` books. Headers are `Duffel-Version: v2` and a bearer token.
 *
 * Three rules this module exists to enforce, because a booking is the most consequential thing PayFlow can do:
 *
 *  1. **Test mode only.** An order is refused unless the token is a Duffel TEST token. Duffel prefixes its tokens
 *     `duffel_test_` and `duffel_live_`, so this is checkable rather than hoped for. A live token can still search.
 *  2. **The price comes from the provider, never from the caller.** Before booking, the offer is re-read from Duffel
 *     and the order is created with that amount and currency. A tampered client cannot book at a price it chose.
 *  3. **An expired offer is not bookable.** Offers expire; PayFlow checks rather than letting the airline refuse.
 *
 * A search result is an OBSERVATION. Only a created order is PROVIDER_CONFIRMED, and only because Duffel returned a
 * booking reference for it.
 */
export const FLIGHT_LIMITS = Object.freeze({
  searchTimeoutMs: 30_000,
  bookTimeoutMs: 40_000,
  responseBytes: 4_000_000,
  maxOffers: 12,
  maxPassengers: 6,
  maxSegmentsShown: 4,
});

const BASE = "https://api.duffel.com";
const IATA = /^[A-Za-z]{3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const CABINS = Object.freeze([
  "economy",
  "premium_economy",
  "business",
  "first",
] as const);
export type Cabin = (typeof CABINS)[number];

// ------------------------------------------------------------------------------- what Duffel sends back
const Place = z
  .object({
    iata_code: z.string().max(8).nullish(),
    name: z.string().max(200).nullish(),
    city_name: z.string().max(200).nullish(),
  })
  .passthrough();
const Carrier = z
  .object({
    name: z.string().max(200).nullish(),
    iata_code: z.string().max(8).nullish(),
  })
  .passthrough();
const Segment = z
  .object({
    origin: Place.nullish(),
    destination: Place.nullish(),
    departing_at: z.string().max(40).nullish(),
    arriving_at: z.string().max(40).nullish(),
    duration: z.string().max(40).nullish(),
    operating_carrier: Carrier.nullish(),
    marketing_carrier: Carrier.nullish(),
    marketing_carrier_flight_number: z.string().max(12).nullish(),
  })
  .passthrough();
const Slice = z
  .object({
    origin: Place.nullish(),
    destination: Place.nullish(),
    duration: z.string().max(40).nullish(),
    segments: z.array(Segment).max(40).nullish(),
  })
  .passthrough();
const Condition = z
  .object({
    allowed: z.boolean().nullish(),
    penalty_amount: z.string().max(32).nullish(),
    penalty_currency: z.string().max(8).nullish(),
  })
  .nullish();
export const OfferSchema = z
  .object({
    id: z.string().max(128),
    total_amount: z.string().max(32),
    total_currency: z.string().max(8),
    tax_amount: z.string().max(32).nullish(),
    expires_at: z.string().max(40).nullish(),
    owner: Carrier.nullish(),
    slices: z.array(Slice).max(10).nullish(),
    passengers: z
      .array(z.object({ id: z.string().max(128) }).passthrough())
      .max(20)
      .nullish(),
    conditions: z
      .object({
        refund_before_departure: Condition,
        change_before_departure: Condition,
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

// ------------------------------------------------------------------------------- what PayFlow shows
export interface FlightSegment {
  readonly from: string;
  readonly to: string;
  readonly departingAt: string | null;
  readonly arrivingAt: string | null;
  /** The airline that actually flies it. US rules require this to be shown prominently, so it is never dropped. */
  readonly operatedBy: string | null;
  readonly flightNumber: string | null;
}
export interface FlightLeg {
  readonly from: string;
  readonly to: string;
  readonly durationMinutes: number | null;
  readonly stops: number;
  readonly segments: readonly FlightSegment[];
}
export interface FlightOffer {
  readonly id: string;
  readonly airline: string | null;
  /** Minor units of `currency`, parsed from the provider's decimal string. Never summed across currencies. */
  readonly totalMinor: number;
  readonly currency: string;
  readonly taxMinor: number | null;
  readonly expiresAt: string | null;
  readonly legs: readonly FlightLeg[];
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
  readonly passengerIds: readonly string[];
}
export interface FlightSearch {
  readonly offers: readonly FlightOffer[];
  readonly observedAt: string;
  readonly evidence: "PROVIDER_OBSERVED";
  readonly excludes: readonly string[];
  /** Index of the cheapest offer, chosen here. null when the offers are not in one currency. */
  readonly cheapestIndex: number | null;
  /** Index of the shortest total travel time, which is often not the cheapest. */
  readonly fastestIndex: number | null;
}
export interface FlightBooking {
  readonly orderId: string;
  readonly bookingReference: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly evidence: "PROVIDER_CONFIRMED";
  readonly liveMode: false;
  readonly confirmedAt: string;
}

export type FlightFailure =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REJECTED"
  | "INVALID_PROVIDER_OUTPUT"
  | "INVALID_INPUT"
  | "OFFER_EXPIRED"
  | "OFFER_GONE"
  | "LIVE_BOOKING_REFUSED";

export type SearchResult =
  { status: "FOUND"; search: FlightSearch } | { status: FlightFailure };
export type BookingResult =
  { status: "BOOKED"; booking: FlightBooking } | { status: FlightFailure };

export interface FlightProvider {
  /** True only for a Duffel TEST token. Booking is refused when this is false. */
  readonly testMode: boolean;
  searchOffers(
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: FlightFailure }>;
  getOffer(
    offerId: string,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: FlightFailure }>;
  createOrder(
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: FlightFailure }>;
}

// ------------------------------------------------------------------------------- normalisation
/** "30.20" -> 3020. Returns null rather than guessing when the provider's string is not a plain decimal. */
export function decimalToMinor(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,12}(\.\d{1,4})?$/u.test(value))
    return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = (fraction + "00").slice(0, 2);
  const n = Number(whole) * 100 + Number(cents);
  return Number.isSafeInteger(n) ? n : null;
}
/** ISO 8601 duration, the subset Duffel uses for flights. */
export function isoDurationToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/u.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
const place = (p: z.infer<typeof Place> | null | undefined): string =>
  (p?.iata_code ?? p?.city_name ?? p?.name ?? "").slice(0, 80);
const clean = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export function normalizeOffer(
  raw: z.infer<typeof OfferSchema>,
): FlightOffer | null {
  const totalMinor = decimalToMinor(raw.total_amount);
  const currency = /^[A-Za-z]{3}$/u.test(raw.total_currency)
    ? raw.total_currency.toUpperCase()
    : null;
  if (totalMinor === null || !currency) return null;
  const legs = (raw.slices ?? []).map<FlightLeg>((slice) => {
    const segments = (slice.segments ?? [])
      .slice(0, FLIGHT_LIMITS.maxSegmentsShown)
      .map<FlightSegment>((s) => ({
        from: place(s.origin),
        to: place(s.destination),
        departingAt: clean(s.departing_at, 40),
        arrivingAt: clean(s.arriving_at, 40),
        operatedBy: clean(s.operating_carrier?.name, 200),
        flightNumber: clean(s.marketing_carrier_flight_number, 12),
      }));
    return {
      from: place(slice.origin),
      to: place(slice.destination),
      durationMinutes: isoDurationToMinutes(slice.duration),
      stops: Math.max(0, (slice.segments ?? []).length - 1),
      segments,
    };
  });
  if (legs.length === 0) return null;
  return {
    id: raw.id,
    airline: clean(raw.owner?.name, 200),
    totalMinor,
    currency,
    taxMinor: decimalToMinor(raw.tax_amount),
    expiresAt: clean(raw.expires_at, 40),
    legs,
    refundable: raw.conditions?.refund_before_departure?.allowed ?? null,
    changeable: raw.conditions?.change_before_departure?.allowed ?? null,
    passengerIds: (raw.passengers ?? []).map((p) => p.id),
  };
}

export interface SearchRequest {
  readonly origin: string;
  readonly destination: string;
  readonly departureDate: string;
  readonly returnDate?: string | null | undefined;
  readonly adults?: number | undefined;
  readonly cabin?: string | undefined;
}

/** Everything the caller sends is bounded here; nothing unvalidated reaches the provider. */
export function buildOfferRequest(
  request: SearchRequest,
): Record<string, unknown> | null {
  const origin = request.origin?.trim().toUpperCase();
  const destination = request.destination?.trim().toUpperCase();
  if (!IATA.test(origin ?? "") || !IATA.test(destination ?? "")) return null;
  if (origin === destination) return null;
  if (!DATE.test(request.departureDate ?? "")) return null;
  if (Number.isNaN(Date.parse(request.departureDate))) return null;
  const slices: Record<string, string>[] = [
    {
      origin,
      destination,
      departure_date: request.departureDate,
    },
  ];
  if (request.returnDate) {
    if (!DATE.test(request.returnDate)) return null;
    if (Date.parse(request.returnDate) < Date.parse(request.departureDate))
      return null;
    slices.push({
      origin: destination,
      destination: origin,
      departure_date: request.returnDate,
    });
  }
  const adults = Number.isInteger(request.adults) ? Number(request.adults) : 1;
  if (adults < 1 || adults > FLIGHT_LIMITS.maxPassengers) return null;
  const cabin = CABINS.includes(request.cabin as Cabin)
    ? (request.cabin as Cabin)
    : "economy";
  return {
    data: {
      slices,
      passengers: Array.from({ length: adults }, () => ({ type: "adult" })),
      cabin_class: cabin,
      max_connections: 1,
    },
  };
}

export async function searchFlights(
  provider: FlightProvider | undefined,
  request: SearchRequest,
  now: () => string = () => new Date().toISOString(),
): Promise<SearchResult> {
  if (!provider) return { status: "PROVIDER_NOT_CONFIGURED" };
  const body = buildOfferRequest(request);
  if (!body) return { status: "INVALID_INPUT" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FLIGHT_LIMITS.searchTimeoutMs);
  try {
    const r = await provider.searchOffers(body, ctl.signal);
    if (r.status !== "OK") return { status: r.status };
    const parsed = z
      .object({
        data: z
          .object({ offers: z.array(OfferSchema).max(500).nullish() })
          .passthrough(),
      })
      .safeParse(r.body);
    if (!parsed.success) return { status: "INVALID_PROVIDER_OUTPUT" };
    const offers = (parsed.data.data.offers ?? [])
      .map(normalizeOffer)
      .filter((o): o is FlightOffer => o !== null)
      .sort((a, b) => a.totalMinor - b.totalMinor)
      .slice(0, FLIGHT_LIMITS.maxOffers);
    const currencies = new Set(offers.map((o) => o.currency));
    const totalMinutes = (o: FlightOffer) =>
      o.legs.reduce((sum, l) => sum + (l.durationMinutes ?? 0), 0);
    const comparable = offers.length > 0 && currencies.size === 1;
    const fastest =
      offers.length > 0 && offers.every((o) => totalMinutes(o) > 0)
        ? offers.reduce(
            (best, o, i) =>
              totalMinutes(o) < totalMinutes(offers[best]!) ? i : best,
            0,
          )
        : null;
    return {
      status: "FOUND",
      search: Object.freeze({
        offers: Object.freeze(offers),
        observedAt: now(),
        evidence: "PROVIDER_OBSERVED",
        excludes: Object.freeze([
          "seats, bags and other extras",
          "anything the airline charges at check-in",
        ]),
        cheapestIndex: comparable ? 0 : null,
        fastestIndex: fastest,
      }),
    };
  } catch {
    return {
      status: ctl.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface PassengerDetails {
  readonly givenName: string;
  readonly familyName: string;
  readonly bornOn: string;
  readonly title: string;
  readonly gender: string;
  readonly email: string;
  readonly phoneNumber: string;
}
const TITLES = ["mr", "mrs", "ms", "miss", "dr"];
const GENDERS = ["m", "f"];

export function validPassenger(raw: unknown): PassengerDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim().length > 0 && v.trim().length <= max
      ? v.trim()
      : null;
  const givenName = text(p.givenName, 40);
  const familyName = text(p.familyName, 40);
  const bornOn =
    typeof p.bornOn === "string" && DATE.test(p.bornOn) ? p.bornOn : null;
  const title = TITLES.includes(String(p.title).toLowerCase())
    ? String(p.title).toLowerCase()
    : null;
  const gender = GENDERS.includes(String(p.gender).toLowerCase())
    ? String(p.gender).toLowerCase()
    : null;
  const email =
    typeof p.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(p.email)
      ? p.email.trim().slice(0, 254)
      : null;
  const phoneNumber =
    typeof p.phoneNumber === "string" &&
    /^\+[1-9]\d{6,15}$/u.test(p.phoneNumber.trim())
      ? p.phoneNumber.trim()
      : null;
  if (
    !givenName ||
    !familyName ||
    !bornOn ||
    !title ||
    !gender ||
    !email ||
    !phoneNumber
  )
    return null;
  return { givenName, familyName, bornOn, title, gender, email, phoneNumber };
}

/**
 * Book one offer. The founder's approval is checked by the caller; what is checked HERE is that the booking is
 * possible, honest and priced by the airline rather than by whoever sent the request.
 */
export async function bookFlight(
  provider: FlightProvider | undefined,
  offerId: unknown,
  rawPassengers: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<BookingResult> {
  if (!provider) return { status: "PROVIDER_NOT_CONFIGURED" };
  // Rule 1. A live token may search all day; it may not book from this surface.
  if (!provider.testMode) return { status: "LIVE_BOOKING_REFUSED" };
  if (typeof offerId !== "string" || !/^off_[A-Za-z0-9]{1,64}$/u.test(offerId))
    return { status: "INVALID_INPUT" };
  const people = Array.isArray(rawPassengers)
    ? rawPassengers.map(validPassenger)
    : null;
  if (
    !people ||
    people.length === 0 ||
    people.length > FLIGHT_LIMITS.maxPassengers ||
    people.some((p) => p === null)
  )
    return { status: "INVALID_INPUT" };
  const passengers = people as PassengerDetails[];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FLIGHT_LIMITS.bookTimeoutMs);
  try {
    // Rule 2. Re-read the offer: the amount, the currency and the passenger ids all come from the provider.
    const fresh = await provider.getOffer(offerId, ctl.signal);
    if (fresh.status !== "OK")
      return {
        status:
          fresh.status === "PROVIDER_REJECTED" ? "OFFER_GONE" : fresh.status,
      };
    const parsed = z.object({ data: OfferSchema }).safeParse(fresh.body);
    if (!parsed.success) return { status: "INVALID_PROVIDER_OUTPUT" };
    const offer = normalizeOffer(parsed.data.data);
    if (!offer) return { status: "INVALID_PROVIDER_OUTPUT" };
    // Rule 3. An offer past its expiry is not bookable; say so rather than let the airline say it.
    if (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.parse(now()))
      return { status: "OFFER_EXPIRED" };
    if (offer.passengerIds.length !== passengers.length)
      return { status: "INVALID_INPUT" };

    const order = await provider.createOrder(
      {
        data: {
          type: "instant",
          selected_offers: [offer.id],
          payments: [
            {
              type: "balance",
              // From the provider's own fresh quote, never from the request body.
              amount: parsed.data.data.total_amount,
              currency: parsed.data.data.total_currency,
            },
          ],
          passengers: offer.passengerIds.map((id, i) => ({
            id,
            title: passengers[i]!.title,
            gender: passengers[i]!.gender,
            given_name: passengers[i]!.givenName,
            family_name: passengers[i]!.familyName,
            born_on: passengers[i]!.bornOn,
            email: passengers[i]!.email,
            phone_number: passengers[i]!.phoneNumber,
          })),
        },
      },
      ctl.signal,
    );
    if (order.status !== "OK") return { status: order.status };
    const booked = z
      .object({
        data: z
          .object({
            id: z.string().max(128),
            booking_reference: z.string().max(32),
            total_amount: z.string().max(32).nullish(),
            total_currency: z.string().max(8).nullish(),
            live_mode: z.boolean().nullish(),
          })
          .passthrough(),
      })
      .safeParse(order.body);
    if (!booked.success) return { status: "INVALID_PROVIDER_OUTPUT" };
    // If the provider says this was live, something is wrong with our own assumptions: refuse to call it confirmed.
    if (booked.data.data.live_mode === true)
      return { status: "LIVE_BOOKING_REFUSED" };
    return {
      status: "BOOKED",
      booking: Object.freeze({
        orderId: booked.data.data.id,
        bookingReference: booked.data.data.booking_reference,
        totalMinor:
          decimalToMinor(booked.data.data.total_amount) ?? offer.totalMinor,
        currency: (
          booked.data.data.total_currency ?? offer.currency
        ).toUpperCase(),
        evidence: "PROVIDER_CONFIRMED",
        liveMode: false,
        confirmedAt: now(),
      }),
    };
  } catch {
    return {
      status: ctl.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------- the provider
export class DuffelProvider implements FlightProvider {
  readonly #token: string;
  readonly testMode: boolean;
  constructor(
    token: string | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#token = token && !/[\r\n\s]/u.test(token) ? token : "";
    // Duffel prefixes its tokens by mode. Anything that is not demonstrably a test token is treated as live.
    this.testMode = this.#token.startsWith("duffel_test_");
  }
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): DuffelProvider | undefined {
    const token = env["DUFFEL_ACCESS_TOKEN"];
    return token ? new DuffelProvider(token) : undefined;
  }
  async #call(
    path: string,
    init: { method: string; body?: unknown },
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: FlightFailure }> {
    if (!this.#token) return { status: "PROVIDER_NOT_CONFIGURED" };
    let res: Response;
    try {
      res = await this.transport(BASE + path, {
        method: init.method,
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "Duffel-Version": "v2",
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return {
        status: signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        status:
          res.status === 401 || res.status === 403
            ? "PROVIDER_NOT_CONFIGURED"
            : res.status >= 500 || res.status === 429
              ? "PROVIDER_UNAVAILABLE"
              : "PROVIDER_REJECTED",
      };
    }
    try {
      const raw = (await res.text()).slice(0, FLIGHT_LIMITS.responseBytes);
      return { status: "OK", body: JSON.parse(raw) as unknown };
    } catch {
      return { status: "INVALID_PROVIDER_OUTPUT" };
    }
  }
  searchOffers(body: unknown, signal: AbortSignal) {
    // return_offers=true keeps it one round trip; the supplier timeout bounds how long airlines may take.
    return this.#call(
      "/air/offer_requests?return_offers=true&supplier_timeout=20000",
      { method: "POST", body },
      signal,
    );
  }
  getOffer(offerId: string, signal: AbortSignal) {
    return this.#call(
      `/air/offers/${encodeURIComponent(offerId)}`,
      { method: "GET" },
      signal,
    );
  }
  createOrder(body: unknown, signal: AbortSignal) {
    return this.#call("/air/orders", { method: "POST", body }, signal);
  }
}
