import { describe, expect, it, vi } from "vitest";
import {
  orderToken,
  payerReturnResponse,
  presentPayment,
  type DurablePayment,
  type ReturnView,
} from "../src/payer-return.js";

const token = "84K24314DT6923830";
const complete: DurablePayment = {
  status: "CAPTURED",
  providerStatus: "COMPLETED",
  captureStatus: "COMPLETED",
  captureId: "9LL848107V907405A",
  capturedAt: new Date(),
  grantState: "CONSUMED",
  reservationState: "COMMITTED",
  amountMinor: "8400",
  currency: "USD",
};
const request = (path = "return", query = `token=${token}`) =>
  new Request(`https://payflow.test/paypal/${path}?${query}`);

describe("read-only payer return", () => {
  it("renders durable success, including on cancel and reload", async () => {
    const find = vi.fn().mockResolvedValue(complete);
    for (const path of ["return", "return", "cancel"]) {
      const response = await payerReturnResponse(request(path), { find });
      const html = await response.text();
      expect(html).toContain("Payment complete");
      expect(html).toContain("84.00 USD paid successfully");
      expect(html).not.toContain('<script src="/payer-return.js"');
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect(find).toHaveBeenCalledTimes(3);
    expect(find).toHaveBeenCalledWith(token);
  });
  it("ignores every browser success claim", async () => {
    const find = vi.fn().mockResolvedValue({
      ...complete,
      status: "PAYER_ACTION_REQUIRED",
      captureId: null,
    });
    const response = await payerReturnResponse(
      request(
        "return",
        `token=${token}&success=true&status=CAPTURED&PayerID=p`,
      ),
      { find },
    );
    const html = await response.text();
    expect(html).toContain("CHECKING_PAYMENT_STATUS");
    expect(html).toContain("/payer-return.js");
    expect(html).not.toContain("paid successfully");
  });
  it("reads pending then completed durable state", async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ...complete, status: "CAPTURING" })
      .mockResolvedValueOnce(complete);
    const first = await payerReturnResponse(request("status"), { find });
    expect(((await first.json()) as ReturnView).state).toBe(
      "CHECKING_PAYMENT_STATUS",
    );
    const next = await payerReturnResponse(request("status"), { find });
    expect(((await next.json()) as ReturnView).state).toBe("PAYMENT_COMPLETE");
  });
  it("treats browser cancellation as navigation, not a failure", () => {
    const view = presentPayment(
      { ...complete, status: "PAYER_ACTION_REQUIRED", captureId: null },
      token,
      true,
    );
    expect(view.state).toBe("PAYMENT_CANCELLED");
    expect(view.message).toContain("does not confirm");
  });
  it.each([
    ["providerStatus", "APPROVED"],
    ["captureStatus", null],
    ["captureId", null],
    ["capturedAt", null],
    ["grantState", "CLAIMED"],
    ["reservationState", "EXECUTING"],
    ["amountMinor", "-1"],
    ["currency", "<script>"],
  ])("rejects inconsistent captured evidence: %s", (key, value) => {
    expect(
      presentPayment({ ...complete, [key]: value }, token, false).state,
    ).toBe("PAYMENT_FAILED");
  });
  it.each(["UNKNOWN", "QUARANTINED", "NOT_A_STATE"])(
    "never labels %s as browser cancellation or success",
    (status) => {
      const view = presentPayment({ ...complete, status }, token, true);
      expect(view.title).toBe("Payment status unavailable");
    },
  );
  it("shows durable failure only without captured funds", () => {
    const view = presentPayment(
      { ...complete, status: "FAILED", captureId: null },
      token,
      false,
    );
    expect(view.title).toBe("Payment could not be completed");
    expect(
      presentPayment({ ...complete, status: "FAILED" }, token, false).title,
    ).toBe("Payment status unavailable");
  });
  it.each([
    "",
    "token=short",
    "token=../../secret",
    `token=${token}&token=${token}`,
    `token=${token.toLowerCase()}`,
    "token=%3Cscript%3Ealert(1)%3C/script%3E",
  ])("rejects malformed token without a database read: %s", async (query) => {
    const find = vi.fn();
    expect(orderToken(new URLSearchParams(query))).toBeNull();
    const response = await payerReturnResponse(request("return", query), {
      find,
    });
    expect(response.status).toBe(400);
    expect(find).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("alert(1)");
  });
  it("unknown order is safe and reveals no payment data", async () => {
    const response = await payerReturnResponse(request(), {
      find: vi.fn().mockResolvedValue(null),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Payment status unavailable");
  });
  it("database outage is unavailable without leaking secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await payerReturnResponse(request(), {
        find: () => Promise.reject(new Error("postgres://secret")),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("postgres://secret");
      expect(log).toHaveBeenCalledWith("PAYFLOW_PAYER_STATUS_UNAVAILABLE");
    } finally {
      log.mockRestore();
    }
  });
  it("rejects mutation methods without reading", async () => {
    const find = vi.fn();
    const response = await payerReturnResponse(
      new Request(request(), { method: "POST" }),
      { find },
    );
    expect(response.status).toBe(405);
    expect(find).not.toHaveBeenCalled();
  });
});
