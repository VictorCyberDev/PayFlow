import { z } from "zod";

/**
 * V4 — live product discovery for the consumer app.
 *
 * Channel3 returns a structured catalogue: price, currency, availability and merchant domain live on each OFFER, not on the
 * product (https://docs.trychannel3.com/guides/response-overview, read 2026-11-12). That is richer than the read-only
 * connector in src/missions/channel3-provider.ts could safely assume, so this module surfaces those fields — and keeps the
 * same discipline about what they mean.
 *
 * A search hit is an OBSERVATION, never a quote:
 *   - the price is what one merchant listed at the moment of the request, and it is labelled as such, with its own currency;
 *   - prices in different currencies are never added together, and no total is computed here at all;
 *   - shipping, tax and duties are NOT in this data, so nothing here may be presented as a total cost;
 *   - availability is the merchant's own claim;
 *   - an offer that can earn PayFlow a commission is flagged, so the interface can say so rather than hide it.
 *
 * Everything crossing this boundary is untrusted: URLs must be https with no credentials, strings are bounded, and anything
 * that fails validation is dropped rather than repaired.
 */
export const DISCOVERY_LIMITS = Object.freeze({
  queryCharacters: 160,
  timeoutMs: 12_000,
  responseBytes: 1_000_000,
  maxProducts: 12,
  maxOffersPerProduct: 4,
});

const ENDPOINT = "https://api.trychannel3.com/v1/search";

/** Only what this surface shows. Unknown Channel3 fields are ignored rather than passed through to a browser. */
const OfferSchema = z
  .object({
    url: z.string().max(2048),
    domain: z.string().max(120),
    price: z.object({
      price: z.number().finite().nonnegative().max(10_000_000),
      compare_at_price: z
        .number()
        .finite()
        .nonnegative()
        .max(10_000_000)
        .nullish(),
      currency: z.string().length(3),
    }),
    availability: z.string().max(40),
    condition: z.string().max(40).nullish(),
    max_commission_rate: z.number().finite().min(0).max(1).nullish(),
  })
  .passthrough();

