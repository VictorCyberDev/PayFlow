import { describe, expect, it } from "vitest";
import {
  bookFlight,
  buildOfferRequest,
  decimalToMinor,
  DuffelProvider,
  isoDurationToMinutes,
  normalizeOffer,
  searchFlights,
  validPassenger,
  type FlightFailure,
  type FlightProvider,
} from "../src/partner/flights.js";

/** Shaped from duffel.com/docs/api/v2 (read 2026-11-12). */
const offer = (over: Record<string, unknown> = {}) => ({
  id: "off_00009htyDGjIfajdNBZRlw",
  total_amount: "245.50",
  total_currency: "GBP",
  tax_amount: "40.10",
  expires_at: "2030-01-01T00:00:00Z",
  owner: { name: "British Airways", iata_code: "BA" },
  passengers: [{ id: "pas_00009hj8USM7Ncg31cBCLL" }],
  conditions: {
    refund_before_departure: { allowed: false },
    change_before_departure: { allowed: true, penalty_amount: "50.00" },
  },
  slices: [
    {
      origin: { iata_code: "LHR", city_name: "London" },
      destination: { iata_code: "JFK", city_name: "New York" },
      duration: "PT7H55M",
      segments: [
        {
          origin: { iata_code: "LHR" },
          destination: { iata_code: "JFK" },
          departing_at: "2026-12-01T09:45:00",
          arriving_at: "2026-12-01T12:40:00",
          operating_carrier: { name: "British Airways", iata_code: "BA" },
          marketing_carrier_flight_number: "117",
        },
      ],
    },
  ],
  ...over,
});

function provider(
  over: Partial<FlightProvider> & { testMode?: boolean } = {},
): FlightProvider & { orders: unknown[] } {
  const orders: unknown[] = [];
  return {
    orders,
    testMode: over.testMode ?? true,
    searchOffers:
      over.searchOffers ??
      (() =>
        Promise.resolve({
          status: "OK" as const,
          body: { data: { offers: [offer()] } },
        })),
    getOffer:
      over.getOffer ??
      (() =>
        Promise.resolve({ status: "OK" as const, body: { data: offer() } })),
    createOrder:
      over.createOrder ??
      ((body: unknown) => {
        orders.push(body);
        return Promise.resolve({
          status: "OK" as const,
          body: {
            data: {
              id: "ord_00009hthhsUZ8W4LxQgkjo",
              booking_reference: "RZPNX8",
              total_amount: "245.50",
              total_currency: "GBP",
              live_mode: false,
            },
          },
        });
      }),
  };
}
const PASSENGER = {
  givenName: "Amelia",
  familyName: "Earhart",
  bornOn: "1987-07-24",
  title: "mrs",
  gender: "f",
  email: "amelia@example.com",
  phoneNumber: "+442080160509",
};
const AT = () => "2026-11-12T00:00:00.000Z";

describe("what PayFlow asks the airline", () => {
  it("builds a one-way and a return request the provider accepts", () => {
    const oneWay = buildOfferRequest({
      origin: "lhr",
      destination: "jfk",
      departureDate: "2026-12-01",
    }) as {
      data: { slices: unknown[]; passengers: unknown[]; cabin_class: string };
    };
    expect(oneWay.data.slices).toHaveLength(1);
    expect(oneWay.data.slices[0]).toMatchObject({
      origin: "LHR",
      destination: "JFK",
      departure_date: "2026-12-01",
    });
    expect(oneWay.data.cabin_class).toBe("economy");
    const ret = buildOfferRequest({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-12-01",
      returnDate: "2026-12-08",
      adults: 2,
      cabin: "business",
    }) as {
      data: {
        slices: { origin: string }[];
        passengers: unknown[];
        cabin_class: string;
      };
    };
    expect(ret.data.slices).toHaveLength(2);
    expect(ret.data.slices[1]!.origin).toBe("JFK");
    expect(ret.data.passengers).toHaveLength(2);
    expect(ret.data.cabin_class).toBe("business");
  });

  it("refuses a request it cannot make sense of rather than sending it", () => {
    const bad = [
      { origin: "LONDON", destination: "JFK", departureDate: "2026-12-01" },
      { origin: "LHR", destination: "LHR", departureDate: "2026-12-01" },
      { origin: "LHR", destination: "JFK", departureDate: "01/12/2026" },
      { origin: "LHR", destination: "JFK", departureDate: "2026-13-45" },
      {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2026-12-08",
        returnDate: "2026-12-01",
      },
      {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2026-12-01",
        adults: 99,
      },
      {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2026-12-01",
        adults: 0,
      },
    ];
    for (const r of bad) expect(buildOfferRequest(r)).toBeNull();
    // An unknown cabin falls back rather than being passed through.
    expect(
      (
        buildOfferRequest({
          origin: "LHR",
          destination: "JFK",
          departureDate: "2026-12-01",
          cabin: "spaceship",
        }) as { data: { cabin_class: string } }
      ).data.cabin_class,
    ).toBe("economy");
  });
});

