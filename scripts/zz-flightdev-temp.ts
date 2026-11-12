// Local UI harness: the real static export plus a fixture /api/flights shaped from Duffel's documented response.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { handleFlightsRequest } from "/home/user/PayFlow/api/flights.js";
import type { FlightProvider } from "/home/user/PayFlow/src/partner/flights.js";

const ROOT = "/home/user/PayFlow/apps/console/out";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".txt": "text/plain",
  ".xml": "application/xml",
};
const seg = (
  from: string,
  to: string,
  dep: string,
  arr: string,
  carrier: string,
  no: string,
) => ({
  origin: { iata_code: from },
  destination: { iata_code: to },
  departing_at: dep,
  arriving_at: arr,
  operating_carrier: {
    name: carrier,
    iata_code: carrier.slice(0, 2).toUpperCase(),
  },
  marketing_carrier_flight_number: no,
});
const offer = (
  id: string,
  amount: string,
  dur: string,
  segs: unknown[],
  owner: string,
) => ({
  id,
  total_amount: amount,
  total_currency: "GBP",
  tax_amount: "48.20",
  expires_at: "2030-01-01T00:00:00Z",
  owner: { name: owner },
  passengers: [{ id: "pas_00009hj8USM7Ncg31cBCLL" }],
  conditions: {
    refund_before_departure: { allowed: false },
    change_before_departure: { allowed: true },
  },
  slices: [
    {
      origin: { iata_code: "LHR" },
      destination: { iata_code: "JFK" },
      duration: dur,
      segments: segs,
    },
  ],
});
const OFFERS = [
  offer(
    "off_direct",
    "612.40",
    "PT7H55M",
    [
      seg(
        "LHR",
        "JFK",
        "2026-12-15T09:45:00",
        "2026-12-15T12:40:00",
        "British Airways",
        "117",
      ),
    ],
    "British Airways",
  ),
  offer(
    "off_cheap",
    "388.10",
    "PT13H20M",
    [
      seg(
        "LHR",
        "KEF",
        "2026-12-15T07:10:00",
        "2026-12-15T09:35:00",
        "Icelandair",
        "451",
      ),
      seg(
        "KEF",
        "JFK",
        "2026-12-15T13:05:00",
        "2026-12-15T15:30:00",
        "Icelandair",
        "613",
      ),
    ],
    "Icelandair",
  ),
  offer(
    "off_mid",
    "505.00",
    "PT9H40M",
    [
      seg(
        "LHR",
        "DUB",
        "2026-12-15T06:30:00",
        "2026-12-15T07:55:00",
        "Aer Lingus",
        "163",
      ),
      seg(
        "DUB",
        "JFK",
        "2026-12-15T09:40:00",
        "2026-12-15T12:10:00",
        "Aer Lingus",
        "105",
      ),
    ],
    "Aer Lingus",
  ),
];
const provider: FlightProvider = {
  testMode: true,
  searchOffers: () =>
    Promise.resolve({ status: "OK", body: { data: { offers: OFFERS } } }),
  getOffer: (id) =>
    Promise.resolve({
      status: "OK",
      body: { data: OFFERS.find((o) => o.id === id) ?? OFFERS[0] },
    }),
  createOrder: () =>
    Promise.resolve({
      status: "OK",
      body: {
        data: {
          id: "ord_00009hthhsUZ8W4LxQgkjo",
          booking_reference: "RZPNX8",
          total_amount: "612.40",
          total_currency: "GBP",
          live_mode: false,
        },
      },
    }),
};
createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost:4340");
  if (url.pathname === "/api/flights") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string") headers.set(k, v);
    const request = new Request("http://localhost:4340/api/flights", {
      method: req.method,
      headers,
      body: Buffer.concat(chunks),
    });
    const out = await handleFlightsRequest(
      request,
      provider,
      Date.now() + Math.random() * 1e6,
    );
    const h: Record<string, string> = {};
    out.headers.forEach((v, k) => {
      h[k] = v;
    });
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  for (const c of [
    join(ROOT, p),
    join(ROOT, p + ".html"),
    join(ROOT, p, "index.html"),
  ]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, {
        "content-type": TYPES[extname(c)] ?? "application/octet-stream",
      });
      res.end(b);
      return;
    } catch {}
  }
  res.writeHead(404);
  res.end("404");
}).listen(4340, () => console.log("flights dev on 4340"));