const ProductSchema = z
  .object({
    id: z.string().max(128),
    title: z.string().max(300),
    description: z.string().max(2000).nullish(),
    brands: z
      .array(z.object({ name: z.string().max(200) }).passthrough())
      .nullish(),
    images: z
      .array(
        z
          .object({
            url: z.string().max(2048),
            cleaned_url: z.string().max(2048).nullish(),
            is_main_image: z.boolean().nullish(),
            alt_text: z.string().max(300).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    offers: z.array(OfferSchema).nullish(),
  })
  .passthrough();

const SearchResponseSchema = z
  .object({ products: z.array(ProductSchema).max(200) })
  .passthrough();

export interface DiscoveredOffer {
  readonly merchant: string;
  readonly url: string;
  /** Minor units of `currency`. Never summed with an offer in another currency. */
  readonly priceMinor: number;
  readonly currency: string;
  readonly wasPriceMinor: number | null;
  readonly inStock: boolean | null;
  readonly condition: string | null;
  /** True when this listing can earn PayFlow a commission. Disclosed in the interface, never hidden. */
  readonly earnsCommission: boolean;
}
export interface DiscoveredProduct {
  readonly id: string;
  readonly title: string;
  readonly brand: string | null;
  readonly summary: string | null;
  readonly imageUrl: string | null;
  readonly imageAlt: string;
  readonly offers: readonly DiscoveredOffer[];
  /** The cheapest offer's index, or null when no offer survived validation. Chosen here, not by the provider's ordering. */
  readonly bestOfferIndex: number | null;
}
export interface Discovery {
  readonly query: string;
  readonly products: readonly DiscoveredProduct[];
  readonly observedAt: string;
  /** The ladder from docs/v4/WILLIE-EXPERIENCE-TRANSFER.md. A search hit never climbs above this. */
  readonly evidence: "PROVIDER_OBSERVED";
  /** Stated so a reader cannot mistake a listing for a total. */
  readonly excludes: readonly string[];
}

export type DiscoveryFailure =
  | "CATALOGUE_NOT_CONFIGURED"
  | "CATALOGUE_UNAVAILABLE"
  | "CATALOGUE_TIMEOUT"
  | "CATALOGUE_REJECTED"
  | "INVALID_CATALOGUE_OUTPUT"
  | "INVALID_INPUT";
export type DiscoveryResult =
  { status: "FOUND"; discovery: Discovery } | { status: DiscoveryFailure };

export interface ProductCatalogue {
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: DiscoveryFailure }>;
}

/** https only, no embedded credentials, no javascript: or data: smuggled through a long string. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters before a browser sees them is the point
  const t = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return t.length > 0 ? t.slice(0, max) : null;
};
const minor = (amount: number): number => Math.round(amount * 100);

function normalizeOffer(
  raw: z.infer<typeof OfferSchema>,
): DiscoveredOffer | null {
  const url = safeUrl(raw.url);
  const merchant = clean(raw.domain, 120);
  const currency = /^[A-Za-z]{3}$/u.test(raw.price.currency)
    ? raw.price.currency.toUpperCase()
    : null;
  if (!url || !merchant || !currency) return null;
  // A "was" price is only shown when the provider gives one AND it is genuinely higher: a fake strike-through is a dark pattern.
  const was =
    typeof raw.price.compare_at_price === "number" &&
    raw.price.compare_at_price > raw.price.price
      ? minor(raw.price.compare_at_price)
      : null;
  const availability = raw.availability.toLowerCase();
  return {
    merchant,
    url,
    priceMinor: minor(raw.price.price),
    currency,
    wasPriceMinor: was,
    inStock: availability.includes("instock")
      ? true
      : availability.includes("outofstock")
        ? false
        : null,
    condition: clean(raw.condition, 40),
    earnsCommission:
      typeof raw.max_commission_rate === "number" &&
      raw.max_commission_rate > 0,
  };
}

function normalizeProduct(
  raw: z.infer<typeof ProductSchema>,
): DiscoveredProduct | null {
  const title = clean(raw.title, 300);
  const id = clean(raw.id, 128);
  if (!title || !id) return null;
  const offers = (raw.offers ?? [])
    .map(normalizeOffer)
    .filter((o): o is DiscoveredOffer => o !== null)
    .slice(0, DISCOVERY_LIMITS.maxOffersPerProduct);
  const images = raw.images ?? [];
  const main = images.find((i) => i.is_main_image) ?? images[0];
  // Channel3's own guidance: prefer cleaned_url for grids, fall back to url.
  const imageUrl = main
    ? (safeUrl(main.cleaned_url) ?? safeUrl(main.url))
    : null;
  // Cheapest is only meaningful inside one currency; with mixed currencies no "best" is claimed.
  const currencies = new Set(offers.map((o) => o.currency));
  let bestOfferIndex: number | null = null;
  if (offers.length > 0 && currencies.size === 1)
    bestOfferIndex = offers.reduce(
      (best, o, i) => (o.priceMinor < offers[best]!.priceMinor ? i : best),
      0,
    );
  return {
    id,
    title,
    brand: clean(raw.brands?.[0]?.name, 200),
    summary: clean(raw.description, 300),
    imageUrl,
    imageAlt: clean(main?.alt_text, 300) ?? title,
    offers,
    bestOfferIndex,
  };
}

export async function discoverProducts(
  catalogue: ProductCatalogue | undefined,
  rawQuery: unknown,
  now: () => string = () => new Date().toISOString(),
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  if (!catalogue) return { status: "CATALOGUE_NOT_CONFIGURED" };
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (query.length < 2 || query.length > DISCOVERY_LIMITS.queryCharacters)
    return { status: "INVALID_INPUT" };
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => ctl.abort(), DISCOVERY_LIMITS.timeoutMs);
  try {
    const r = await catalogue.search(query, ctl.signal);
    if (r.status !== "OK") return { status: r.status };
    const parsed = SearchResponseSchema.safeParse(r.body);
    if (!parsed.success) return { status: "INVALID_CATALOGUE_OUTPUT" };
    const products = parsed.data.products
      .map(normalizeProduct)
      .filter((p): p is DiscoveredProduct => p !== null && p.offers.length > 0)
      .slice(0, DISCOVERY_LIMITS.maxProducts);
    return {
      status: "FOUND",
      discovery: Object.freeze({
        query,
        products: Object.freeze(products),
        observedAt: now(),
        evidence: "PROVIDER_OBSERVED",
        excludes: Object.freeze([
          "delivery",
          "tax and duties",
          "any merchant fees at checkout",
        ]),
      }),
    };
  } catch {
    return {
      status: ctl.signal.aborted
        ? "CATALOGUE_TIMEOUT"
        : "CATALOGUE_UNAVAILABLE",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Channel3 search. Server-side only; the key never leaves this process. */
export class Channel3Catalogue implements ProductCatalogue {
  readonly #key: string;
  constructor(
    apiKey: string | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#key = apiKey && !/[\r\n\s]/u.test(apiKey) ? apiKey : "";
  }
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Channel3Catalogue | undefined {
    const key = env["CHANNEL3_API_KEY"];
    return key ? new Channel3Catalogue(key) : undefined;
  }
  async search(query: string, signal: AbortSignal) {
    if (!this.#key) return { status: "CATALOGUE_NOT_CONFIGURED" as const };
    let res: Response;
    try {
      res = await this.transport(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "x-api-key": this.#key, "content-type": "application/json" },
        body: JSON.stringify({
          query,
          limit: DISCOVERY_LIMITS.maxProducts,
        }),
      });
    } catch {
      return {
        status: signal.aborted
          ? ("CATALOGUE_TIMEOUT" as const)
          : ("CATALOGUE_UNAVAILABLE" as const),
      };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        status:
          res.status === 401 || res.status === 403
            ? ("CATALOGUE_NOT_CONFIGURED" as const)
            : res.status >= 500 || res.status === 429
              ? ("CATALOGUE_UNAVAILABLE" as const)
              : ("CATALOGUE_REJECTED" as const),
      };
    }
    try {
      const raw = (await res.text()).slice(0, DISCOVERY_LIMITS.responseBytes);
      return { status: "OK" as const, body: JSON.parse(raw) as unknown };
    } catch {
      return { status: "INVALID_CATALOGUE_OUTPUT" as const };
    }
  }
}