describe("what a founder is shown", () => {
  it("carries the price, the airline and the airline that actually flies it", async () => {
    const r = await searchFlights(
      provider(),
      {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2026-12-01",
      },
      AT,
    );
    expect(r.status).toBe("FOUND");
    if (r.status !== "FOUND") return;
    const o = r.search.offers[0]!;
    expect(o).toMatchObject({
      airline: "British Airways",
      totalMinor: 24550,
      currency: "GBP",
      taxMinor: 4010,
      refundable: false,
      changeable: true,
    });
    expect(o.legs[0]).toMatchObject({
      from: "LHR",
      to: "JFK",
      stops: 0,
      durationMinutes: 475,
    });
    // US rules require the operating carrier; it is never dropped.
    expect(o.legs[0]!.segments[0]!.operatedBy).toBe("British Airways");
    expect(r.search.evidence).toBe("PROVIDER_OBSERVED");
    expect(r.search.excludes.join(" ")).toMatch(/bags/);
  });

  it("parses the provider's decimals and durations, or says it cannot", () => {
    expect(decimalToMinor("245.50")).toBe(24550);
    expect(decimalToMinor("245")).toBe(24500);
    expect(decimalToMinor("245.5")).toBe(24550);
    for (const bad of ["", "abc", "-5.00", "1e5", null, 245.5])
      expect(decimalToMinor(bad)).toBeNull();
    expect(isoDurationToMinutes("PT7H55M")).toBe(475);
    expect(isoDurationToMinutes("PT45M")).toBe(45);
    expect(isoDurationToMinutes("P1DT2H")).toBe(1560);
    for (const bad of ["", "7h", "PT", null])
      expect(isoDurationToMinutes(bad)).toBeNull();
  });

  it("picks cheapest and fastest itself, and picks no cheapest across currencies", async () => {
    const cheapSlow = offer({
      id: "off_cheapslow",
      total_amount: "100.00",
      slices: [{ ...offer().slices[0], duration: "PT12H" }],
    });
    const dearFast = offer({
      id: "off_dearfast",
      total_amount: "400.00",
      slices: [{ ...offer().slices[0], duration: "PT6H" }],
    });
    const same = await searchFlights(
      provider({
        searchOffers: () =>
          Promise.resolve({
            status: "OK",
            body: { data: { offers: [dearFast, cheapSlow] } },
          }),
      }),
      { origin: "LHR", destination: "JFK", departureDate: "2026-12-01" },
      AT,
    );
    if (same.status !== "FOUND") throw new Error(same.status);
    expect(same.search.offers[0]!.id).toBe("off_cheapslow");
    expect(same.search.cheapestIndex).toBe(0);
    expect(same.search.offers[same.search.fastestIndex!]!.id).toBe(
      "off_dearfast",
    );

    const mixed = await searchFlights(
      provider({
        searchOffers: () =>
          Promise.resolve({
            status: "OK",
            body: {
              data: {
                offers: [
                  cheapSlow,
                  offer({ id: "off_eur", total_currency: "EUR" }),
                ],
              },
            },
          }),
      }),
      { origin: "LHR", destination: "JFK", departureDate: "2026-12-01" },
      AT,
    );
    if (mixed.status !== "FOUND") throw new Error(mixed.status);
    expect(mixed.search.cheapestIndex).toBeNull();
  });

  it("drops an offer whose price it cannot read rather than showing a priceless card", async () => {
    const r = await searchFlights(
      provider({
        searchOffers: () =>
          Promise.resolve({
            status: "OK",
            body: {
              data: { offers: [offer({ total_currency: "POUNDS" }), offer()] },
            },
          }),
      }),
      { origin: "LHR", destination: "JFK", departureDate: "2026-12-01" },
      AT,
    );
    if (r.status !== "FOUND") throw new Error(r.status);
    expect(r.search.offers).toHaveLength(1);
  });
});

