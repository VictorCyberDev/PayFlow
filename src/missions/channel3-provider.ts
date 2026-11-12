import type { ConnectorDefinition, ConnectorQuery } from "./connectors.js";

/**
 * Operator-enabled, READ-ONLY Channel3 discovery.
 * All use still passes ConnectorService's installation, mission, capability, budget,
 * circuit-breaker, idempotency and call-limit checks. External product data is
 * untrusted; no purchase, checkout, outreach or provider commitment occurs here.
 *
 * API reference: https://docs.trychannel3.com/
 * API: POST https://api.trychannel3.com/v1/search; x-api-key auth.
 */
export function channel3ProductConnector(
  apiKey: string,
  now: () => string,
  transport: typeof fetch = fetch,
): ConnectorDefinition {
  if (!apiKey || /[\r\n]/u.test(apiKey) || apiKey.trim() !== apiKey)
    throw new Error("CHANNEL3_KEY_INVALID");
  const endpoint = "https://api.trychannel3.com/v1/search";

  const safeUrl = (x: unknown): string | null => {
    if (typeof x !== "string" || x.length > 2048) return null;
    try {
      const u = new URL(x);
      return u.protocol === "https:" && !u.username && !u.password ? x : null;
    } catch {
      return null;
    }
  };

  const mapProduct = (raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("CHANNEL3_INVALID_PRODUCT");
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(p.id))
      throw new Error("CHANNEL3_INVALID_ID");
    const name = typeof p.title === "string" ? p.title : p.name;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200)
      throw new Error("CHANNEL3_INVALID_TITLE");
    const offers = Array.isArray(p.offers) ? p.offers : [];
    const first = offers.find((v) => v && typeof v === "object" && !Array.isArray(v)) as
      | Record<string, unknown>
      | undefined;
    const claims: Record<string, string | number | boolean | null> = {
      provider: "Channel3",
      offerCount: Math.min(offers.length, 1000000),
      resultOrder: index + 1,
    };
    if (typeof p.brand === "string" && p.brand.length <= 200)
      claims.brand = p.brand;
    // Price and availability are deliberately UNKNOWN until their variant,
    // currency, merchant and units can be independently normalized.
    // A product-search response must not become a verified merchant quote.
    return {
      recordId: p.id,
      kind: "PRODUCT" as const,
      title: name.trim(),
      priceObservation: null,
      availableQuantity: null,
      url: safeUrl(first?.url),
      observedAt: now(),
      claims,
    };
  };

  return {
    id: "channel3-products",
    displayName: "Channel3 product discovery",
    providerTypes: ["COMMERCE_MARKETPLACE"],
    mode: "LIVE",
    capabilities: ["SEARCH"],
    credential: "NONE", // Operator-managed API key; never customer-supplied or exposed.
    dataUse:
      "Product searches are sent to Channel3 using PayFlow's operator-managed API access. Results and merchant offers are untrusted observations, not verified quotes or purchase commitments.",
    limits: { maxRecords: 20, maxResultBytes: 131072, timeoutMs: 12000, callsPerHour: 20 },
    adapter: {
      async observe(request: { capability: "SEARCH" | "READ" | "COMPARE" | "STATUS" | "VERIFY"; query: ConnectorQuery }, signal: AbortSignal) {
        if (request.capability !== "SEARCH" || !request.query.text)
          throw new Error("CHANNEL3_SEARCH_QUERY_REQUIRED");
        const res = await transport(endpoint, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "content-type": "application/json",
          },
          redirect: "error",
          signal,
          body: JSON.stringify({ query: request.query.text, limit: Math.min(request.query.limit, 20) }),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error("CHANNEL3_PROVIDER_UNAVAILABLE");
        }
        // Bound provider JSON size; the common connector service imposes its own
        // response-time and result-size limits after this adapter returns.
        const contentLength = Number(res.headers.get("content-length") ?? "0");
        if (contentLength > 131072) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error("CHANNEL3_RESPONSE_TOO_LARGE");
        }
        const body = await res.text();
        if (Buffer.byteLength(body, "utf8") > 131072)
          throw new Error("CHANNEL3_RESPONSE_TOO_LARGE");
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("CHANNEL3_INVALID_RESPONSE");
        const data = parsed as Record<string, unknown>;
        const records = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data.products)
            ? data.products
            : Array.isArray(data.items)
              ? data.items
              : null;
        if (!records) throw new Error("CHANNEL3_INVALID_RESPONSE");
        return { records: records.slice(0, Math.min(request.query.limit, 20)).map(mapProduct) };
      },
    },
  };
}
