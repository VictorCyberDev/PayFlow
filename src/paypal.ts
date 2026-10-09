import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecutionGrantClaims, ExecutionSink } from "./execution-grant.js";
import { ExecutionQuarantinedError } from "./execution-grant.js";
import type { PostgresTrustRepository } from "./persistence.js";

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const FINAL_CAPTURE = new Set(["COMPLETED"]);
const PENDING_CAPTURE = new Set(["PENDING"]);
const TERMINAL_CAPTURE_FAILURE = new Set(["DECLINED", "DENIED", "REFUNDED", "REVERSED"]);
const precision: Readonly<Record<string, number>> = Object.freeze({ USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, JPY: 0 });

export function paypalMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("INVALID_MONEY_MINOR");
  const digits = precision[currency];
  if (digits === undefined) throw new Error("UNSUPPORTED_PAYPAL_CURRENCY");
  if (digits === 0) return String(minor);
  const base = 10 ** digits;
  return `${Math.floor(minor / base)}.${String(minor % base).padStart(digits, "0")}`;
}

export type ProviderFailureClass = "AUTHENTICATION" | "VALIDATION" | "DEFINITIVE_REJECTION" | "TRANSIENT" | "AMBIGUOUS" | "MALFORMED" | "STATE_MISMATCH";
export class PayPalProviderError extends Error {
  constructor(readonly classification: ProviderFailureClass, message: string, readonly debugId?: string) { super(message); this.name = "PayPalProviderError"; }
}

export interface PayPalOrderView {
  readonly id: string;
  readonly status: string;
  readonly payerActionUrl?: string;
  readonly captures: readonly { readonly id: string; readonly status: string; readonly amountValue: string; readonly currency: string }[];
}
export interface PaymentProvider {
  createOrder(input: { amountValue: string; currency: string; merchantReference: string; requestId: string }): Promise<PayPalOrderView>;
  getOrder(orderId: string): Promise<PayPalOrderView>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrderView>;
}

type FetchLike = typeof fetch;
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const orderSchema = z.object({ id: z.string().min(1), status: z.string().min(1), links: z.array(z.object({ href: z.string().url(), rel: z.string() })).optional(), purchase_units: z.array(z.object({ payments: z.object({ captures: z.array(z.object({ id: z.string().min(1), status: z.string().min(1), amount: z.object({ value: z.string(), currency_code: z.string() }) })).optional() }).optional() })).optional() });

export class PayPalOAuthClient {
  private cached?: { token: string; expiresAt: number };
  private refresh?: Promise<string>;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly fetcher: FetchLike = fetch, private readonly now = () => Date.now()) {
    if (!clientId || !clientSecret) throw new Error("PAYPAL_CREDENTIALS_REQUIRED");
  }
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > this.now()) return this.cached.token;
    if (this.refresh) return this.refresh;
    this.refresh = this.load().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  private async load(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${SANDBOX_BASE}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    } catch { throw new PayPalProviderError("AMBIGUOUS", "PAYPAL_OAUTH_NETWORK_FAILURE"); }
    if (!response.ok) throw new PayPalProviderError("AUTHENTICATION", "PAYPAL_OAUTH_REJECTED", response.headers.get("paypal-debug-id") ?? undefined);
    let parsed: z.infer<typeof tokenSchema>;
    try { parsed = tokenSchema.parse(await response.json()); } catch { throw new PayPalProviderError("MALFORMED", "PAYPAL_OAUTH_MALFORMED_RESPONSE"); }
    this.cached = { token: parsed.access_token, expiresAt: this.now() + parsed.expires_in * 1000 };
    return parsed.access_token;
  }
}