describe("booking, which is the most consequential thing here", () => {
  it("REFUSES to book with a live token, however the request is shaped", async () => {
    const live = provider({ testMode: false });
    const r = await bookFlight(
      live,
      "off_00009htyDGjIfajdNBZRlw",
      [PASSENGER],
      AT,
    );
    expect(r.status).toBe("LIVE_BOOKING_REFUSED");
    // And nothing was sent: the refusal happens before the provider is touched at all.
    expect(live.orders).toHaveLength(0);
  });

  it("prices the order from the provider's fresh quote, never from the caller", async () => {
    // The offer that comes back is dearer than the one the founder saw. The order must use the fresh number.
    const p = provider({
      getOffer: () =>
        Promise.resolve({
          status: "OK",
          body: { data: offer({ total_amount: "999.99" }) },
        }),
    });
    const r = await bookFlight(
      p,
      "off_00009htyDGjIfajdNBZRlw",
      [PASSENGER],
      AT,
    );
    expect(r.status).toBe("BOOKED");
    const sent = p.orders[0] as {
      data: {
        payments: { amount: string; currency: string }[];
        selected_offers: string[];
      };
    };
    expect(sent.data.payments[0]!.amount).toBe("999.99");
    expect(sent.data.payments[0]!.currency).toBe("GBP");
    expect(sent.data.selected_offers).toEqual(["off_00009htyDGjIfajdNBZRlw"]);
  });

  it("will not book an expired offer, and sends nothing when it finds one", async () => {
    const p = provider({
      getOffer: () =>
        Promise.resolve({
          status: "OK",
          body: { data: offer({ expires_at: "2020-01-01T00:00:00Z" }) },
        }),
    });
    expect(
      (await bookFlight(p, "off_00009htyDGjIfajdNBZRlw", [PASSENGER], AT))
        .status,
    ).toBe("OFFER_EXPIRED");
    expect(p.orders).toHaveLength(0);
  });

  it("refuses when the traveller details do not match the offer, and sends nothing", async () => {
    const p = provider();
    // One passenger on the offer, two sets of details.
    expect(
      (
        await bookFlight(
          p,
          "off_00009htyDGjIfajdNBZRlw",
          [PASSENGER, PASSENGER],
          AT,
        )
      ).status,
    ).toBe("INVALID_INPUT");
    expect(p.orders).toHaveLength(0);
  });

  it("refuses details it cannot stand behind", async () => {
    const p = provider();
    for (const bad of [
      { ...PASSENGER, email: "not-an-email" },
      { ...PASSENGER, phoneNumber: "0208 016 0509" },
      { ...PASSENGER, bornOn: "24/07/1987" },
      { ...PASSENGER, title: "captain" },
      { ...PASSENGER, gender: "x" },
      { ...PASSENGER, givenName: "" },
    ])
      expect(validPassenger(bad)).toBeNull();
    expect(validPassenger(PASSENGER)).not.toBeNull();
    // And bookFlight refuses before it touches the provider at all.
    expect(
      (
        await bookFlight(
          p,
          "off_00009htyDGjIfajdNBZRlw",
          [{ ...PASSENGER, email: "not-an-email" }],
          AT,
        )
      ).status,
    ).toBe("INVALID_INPUT");
    // An offer id that is not even shaped like one is refused the same way.
    expect(
      (await bookFlight(p, "not-an-offer-id", [PASSENGER], AT)).status,
    ).toBe("INVALID_INPUT");
    expect(p.orders).toHaveLength(0);
  });

  it("refuses to call an order confirmed if the provider says it was live", async () => {
    const r = await bookFlight(
      provider({
        createOrder: () =>
          Promise.resolve({
            status: "OK",
            body: {
              data: {
                id: "ord_x",
                booking_reference: "RZPNX8",
                live_mode: true,
              },
            },
          }),
      }),
      "off_00009htyDGjIfajdNBZRlw",
      [PASSENGER],
      AT,
    );
    expect(r.status).toBe("LIVE_BOOKING_REFUSED");
  });

  it("returns the airline's own booking reference, marked confirmed", async () => {
    const r = await bookFlight(
      provider(),
      "off_00009htyDGjIfajdNBZRlw",
      [PASSENGER],
      AT,
    );
    expect(r.status).toBe("BOOKED");
    if (r.status !== "BOOKED") return;
    expect(r.booking).toMatchObject({
      bookingReference: "RZPNX8",
      orderId: "ord_00009hthhsUZ8W4LxQgkjo",
      totalMinor: 24550,
      currency: "GBP",
      evidence: "PROVIDER_CONFIRMED",
      liveMode: false,
    });
  });

  it("carries a provider failure through instead of inventing an outcome", async () => {
    for (const status of [
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
    ] as FlightFailure[]) {
      const r = await bookFlight(
        provider({ getOffer: () => Promise.resolve({ status }) }),
        "off_00009htyDGjIfajdNBZRlw",
        [PASSENGER],
        AT,
      );
      expect(r.status).toBe(status);
    }
    // A rejected re-read means the offer is gone, which is a different thing from the provider being down.
    expect(
      (
        await bookFlight(
          provider({
            getOffer: () => Promise.resolve({ status: "PROVIDER_REJECTED" }),
          }),
          "off_00009htyDGjIfajdNBZRlw",
          [PASSENGER],
          AT,
        )
      ).status,
    ).toBe("OFFER_GONE");
  });
});

describe("the Duffel token itself", () => {
  it("decides test mode from the provider's own prefix, and treats anything else as live", () => {
    expect(new DuffelProvider("duffel_test_abc123").testMode).toBe(true);
    expect(new DuffelProvider("duffel_live_abc123").testMode).toBe(false);
    // Not demonstrably a test token: assume live and therefore refuse to book.
    expect(new DuffelProvider("abc123").testMode).toBe(false);
    expect(new DuffelProvider(undefined).testMode).toBe(false);
    expect(new DuffelProvider("  duffel_test_x  ").testMode).toBe(false);
  });

  it("is absent when the environment has none", () => {
    expect(DuffelProvider.fromEnvironment({})).toBeUndefined();
    expect(
      DuffelProvider.fromEnvironment({ DUFFEL_ACCESS_TOKEN: "duffel_test_x" }),
    ).toBeDefined();
  });
});
