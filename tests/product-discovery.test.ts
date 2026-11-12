import { describe, expect, it } from "vitest";
import { handleExploreRequest } from "../api/explore.js";
import {
  discoverProducts,
  type DiscoveryFailure,
  type ProductCatalogue,
} from "../src/partner/product-discovery.js";

/** Shaped from the published Channel3 response schema (docs.trychannel3.com/guides/response-overview, read 2026-11-12). */
const BODY = {
  products: [
    {
      id: "prod_1",
      title: "27-inch 4K studio display",
      description: "A colour-accurate panel.",
      brands: [{ id: "b1", name: "Northfield" }],
      images: [
        {
          url: "https://cdn.example.com/a.jpg",
          cleaned_url: "https://cdn.example.com/a-clean.jpg",
          is_main_image: true,
          alt_text: "A display on a desk",
        },
      ],
      offers: [
        {
          url: "https://shop.example.com/p/1",
          domain: "shop.example.com",
          price: { price: 429.99, compare_at_price: 499, currency: "usd" },
          availability: "InStock",
          condition: "new",
          max_commission_rate: 0.06,
        },
        {
          url: "https://other.example.com/p/1",
          domain: "other.example.com",
          price: { price: 399.5, compare_at_price: null, currency: "USD" },
          availability: "OutOfStock",
          condition: null,
          max_commission_rate: 0,
        },
      ],
      next_field_we_do_not_know_about: true,
    },
  ],
  next_page_token: null,
};

function catalogueReturning(body: unknown): ProductCatalogue {
  return { search: () => Promise.resolve({ status: "OK" as const, body }) };
}
function catalogueFailing(status: DiscoveryFailure): ProductCatalogue {
  return { search: () => Promise.resolve({ status }) };
}
const AT = () => "2026-11-12T00:00:00.000Z";
const found = async (body: unknown) => {
  const r = await discoverProducts(
    catalogueReturning(body),
    "studio display",
    AT,
  );
  if (r.status !== "FOUND") throw new Error(`expected FOUND, got ${r.status}`);
  return r.discovery;
};

describe("what a founder is shown after a product search", () => {
  it("carries the provider's own price, currency, merchant and stock, in minor units", async () => {
    const d = await found(BODY);
    const p = d.products[0]!;
    expect(p.title).toBe("27-inch 4K studio display");
    expect(p.brand).toBe("Northfield");
    expect(p.imageUrl).toBe("https://cdn.example.com/a-clean.jpg");
    expect(p.offers).toHaveLength(2);
    expect(p.offers[0]).toMatchObject({
      merchant: "shop.example.com",
      priceMinor: 42999,
      currency: "USD",
      wasPriceMinor: 49900,
      inStock: true,
      condition: "new",
      earnsCommission: true,
    });
    expect(p.offers[1]).toMatchObject({
      priceMinor: 39950,
      wasPriceMinor: null,
      inStock: false,
      earnsCommission: false,
    });
  });

  it("is never presented as a quote or a total", async () => {
    const d = await found(BODY);
    expect(d.evidence).toBe("PROVIDER_OBSERVED");
    expect(d.excludes).toContain("delivery");
    expect(d.excludes).toContain("tax and duties");
    // No total is computed anywhere: a listing plus unknown shipping and tax is not a cost.
    expect(JSON.stringify(d)).not.toMatch(/total/i);
  });

  it("picks the cheapest offer itself, and refuses to pick one across currencies", async () => {
    expect((await found(BODY)).products[0]!.bestOfferIndex).toBe(1);
    const mixed = structuredClone(BODY);
    mixed.products[0]!.offers[1]!.price.currency = "EUR";
    expect((await found(mixed)).products[0]!.bestOfferIndex).toBeNull();
  });

  it("never shows a strike-through price that was not really higher", async () => {
    const fake = structuredClone(BODY);
    fake.products[0]!.offers[0]!.price.compare_at_price = 1;
    expect(
      (await found(fake)).products[0]!.offers[0]!.wasPriceMinor,
    ).toBeNull();
  });
});

