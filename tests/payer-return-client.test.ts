import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = readFileSync("public/payer-return.js", "utf8");
function browser(fetcher: typeof fetch) {
  const root = {
    dataset: { state: "CHECKING_PAYMENT_STATUS", token: "84K24314DT6923830" },
  };
  const nodes: Record<string, { textContent: string }> = {
    title: { textContent: "Checking payment status…" },
    message: { textContent: "checking" },
    reference: { textContent: "" },
  };
  const events = vi.fn();
  runInNewContext(script, {
    document: {
      querySelector: () => root,
      getElementById: (key: string) => nodes[key],
    },
    window: { addEventListener: events },
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    encodeURIComponent,
    fetch: fetcher,
  });
  return { root, nodes, events };
}
const view = (state: string, title = state) =>
  Response.json({ state, title, message: "durable result", reference: "safe" });
afterEach(() => vi.useRealTimers());

describe("bounded read-only return polling", () => {
  it("transitions to success and stops polling immediately", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(view("CHECKING_PAYMENT_STATUS"))
      .mockResolvedValueOnce(view("PAYMENT_COMPLETE", "Payment complete"));
    const b = browser(fetcher);
    await vi.advanceTimersByTimeAsync(30000);
    expect(b.root.dataset.state).toBe("PAYMENT_COMPLETE");
    expect(b.nodes.title!.textContent).toBe("Payment complete");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe("/paypal/status?token=84K24314DT6923830");
      expect(options?.method).toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out at 25 seconds without declaring false failure", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(view("CHECKING_PAYMENT_STATUS")),
      );
    const b = browser(fetcher);
    await vi.advanceTimersByTimeAsync(60000);
    expect(b.root.dataset.state).toBe("CHECKING_PAYMENT_STATUS");
    expect(b.nodes.title!.textContent).toBe("Still checking payment status");
    expect(b.nodes.message!.textContent).toContain("safely refresh");
    expect(fetcher).toHaveBeenCalledTimes(13);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts a hung request at the wall-clock limit", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const b = browser(fetcher);
    await vi.advanceTimersByTimeAsync(26000);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(b.nodes.title!.textContent).toBe("Still checking payment status");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops on unavailable and renders server text without HTML injection", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(view("PAYMENT_FAILED", "<script>"));
    const b = browser(fetcher);
    await vi.advanceTimersByTimeAsync(30000);
    expect(b.nodes.title!.textContent).toBe("<script>");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
