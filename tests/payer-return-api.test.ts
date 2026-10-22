import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../api/paypal.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("deployed payer return entry point", () => {
  it("missing durable store returns a safe unavailable page", async () => {
    vi.stubEnv("PAYFLOW_STATUS_DATABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await GET(
      new Request("https://payflow.test/paypal/return?token=84K24314DT6923830"),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Payment status unavailable");
  });
  it("malformed database config never exposes credentials", async () => {
    vi.stubEnv("PAYFLOW_STATUS_DATABASE_URL", "postgres://[secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await GET(
      new Request("https://payflow.test/paypal/return?token=84K24314DT6923830"),
    );
    expect(r.status).toBe(503);
    const html = await r.text();
    expect(html).toContain("Payment status unavailable");
    expect(html).not.toContain("postgres://");
  });
});