export class PayPalPaymentProvider implements PaymentProvider {
  constructor(private readonly oauth: PayPalOAuthClient, private readonly fetcher: FetchLike = fetch, environment: string = "sandbox") {
    if (environment !== "sandbox") throw new Error("PAYPAL_2D_SANDBOX_ONLY");
  }
  async createOrder(input: { amountValue: string; currency: string; merchantReference: string; requestId: string }): Promise<PayPalOrderView> {
    return this.request("POST", "/v2/checkout/orders", input.requestId, { intent: "CAPTURE", purchase_units: [{ reference_id: input.merchantReference, amount: { currency_code: input.currency, value: input.amountValue } }] }, true);
  }
  async getOrder(orderId: string): Promise<PayPalOrderView> { return this.request("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`); }
  async captureOrder(orderId: string, requestId: string): Promise<PayPalOrderView> { return this.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, requestId, {}, true); }
  private async request(method: string, path: string, requestId?: string, body?: unknown, ambiguousOnFailure = false): Promise<PayPalOrderView> {
    const token = await this.oauth.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(`${SANDBOX_BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new PayPalProviderError(ambiguousOnFailure ? "AMBIGUOUS" : "TRANSIENT", "PAYPAL_NETWORK_FAILURE"); }
    const debugId = response.headers.get("paypal-debug-id") ?? undefined;
    if (!response.ok) {
      if (ambiguousOnFailure && response.status >= 500) throw new PayPalProviderError("AMBIGUOUS", "PAYPAL_AMBIGUOUS_PROVIDER_FAILURE", debugId);
      const kind: ProviderFailureClass = response.status === 401 ? "AUTHENTICATION" : response.status >= 500 ? "TRANSIENT" : response.status === 422 ? "DEFINITIVE_REJECTION" : "VALIDATION";
      throw new PayPalProviderError(kind, "PAYPAL_PROVIDER_REJECTED", debugId);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new PayPalProviderError(ambiguousOnFailure ? "AMBIGUOUS" : "MALFORMED", "PAYPAL_MALFORMED_JSON", debugId); }
    let parsed: z.infer<typeof orderSchema>;
    try { parsed = orderSchema.parse(raw); } catch { throw new PayPalProviderError(ambiguousOnFailure ? "AMBIGUOUS" : "MALFORMED", "PAYPAL_MALFORMED_RESPONSE", debugId); }
    const captures = parsed.purchase_units?.flatMap((u) => u.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status, amountValue: c.amount.value, currency: c.amount.currency_code })) ?? [];
    return Object.freeze({ id: parsed.id, status: parsed.status, payerActionUrl: parsed.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href, captures });
  }
}

function stableRequestId(kind: "create" | "capture", attemptId: string): string { return `payflow-${kind}-${createHash("sha256").update(attemptId).digest("hex").slice(0, 40)}`; }
function row(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object") throw new Error("MALFORMED_PERSISTED_PAYMENT_ATTEMPT"); return v as Record<string, unknown>; }

export class PayPalExecutionRail implements ExecutionSink {
  constructor(private readonly repo: PostgresTrustRepository, private readonly provider: PaymentProvider) {}
  async execute(claims: ExecutionGrantClaims): Promise<{ readonly executionId: string }> {
    const attempt = await this.ensureAttempt(claims);
    let orderId = attempt.provider_order_id ? String(attempt.provider_order_id) : undefined;
    if (!orderId) {
      await this.setState(String(attempt.id), "ORDER_CREATING", "PAYPAL_ORDER_CREATE_STARTED");
      try {
        const order = await this.provider.createOrder({ amountValue: paypalMoney(claims.amountMinor, claims.currency), currency: claims.currency, merchantReference: claims.proposalId, requestId: String(attempt.create_order_request_id) });
        orderId = order.id;
        await this.persistOrder(String(attempt.id), order);
        if (order.payerActionUrl || !["APPROVED", "COMPLETED"].includes(order.status)) {
          await this.setPayerAction(String(attempt.id), order);
          throw new ExecutionQuarantinedError("PAYER_ACTION_REQUIRED");
        }
      } catch (error) {
        if (error instanceof ExecutionQuarantinedError) throw error;
        if (error instanceof PayPalProviderError && error.classification === "AMBIGUOUS") {
          await this.setState(String(attempt.id), "ORDER_CREATE_UNKNOWN", "PAYPAL_ORDER_CREATE_UNKNOWN");
          throw new ExecutionQuarantinedError("PAYPAL_ORDER_CREATE_UNKNOWN");
        }
        await this.fail(String(attempt.id), error); throw error;
      }
    }
    await this.setState(String(attempt.id), "CAPTURE_IN_FLIGHT", "PAYPAL_CAPTURE_STARTED");
    try {
      const order = await this.provider.captureOrder(orderId, String(attempt.capture_request_id));
      return this.applyCaptureResult(claims, String(attempt.id), order);
    } catch (error) {
      if (error instanceof PayPalProviderError && error.classification === "AMBIGUOUS") {
        await this.setState(String(attempt.id), "CAPTURE_UNKNOWN", "PAYPAL_CAPTURE_UNKNOWN");
        throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN");
      }
      await this.fail(String(attempt.id), error); throw error;
    }
  }
  async reconcile(attemptId: string, now = new Date().toISOString()): Promise<{ status: string; executionId?: string }> {
    const rows = await this.repo.sql`select * from payment_attempts where id=${attemptId}`;
    if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
    const a = row(rows[0]);
    const orderId = a.provider_order_id ? String(a.provider_order_id) : undefined;
    if (!orderId) return { status: String(a.status) };
    await this.repo.appendEvidence("PAYPAL_RECONCILIATION_STARTED", { paymentAttemptId: attemptId, paypalOrderId: orderId }, now);
    let order: PayPalOrderView;
    try { order = await this.provider.getOrder(orderId); } catch { return { status: "CAPTURE_UNKNOWN" }; }
    const capture = order.captures[0];
    if (!capture) { await this.repo.sql`update payment_attempts set last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`; return { status: String(a.status) }; }
    this.assertProviderBinding(a, capture);
    if (FINAL_CAPTURE.has(capture.status)) {
      await this.repo.sql.begin(async (tx) => {
        await tx`update payment_attempts set status='CAPTURED',provider_capture_id=${capture.id},provider_capture_status=${capture.status},captured_at=${now},last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`;
        await tx`update execution_grants set status='CONSUMED',consumed_at=${now} where id=${String(a.grant_id)} and status='CLAIMED'`;
        await tx`update authorization_reservations set status='COMMITTED',updated_at=${now} where id=${String(a.reservation_id)} and status='EXECUTING'`;
        await this.repo.appendEvidenceInTransaction(tx, "PAYPAL_RECONCILIATION_RESOLVED", { paymentAttemptId: attemptId, paypalOrderId: orderId, paypalCaptureId: capture.id }, now);
        await this.repo.appendEvidenceInTransaction(tx, "PAYMENT_COMMITTED", { paymentAttemptId: attemptId, paypalCaptureId: capture.id }, now);
      });
      return { status: "CAPTURED", executionId: capture.id };
    }
    await this.repo.sql`update payment_attempts set status='CAPTURE_PENDING_PROVIDER',provider_capture_id=${capture.id},provider_capture_status=${capture.status},last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`;
    return { status: "CAPTURE_PENDING_PROVIDER" };
  }
  private async ensureAttempt(c: ExecutionGrantClaims): Promise<Record<string, unknown>> {
    const id = randomUUID(); const createId = stableRequestId("create", id); const captureId = stableRequestId("capture", id);
    await this.repo.sql`insert into payment_attempts(id,reservation_id,grant_id,proposal_id,mandate_id,principal_id,provider,operation,amount_minor,currency,merchant_reference,idempotency_key,create_order_request_id,capture_request_id,status) values(${id},${c.reservationId},${c.jti},${c.proposalId},${c.mandateId},${c.principalId},'PAYPAL','CAPTURE',${c.amountMinor},${c.currency},${c.merchantId},${createId},${createId},${captureId},'NOT_STARTED') on conflict(reservation_id) do nothing`;
    const rows = await this.repo.sql`select * from payment_attempts where reservation_id=${c.reservationId}`;
    if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_PERSISTENCE_FAILED");
    const a = row(rows[0]);
    if (a.grant_id !== c.jti || Number(a.amount_minor) !== c.amountMinor || a.currency !== c.currency || a.proposal_id !== c.proposalId || a.mandate_id !== c.mandateId || a.principal_id !== c.principalId) throw new Error("PAYMENT_ATTEMPT_BINDING_MISMATCH");
    if (String(a.status) === "CAPTURED" && a.provider_capture_id) return a;
    await this.repo.appendEvidence("PAYMENT_ATTEMPT_CREATED", { paymentAttemptId: String(a.id), grantId: c.jti, reservationId: c.reservationId, amountMinor: c.amountMinor, currency: c.currency }, new Date().toISOString());
    return a;
  }
  private async persistOrder(id: string, order: PayPalOrderView): Promise<void> { await this.repo.sql`update payment_attempts set provider_order_id=${order.id},provider_status=${order.status},status='ORDER_CREATED',updated_at=now() where id=${id}`; await this.repo.appendEvidence("PAYPAL_ORDER_CREATED", { paymentAttemptId: id, paypalOrderId: order.id, status: order.status }, new Date().toISOString()); }
  private async setPayerAction(id: string, order: PayPalOrderView): Promise<void> { await this.repo.sql`update payment_attempts set status='PAYER_ACTION_REQUIRED',payer_action_url=${order.payerActionUrl ?? null},provider_status=${order.status},updated_at=now() where id=${id}`; await this.repo.appendEvidence("PAYPAL_PAYER_ACTION_REQUIRED", { paymentAttemptId: id, paypalOrderId: order.id }, new Date().toISOString()); }
  private async setState(id: string, status: string, event: string): Promise<void> { await this.repo.sql`update payment_attempts set status=${status},updated_at=now() where id=${id}`; await this.repo.appendEvidence(event, { paymentAttemptId: id }, new Date().toISOString()); }
  private async fail(id: string, error: unknown): Promise<void> { const cls = error instanceof PayPalProviderError ? error.classification : "STATE_MISMATCH"; await this.repo.sql`update payment_attempts set status='FAILED',failure_classification=${cls},updated_at=now() where id=${id}`; await this.repo.appendEvidence("PAYMENT_FAILED", { paymentAttemptId: id, classification: cls }, new Date().toISOString()); }
  private assertProviderBinding(a: Record<string, unknown>, capture: PayPalOrderView["captures"][number]): void { if (paypalMoney(Number(a.amount_minor), String(a.currency)) !== capture.amountValue || a.currency !== capture.currency) throw new PayPalProviderError("STATE_MISMATCH", "PAYPAL_CAPTURE_BINDING_MISMATCH"); }
  private async applyCaptureResult(c: ExecutionGrantClaims, id: string, order: PayPalOrderView): Promise<{ readonly executionId: string }> {
    const capture = order.captures[0]; if (!capture) { await this.setState(id, "CAPTURE_UNKNOWN", "PAYPAL_CAPTURE_UNKNOWN"); throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN"); }
    if (capture.amountValue !== paypalMoney(c.amountMinor, c.currency) || capture.currency !== c.currency) { await this.fail(id, new PayPalProviderError("STATE_MISMATCH", "PAYPAL_CAPTURE_BINDING_MISMATCH")); throw new PayPalProviderError("STATE_MISMATCH", "PAYPAL_CAPTURE_BINDING_MISMATCH"); }
    if (FINAL_CAPTURE.has(capture.status)) { await this.repo.sql`update payment_attempts set status='CAPTURED',provider_capture_id=${capture.id},provider_capture_status=${capture.status},provider_order_id=${order.id},provider_status=${order.status},captured_at=now(),updated_at=now() where id=${id}`; await this.repo.appendEvidence("PAYPAL_CAPTURE_CONFIRMED", { paymentAttemptId: id, paypalOrderId: order.id, paypalCaptureId: capture.id, amountMinor: c.amountMinor, currency: c.currency }, new Date().toISOString()); return { executionId: capture.id }; }
    if (PENDING_CAPTURE.has(capture.status)) { await this.repo.sql`update payment_attempts set status='CAPTURE_PENDING_PROVIDER',provider_capture_id=${capture.id},provider_capture_status=${capture.status},updated_at=now() where id=${id}`; throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_PENDING"); }
    if (TERMINAL_CAPTURE_FAILURE.has(capture.status)) { await this.fail(id, new PayPalProviderError("DEFINITIVE_REJECTION", "PAYPAL_CAPTURE_DECLINED")); throw new PayPalProviderError("DEFINITIVE_REJECTION", "PAYPAL_CAPTURE_DECLINED"); }
    await this.setState(id, "CAPTURE_UNKNOWN", "PAYPAL_CAPTURE_UNKNOWN"); throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN");
  }
}

export function paypalProviderFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher: FetchLike = fetch): PayPalPaymentProvider {
  if (env.PAYPAL_ENVIRONMENT !== "sandbox") throw new Error("PAYPAL_2D_SANDBOX_ONLY");
  return new PayPalPaymentProvider(new PayPalOAuthClient(env.PAYPAL_CLIENT_ID ?? "", env.PAYPAL_CLIENT_SECRET ?? "", fetcher), fetcher, env.PAYPAL_ENVIRONMENT);
}
