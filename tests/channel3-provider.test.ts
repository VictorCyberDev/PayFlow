import { describe, expect, it } from "vitest";
import { ConnectorResultSchema } from "../src/missions/connectors.js";
import { channel3ProductConnector } from "../src/missions/channel3-provider.js";

describe("Channel3 real read-only adapter contract", () => {
  it("uses only documented authenticated search, maps results as untrusted product observations", async () => {
    let called = false;
    const fake: typeof fetch = (_input, init) => {
      called = true;
      expect(_input).toBe("https://api.trychannel3.com/v1/search");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "operator-secret",
      );
      expect(init?.body).toBe('{"query":"desk lamp","limit":5}');
        query: "desk lamp",
        limit: 5,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "prod_123",
                title: "Desk lamp",
                brand: "Example",
                offers: [{ url: "https://merchant.example/lamp" }],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const d = channel3ProductConnector(
      "operator-secret",
      () => "2026-11-12T10:00:00.000Z",
      fake,
    );
    expect(d.mode).toBe("LIVE");
    expect(d.capabilities).toEqual(["SEARCH"]);
    expect(d.credential).toBe("NONE");
    const out = await d.adapter.observe(
      {
        capability: "SEARCH",
        query: { text: "desk lamp", limit: 5 },
      },
      new AbortController().signal,
    );
    expect(called).toBe(true);
    const valid = ConnectorResultSchema.parse(out);
    expect(valid.records).toHaveLength(1);
    expect(valid.records[0]?.kind).toBe("PRODUCT");
    expect(valid.records[0]?.priceObservation).toBeNull();
    expect(valid.records[0]?.claims.provider).toBe("Channel3");
  });

  it("never returns fabricated results on provider rejection", async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(new Response("denied", { status: 401 }));
    const d = channel3ProductConnector(
      "operator-secret",
      () => new Date().toISOString(),
      fake,
    );
    await expect(
      d.adapter.observe(
        {
          capability: "SEARCH",
          query: { text: "desk lamp", limit: 2 },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/CHANNEL3_PROVIDER_UNAVAILABLE/u);
  });

  it("refuses malformed or oversized provider results", async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ id: "bad id", title: "Fake" }] }),
        ),
      );
    const d = channel3ProductConnector(
      "operator-secret",
      () => new Date().toISOString(),
      fake,
    );
    await expect(
      d.adapter.observe(
        {
          capability: "SEARCH",
          query: { text: "desk lamp", limit: 2 },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/CHANNEL3_INVALID_ID/u);
  });
});