describe("an untrusted catalogue answer", () => {
  it("loses any link or image that is not plain https", async () => {
    const hostile = structuredClone(BODY);
    const image = hostile.products[0]!.images[0]!;
    image.cleaned_url = "javascript:alert(1)";
    image.url = "http://cdn.example.com/a.jpg";
    hostile.products[0]!.offers[0]!.url =
      "https://user:pass@shop.example.com/p/1";
    const d = await found(hostile);
    expect(d.products[0]!.imageUrl).toBeNull();
    // The offer carrying embedded credentials is dropped; the clean one survives.
    expect(d.products[0]!.offers).toHaveLength(1);
    expect(d.products[0]!.offers[0]!.merchant).toBe("other.example.com");
  });

  it("drops a product with no usable offer rather than showing a priceless card", async () => {
    const noOffers: { products: { offers: unknown[] }[] } =
      structuredClone(BODY);
    noOffers.products[0]!.offers = [];
    const r = await discoverProducts(
      catalogueReturning(noOffers),
      "studio display",
      AT,
    );
    expect(r.status).toBe("FOUND");
    if (r.status === "FOUND") expect(r.discovery.products).toHaveLength(0);
  });

  it("strips control characters before a browser renders the title", async () => {
    const nasty = structuredClone(BODY);
    nasty.products[0]!.title = "Display\u0000\u001b[31m injected";
    expect((await found(nasty)).products[0]!.title).not.toMatch(
      // eslint-disable-next-line no-control-regex -- asserting the control characters are gone
      /[\u0000-\u001f]/u,
    );
  });

  it("is rejected whole when it does not match the published shape", async () => {
    for (const body of [null, { products: "nope" }, { nope: 1 }, []])
      expect(
        (await discoverProducts(catalogueReturning(body), "x y", AT)).status,
      ).toBe("INVALID_CATALOGUE_OUTPUT");
  });

  it("carries each provider failure through, and refuses an unusable query", async () => {
    for (const s of [
      "CATALOGUE_UNAVAILABLE",
      "CATALOGUE_TIMEOUT",
      "CATALOGUE_REJECTED",
    ] as const)
      expect(
        (await discoverProducts(catalogueFailing(s), "x y", AT)).status,
      ).toBe(s);
    expect(
      (await discoverProducts(catalogueReturning(BODY), "x", AT)).status,
    ).toBe("INVALID_INPUT");
    expect((await discoverProducts(undefined, "x y", AT)).status).toBe(
      "CATALOGUE_NOT_CONFIGURED",
    );
  });
});

// ---------------------------------------------------------------------------------------- the endpoint
const ORIGIN = "https://payflow.example";
let clock = 5_000_000;
const freshWindow = () => (clock += 120_000);
const post = (
  body: unknown,
  init: { origin?: string; method?: string; caller?: string } = {},
) =>
  new Request(`${ORIGIN}/api/explore`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: init.origin ?? ORIGIN,
      "x-forwarded-for": init.caller ?? "203.0.113.11",
    },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /api/explore", () => {
  it("answers a search with observations and an explicit disclosure", async () => {
    const res = await handleExploreRequest(
      post({ query: "studio display" }),
      catalogueReturning(BODY),
      freshWindow(),
      AT,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, never>;
    expect(body.status).toBe("FOUND");
    expect(String(body.disclosure)).toMatch(/not quotes/i);
    expect(String(body.disclosure)).toMatch(/has not ordered anything/i);
  });

  it("refuses anything but a same-origin POST, and limits a burst", async () => {
    expect(
      (
        await handleExploreRequest(
          post({ query: "x y" }, { method: "GET" }),
          catalogueReturning(BODY),
          freshWindow(),
          AT,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleExploreRequest(
          post({ query: "x y" }, { origin: "https://evil.example" }),
          catalogueReturning(BODY),
          freshWindow(),
          AT,
        )
      ).status,
    ).toBe(403);
    const now = freshWindow();
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1)
      codes.push(
        (
          await handleExploreRequest(
            post({ query: "x y" }, { caller: "198.51.100.44" }),
            catalogueReturning(BODY),
            now,
            AT,
          )
        ).status,
      );
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });

  it("tells a customer what happened without naming a provider, a code or a key", async () => {
    for (const failure of [
      "CATALOGUE_NOT_CONFIGURED",
      "CATALOGUE_UNAVAILABLE",
      "CATALOGUE_TIMEOUT",
    ] as const) {
      const res = await handleExploreRequest(
        post({ query: "studio display" }),
        catalogueFailing(failure),
        freshWindow(),
        AT,
      );
      expect(res.ok).toBe(false);
      const text = await res.text();
      expect(text).not.toMatch(/channel3|x-api-key|CATALOGUE_|undefined/i);
    }
  });
});
