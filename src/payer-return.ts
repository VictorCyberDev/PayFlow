import type postgres from "postgres";

export type ReturnState =
  | "PAYMENT_COMPLETE"
  | "CHECKING_PAYMENT_STATUS"
  | "PAYMENT_CANCELLED"
  | "PAYMENT_FAILED";
export interface ReturnView {
  state: ReturnState;
  title: string;
  message: string;
  reference?: string;
}
export interface DurablePayment {
  status: string;
  providerStatus: string | null;
  captureStatus: string | null;
  captureId: string | null;
  capturedAt: Date | null;
  grantState: string | null;
  reservationState: string | null;
  amountMinor: string;
  currency: string;
}
export interface PaymentStatusReader {
  find(orderId: string): Promise<DurablePayment | null>;
}

export function unavailable(): ReturnView {
  return {
    state: "PAYMENT_FAILED",
    title: "Payment status unavailable",
    message:
      "We cannot verify this payment right now. You can safely refresh this page. Do not make another payment while the outcome is unknown.",
  };
}

export function orderToken(params: URLSearchParams): string | null {
  const values = params.getAll("token");
  const token = values[0];
  return values.length === 1 && token && /^[A-Z0-9]{17}$/.test(token)
    ? token
    : null;
}

export function presentPayment(
  payment: DurablePayment,
  orderId: string,
  cancelled: boolean,
): ReturnView {
  if (payment.status === "CAPTURED") {
    if (
      payment.providerStatus !== "COMPLETED" ||
      payment.captureStatus !== "COMPLETED" ||
      !payment.captureId ||
      !payment.capturedAt ||
      payment.grantState !== "CONSUMED" ||
      payment.reservationState !== "COMMITTED" ||
      !/^[1-9][0-9]{0,15}$/.test(payment.amountMinor) ||
      !/^[A-Z]{3}$/.test(payment.currency)
    )
      return unavailable();
    const precision =
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: payment.currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
    const digits = payment.amountMinor.padStart(precision + 1, "0");
    const amount = precision
      ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}`
      : digits;
    return {
      state: "PAYMENT_COMPLETE",
      title: "Payment complete",
      message: `${amount} ${payment.currency} paid successfully. Verified by PayFlow.`,
      reference: orderId,
    };
  }
  if (payment.status === "FAILED" && !payment.captureId)
    return {
      state: "PAYMENT_FAILED",
      title: "Payment could not be completed",
      message:
        "PayFlow recorded a failed payment. No payment retry is made here.",
    };
  // UNKNOWN/quarantined/inconsistent outcomes are never labelled cancelled.
  if (
    !["PAYER_ACTION_REQUIRED", "CREATING", "CAPTURING", "CREATED"].includes(
      payment.status,
    )
  )
    return unavailable();
  if (cancelled && payment.status === "PAYER_ACTION_REQUIRED")
    return {
      state: "PAYMENT_CANCELLED",
      title: "Checkout cancelled",
      message:
        "You left checkout. This does not confirm that the payment failed. You can safely refresh to check its final status.",
    };
  return {
    state: "CHECKING_PAYMENT_STATUS",
    title: "Checking payment status…",
    message:
      "PayFlow is checking the recorded payment outcome. Please do not pay again.",
  };
}

interface StatusRow extends postgres.Row {
  status: string;
  provider_status: string | null;
  provider_capture_status: string | null;
  provider_capture_id: string | null;
  captured_at: Date | null;
  amount_minor: string;
  currency: string;
  grant_state: string | null;
  reservation_state: string | null;
}

export class PostgresPaymentStatusReader implements PaymentStatusReader {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async find(orderId: string): Promise<DurablePayment | null> {
    // A coherent, read-only snapshot; this module has no execution rail.
    return this.sql.begin("read only", async (tx) => {
      await tx`set local statement_timeout = '3000ms'`;
      const rows = await tx<StatusRow[]>`
        select p.status, p.provider_status, p.provider_capture_status,
          p.provider_capture_id, p.captured_at, p.amount_minor::text,
          p.currency, g.status as grant_state, r.status as reservation_state
        from payment_attempts p
        left join execution_grants g on g.id = p.grant_id
        left join authorization_reservations r on r.id = p.reservation_id
        where p.provider = 'PAYPAL' and p.provider_order_id = ${orderId}
        limit 2`;
      if (rows.length !== 1) return null;
      const p = rows[0]!;
      return {
        status: p.status,
        providerStatus: p.provider_status,
        captureStatus: p.provider_capture_status,
        captureId: p.provider_capture_id,
        capturedAt: p.captured_at,
        grantState: p.grant_state,
        reservationState: p.reservation_state,
        amountMinor: p.amount_minor,
        currency: p.currency,
      };
    });
  }
}

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ] ?? ""
    );
  });

export async function payerReturnResponse(
  request: Request,
  reader: PaymentStatusReader,
): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET" },
    });
  if (!["/paypal/return", "/paypal/cancel", "/paypal/status"].includes(route))
    return new Response("Not found", { status: 404, headers });
  const token = orderToken(url.searchParams);
  let view = unavailable();
  let status = 400;
  if (token) {
    try {
      const payment = await reader.find(token);
      status = payment ? 200 : 404;
      if (payment)
        view = presentPayment(payment, token, route === "/paypal/cancel");
    } catch {
      status = 503;
      // Deliberately omit tokens, raw errors, database URLs and provider data.
      console.error("PAYFLOW_PAYER_STATUS_UNAVAILABLE");
    }
  }
  if (route === "/paypal/status")
    return Response.json(view, { status, headers });
  const checking = view.state === "CHECKING_PAYMENT_STATUS";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(view.title)} · PayFlow</title><link rel="stylesheet" href="/payer-return.css"></head><body><main data-state="${view.state}"${checking && token ? ` data-token="${token}"` : ""}><p class="brand">PayFlow</p><h1 id="title">${escape(view.title)}</h1><p id="message" role="status" aria-live="polite">${escape(view.message)}</p><p id="reference">${view.reference ? `Reference: ${escape(view.reference)}` : ""}</p><p>You can safely refresh this page to check again.</p><noscript>Automatic updates need JavaScript. Refresh this page to check the recorded status.</noscript></main>${checking ? '<script src="/payer-return.js" defer></script>' : ""}</body></html>`;
  return new Response(html, {
    status,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
