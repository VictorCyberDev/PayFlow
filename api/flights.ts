import {
  readGuardedBody,
  RequestGuard,
  json,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  bookFlight,
  DuffelProvider,
  searchFlights,
  type FlightFailure,
  type FlightProvider,
} from "../src/partner/flights.js";

/**
 * POST /api/flights — real flight search and sandbox booking through Duffel.
 *
 * Searching is read-only. Booking is the most consequential action on this host, so three things are true of it and
 * are enforced in src/partner/flights.ts rather than here: an order is refused unless the Duffel token is a TEST
 * token, the price comes from a fresh read of the offer rather than from the request, and an expired offer is not
 * bookable.
 *
 * There is no account gate on booking today because there are no accounts on this deployment yet, and because a
 * test-mode order moves no money. The moment a live token could reach this code, that would stop being sufficient —
 * which is exactly why the live refusal is a code invariant with a test, not a configuration note.
 */
const searches = new RequestGuard({ perCaller: 6, perInstance: 60 });
const bookings = new RequestGuard({ perCaller: 3, perInstance: 20 });

const MESSAGES: Readonly<Record<FlightFailure, string>> = Object.freeze({
  PROVIDER_NOT_CONFIGURED:
    "Flight search is not switched on for this site yet. You can still plan the trip and try the guided demo.",
  PROVIDER_UNAVAILABLE:
    "The airlines did not answer just now. Nothing was booked. Please try again in a moment.",
  PROVIDER_TIMEOUT:
    "That search took too long, so PayFlow stopped. Nothing was booked. Try again, or narrow the dates.",
  PROVIDER_REJECTED:
    "PayFlow could not search that one. Check the airports and the date.",
  INVALID_PROVIDER_OUTPUT:
    "PayFlow could not read what came back, so it is not showing you flights it does not trust.",
  INVALID_INPUT:
    "Check the details: PayFlow needs two different airport codes, a date, and full traveller details to book.",
  OFFER_EXPIRED:
    "That fare expired before it could be booked. Airlines hold them only for a few minutes. Search again for a current price.",
  OFFER_GONE:
    "That fare is no longer available. Nothing was booked. Search again for a current price.",
  LIVE_BOOKING_REFUSED:
    "PayFlow will only make test bookings here, and this site is not set up for them. Nothing was booked.",
});
const STATUS: Readonly<Record<FlightFailure, number>> = Object.freeze({
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_REJECTED: 422,
  INVALID_PROVIDER_OUTPUT: 502,
  INVALID_INPUT: 400,
  OFFER_EXPIRED: 409,
  OFFER_GONE: 409,
  LIVE_BOOKING_REFUSED: 403,
});

export async function handleFlightsRequest(
  request: Request,
  provider: FlightProvider | undefined,
  now: number = Date.now(),
  clock: () => string = () => new Date().toISOString(),
): Promise<Response> {
  const read = await readGuardedBody(request, searches, now);
  if ("refusal" in read) return read.refusal;
  const input = read.body;

  if (input.action === "book") {
    if (!bookings.allow("book", now))
      return unavailable(
        429,
        "Too many booking attempts in a row. Give it a minute.",
      );
    const result = await bookFlight(
      provider,
      input.offerId,
      input.passengers,
      clock,
    );
    if (result.status !== "BOOKED")
      return unavailable(STATUS[result.status], MESSAGES[result.status]);
    return json(200, {
      status: "BOOKED",
      booking: result.booking,
      disclosure:
        "This is a test booking made with the airline's sandbox. It is a real booking reference in that sandbox and no money moved.",
    });
  }

  const result = await searchFlights(
    provider,
    {
      origin: typeof input.origin === "string" ? input.origin : "",
      destination:
        typeof input.destination === "string" ? input.destination : "",
      departureDate:
        typeof input.departureDate === "string" ? input.departureDate : "",
      returnDate:
        typeof input.returnDate === "string" ? input.returnDate : null,
      adults: typeof input.adults === "number" ? input.adults : 1,
      cabin: typeof input.cabin === "string" ? input.cabin : undefined,
    },
    clock,
  );
  if (result.status !== "FOUND")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, {
    status: "FOUND",
    search: result.search,
    // Stated so no reader mistakes a quote for a seat.
    disclosure:
      "These are live fares the airlines quoted just now, not a reservation. They expire, and PayFlow has not booked anything.",
    // Honest about what a booking here would and would not be.
    bookingMode: provider?.testMode ? "SANDBOX" : "UNAVAILABLE",
  });
}

export function POST(request: Request): Promise<Response> {
  return handleFlightsRequest(request, DuffelProvider.fromEnvironment());
}
