"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EvidenceChip, FlowObject, type FlowState } from "./flow";

type Offer = {
  merchant: string;
  url: string;
  priceMinor: number;
  currency: string;
  wasPriceMinor: number | null;
  inStock: boolean | null;
  condition: string | null;
  earnsCommission: boolean;
};
type Product = {
  id: string;
  title: string;
  brand: string | null;
  summary: string | null;
  imageUrl: string | null;
  imageAlt: string;
  offers: Offer[];
  bestOfferIndex: number | null;
};
type Discovery = {
  query: string;
  products: Product[];
  observedAt: string;
  evidence: string;
  excludes: string[];
};

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** A reply from the network is data, not truth. Anything off-shape is treated as no result. Exported for tests. */
export function readDiscovery(value: unknown): Discovery | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (d.evidence !== "PROVIDER_OBSERVED" || !Array.isArray(d.products))
    return null;
  const products = d.products.filter(
    (p): p is Product =>
      !!p &&
      typeof p === "object" &&
      typeof (p as Product).title === "string" &&
      Array.isArray((p as Product).offers) &&
      (p as Product).offers.length > 0,
  );
  return {
    query: typeof d.query === "string" ? d.query : "",
    products,
    observedAt: typeof d.observedAt === "string" ? d.observedAt : "",
    evidence: "PROVIDER_OBSERVED",
    excludes: Array.isArray(d.excludes)
      ? d.excludes.filter((e): e is string => typeof e === "string")
      : [],
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; discovery: Discovery }
  | { kind: "unavailable"; message: string };

const FALLBACK =
  "PayFlow could not reach the product catalogue. Nothing was ordered. You can still walk the guided demo.";

export function Explore() {
  const params = useSearchParams();
  const [query, setQuery] = useState((params?.get("q") ?? "").slice(0, 160));
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const state: FlowState =
    phase.kind === "searching"
      ? "searching"
      : phase.kind === "found"
        ? "comparing"
        : phase.kind === "unavailable"
          ? "unverified"
          : "ready";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setPhase({ kind: "searching" });
    try {
      const res = await fetch("/api/explore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!live.current) return;
      const discovery =
        body && typeof body === "object"
          ? readDiscovery((body as Record<string, unknown>).discovery)
          : null;
      if (res.ok && discovery) {
        setPhase({ kind: "found", discovery });
        return;
      }
      const message =
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).message === "string"
          ? ((body as Record<string, unknown>).message as string)
          : FALLBACK;
      setPhase({ kind: "unavailable", message });
    } catch {
      if (live.current) setPhase({ kind: "unavailable", message: FALLBACK });
    }
  }

  return (
    <>
      <section className="wrap flow__hero flow__hero--demo">
        <div className="stack">
          <p className="eyebrow">Explore</p>
          <h1>What do you need to buy?</h1>
          <form className="stack" onSubmit={(e) => void submit(e)}>
            <div className="field">
              <label htmlFor="q">Describe the item</label>
              <input
                id="q"
                type="text"
                maxLength={160}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="27-inch 4K monitor for a design studio"
              />
            </div>
            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={phase.kind === "searching"}
              >
                {phase.kind === "searching" ? "Searching…" : "Find options"}
              </button>
              <Link className="btn btn--ghost" href="/partner/">
                Plan the whole thing instead
              </Link>
            </div>
          </form>
        </div>
        <FlowObject state={state} />
      </section>

      <div aria-live="polite" className="wrap band">
        {phase.kind === "unavailable" && (
          <section className="stack">
            <h2>No results to show</h2>
            <p className="lede">{phase.message}</p>
            <Link className="btn" href="/try/">
              Walk the guided demo instead
            </Link>
          </section>
        )}

        {phase.kind === "found" && phase.discovery.products.length === 0 && (
          <section className="stack">
            <h2>Nothing matched that</h2>
            <p className="lede">
              The catalogue answered, but nothing it returned had a price and a
              seller PayFlow could verify — so it is showing you nothing rather
              than a card it cannot stand behind. Try different words.
            </p>
          </section>
        )}

        {phase.kind === "found" && phase.discovery.products.length > 0 && (
          <section className="stack">
            <EvidenceChip kind="PROVIDER_OBSERVED" />
            <h2>
              {phase.discovery.products.length} options, observed just now
            </h2>
            <div className="banner">
              <span aria-hidden="true">●</span>
              <p>
                <strong>These are listings, not quotes.</strong> Each price is
                what that seller showed a moment ago. It excludes{" "}
                {phase.discovery.excludes.join(", ")}. PayFlow has not ordered,
                reserved or paid for anything.
              </p>
            </div>
            <div className="grid grid--3" style={{ width: "100%" }}>
              {phase.discovery.products.map((p) => (
                <article className="card" key={p.id}>
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a static export cannot run next/image's optimizer
                    <img
                      className="product__image"
                      src={p.imageUrl}
                      alt={p.imageAlt}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div
                      className="product__image product__image--none"
                      aria-hidden="true"
                    />
                  )}
                  {p.brand && <span className="eyebrow">{p.brand}</span>}
                  <h3>{p.title}</h3>
                  {p.summary && <p>{p.summary}</p>}
                  <dl className="ledger" style={{ width: "100%" }}>
                    {p.offers.map((o, i) => (
                      <div
                        className={
                          i === p.bestOfferIndex
                            ? "ledger__row ledger__row--total"
                            : "ledger__row"
                        }
                        key={o.url}
                      >
                        <dt>
                          <a
                            className="text-link"
                            href={o.url}
                            rel="nofollow noopener noreferrer sponsored"
                            target="_blank"
                          >
                            {o.merchant}
                          </a>
                          {i === p.bestOfferIndex && p.offers.length > 1 && (
                            <span className="offer__tag offer__tag--best">
                              Cheapest
                            </span>
                          )}
                          {o.earnsCommission && (
                            <span className="offer__tag">Commission</span>
                          )}
                          {o.inStock === false && " — out of stock"}
                          {o.condition &&
                            o.condition !== "new" &&
                            ` — ${o.condition}`}
                        </dt>
                        <dd>
                          {money(o.priceMinor, o.currency)}
                          {o.wasPriceMinor !== null && (
                            <span className="product__was">
                              {" "}
                              was {money(o.wasPriceMinor, o.currency)}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {p.offers.some((o) => o.earnsCommission) && (
                    <p className="quiet-note">
                      PayFlow may earn a commission from the seller marked{" "}
                      <em>Commission</em>. It does not change the price you pay,
                      and it did not change how these are ordered.
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
