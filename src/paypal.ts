import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecutionGrantClaims, ExecutionSink } from "./execution-grant.js";
import { ExecutionQuarantinedError } from "./execution-outcome.js";
import type { PostgresTrustRepository } from "./persistence.js";

const BASE = "https://api-m.sandbox.paypal.com";
const PRECISION: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
};
export function paypalMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor <= 0)
    throw new Error("INVALID_MONEY_MINOR");
  const p = PRECISION[currency];
  if (p === undefined) throw new Error("UNSUPPORTED_PAYPAL_CURRENCY");
  if (p === 0) return String(minor);
  const d = 10 ** p;
  return `${Math.floor(minor / d)}.${String(minor % d).padStart(p, "0")}`;
}

export type ProviderFailureClass =
  | "AUTHENTICATION"
  | "VALIDATION"
  | "DEFINITIVE_REJECTION"
  | "TRANSIENT"
  | "AMBIGUOUS"
  | "MALFORMED"
  | "STATE_MISMATCH";
export class PayPalProviderError extends Error {
  constructor(
    readonly classification: ProviderFailureClass,
    message: string,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalProviderError";
  }
}
export interface PayPalOrderView {
  readonly id: string;
  readonly status: string;
  readonly payerActionUrl?: string;
  readonly captures: readonly {
    id: string;
    status: string;
    amountValue: string;
    currency: string;
  }[];
}
export interface PaymentProvider {
  createOrder(input: {
    amountValue: string;
    currency: string;
    merchantReference: string;
    requestId: string;
  }): Promise<PayPalOrderView>;
  getOrder(orderId: string): Promise<PayPalOrderView>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrderView>;
}
type FetchLike = typeof fetch;
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  links: z
    .array(z.object({ href: z.string().url(), rel: z.string() }))
    .optional(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({
            captures: z
              .array(
                z.object({
                  id: z.string().min(1),
                  status: z.string().min(1),
                  amount: z.object({
                    value: z.string(),
                    currency_code: z.string(),
                  }),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export class PayPalOAuthClient {
  private cache?: { token: string; expiresAt: number };
  private inflight: Promise<string> | undefined;
  constructor(
    private readonly id: string,
    private readonly secret: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly clock = () => Date.now(),
  ) {
    if (!id || !secret) throw new Error("PAYPAL_CREDENTIALS_REQUIRED");
  }
  async accessToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt - 30_000 > this.clock())
      return this.cache.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  private async refresh(): Promise<string> {
    let r: Response;
    try {
      r = await this.fetcher(`${BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.id}:${this.secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch {
      throw new PayPalProviderError(
        "TRANSIENT",
        "PAYPAL_OAUTH_NETWORK_FAILURE",
      );
    }
    if (!r.ok)
      throw new PayPalProviderError(
        "AUTHENTICATION",
        "PAYPAL_OAUTH_REJECTED",
        r.headers.get("paypal-debug-id") ?? undefined,
      );
    let v: z.infer<typeof tokenSchema>;
    try {
      v = tokenSchema.parse(await r.json());
    } catch {
      throw new PayPalProviderError(
        "MALFORMED",
        "PAYPAL_OAUTH_MALFORMED_RESPONSE",
      );
    }
    this.cache = {
      token: v.access_token,
      expiresAt: this.clock() + v.expires_in * 1000,
    };
    return v.access_token;
  }
}

export class PayPalPaymentProvider implements PaymentProvider {
  constructor(
    private readonly oauth: PayPalOAuthClient,
    private readonly fetcher: FetchLike = fetch,
    environment = "sandbox",
  ) {
    if (environment !== "sandbox") throw new Error("PAYPAL_2D_SANDBOX_ONLY");
  }
  createOrder(i: {
    amountValue: string;
    currency: string;
    merchantReference: string;
    requestId: string;
  }): Promise<PayPalOrderView> {
    return this.call(
      "POST",
      "/v2/checkout/orders",
      i.requestId,
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: i.merchantReference,
            amount: { currency_code: i.currency, value: i.amountValue },
          },
        ],
      },
      true,
    );
  }
  getOrder(id: string): Promise<PayPalOrderView> {
    return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }
  captureOrder(id: string, requestId: string): Promise<PayPalOrderView> {
    return this.call(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      requestId,
      {},
      true,
    );
  }
  private async call(
    method: string,
    path: string,
    requestId?: string,
    body?: unknown,
    ambiguous = false,
  ): Promise<PayPalOrderView> {
    const token = await this.oauth.accessToken();
    let r: Response;
    try {
      r = await this.fetcher(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PayPalProviderError(
        ambiguous ? "AMBIGUOUS" : "TRANSIENT",
        "PAYPAL_NETWORK_FAILURE",
      );
    }
    const debug = r.headers.get("paypal-debug-id") ?? undefined;
    if (!r.ok) {
      if (ambiguous && r.status >= 500)
        throw new PayPalProviderError(
          "AMBIGUOUS",
          "PAYPAL_AMBIGUOUS_PROVIDER_FAILURE",
          debug,
        );
      throw new PayPalProviderError(
        r.status === 401
          ? "AUTHENTICATION"
          : r.status === 422
            ? "DEFINITIVE_REJECTION"
            : r.status >= 500
              ? "TRANSIENT"
              : "VALIDATION",
        "PAYPAL_PROVIDER_REJECTED",
        debug,
      );
    }
    let p: z.infer<typeof orderSchema>;
    try {
      p = orderSchema.parse(await r.json());
    } catch {
      throw new PayPalProviderError(
        ambiguous ? "AMBIGUOUS" : "MALFORMED",
        "PAYPAL_MALFORMED_RESPONSE",
        debug,
      );
    }
    const captures =
      p.purchase_units
        ?.flatMap((u) => u.payments?.captures ?? [])
        .map((c) => ({
          id: c.id,
          status: c.status,
          amountValue: c.amount.value,
          currency: c.amount.currency_code,
        })) ?? [];
    const payerActionUrl = p.links?.find(
      (l) => l.rel === "payer-action" || l.rel === "approve",
    )?.href;
    return {
      id: p.id,
      status: p.status,
      ...(payerActionUrl ? { payerActionUrl } : {}),
      captures,
    };
  }
}

function requestId(kind: string, attemptId: string): string {
  return `payflow-${kind}-${createHash("sha256").update(attemptId).digest("hex").slice(0, 40)}`;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`MALFORMED_PAYMENT_ATTEMPT_${name}`);
  return value;
}

function asRow(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object") throw new Error("MALFORMED_PAYMENT_ATTEMPT");
  return v as Record<string, unknown>;
}

export class PayPalExecutionRail implements ExecutionSink {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly provider: PaymentProvider,
  ) {}
  async execute(
    c: ExecutionGrantClaims,
  ): Promise<{ readonly executionId: string }> {
    const a = await this.ensureAttempt(c);
    let orderId = a.provider_order_id
      ? requiredString(a.provider_order_id, "PROVIDER_ORDER_ID")
      : undefined;
    if (!orderId) {
      await this.state(
        String(a.id),
        "ORDER_CREATING",
        "PAYPAL_ORDER_CREATE_STARTED",
      );
      try {
        const order = await this.provider.createOrder({
          amountValue: paypalMoney(c.amountMinor, c.currency),
          currency: c.currency,
          merchantReference: c.proposalId,
          requestId: String(a.create_order_request_id),
        });
        orderId = order.id;
        await this.repo
          .sql`update payment_attempts set provider_order_id=${order.id},provider_status=${order.status},status='ORDER_CREATED',payer_action_url=${order.payerActionUrl ?? null},updated_at=now() where id=${String(a.id)}`;
        await this.repo.appendEvidence(
          "PAYPAL_ORDER_CREATED",
          { paymentAttemptId: String(a.id), paypalOrderId: order.id },
          new Date().toISOString(),
        );
        if (
          order.payerActionUrl ||
          !["APPROVED", "COMPLETED"].includes(order.status)
        ) {
          await this.state(
            String(a.id),
            "PAYER_ACTION_REQUIRED",
            "PAYPAL_PAYER_ACTION_REQUIRED",
          );
          throw new ExecutionQuarantinedError("PAYER_ACTION_REQUIRED");
        }
      } catch (e) {
        if (e instanceof ExecutionQuarantinedError) throw e;
        if (
          e instanceof PayPalProviderError &&
          e.classification === "AMBIGUOUS"
        ) {
          await this.state(
            String(a.id),
            "ORDER_CREATE_UNKNOWN",
            "PAYPAL_ORDER_CREATE_UNKNOWN",
          );
          throw new ExecutionQuarantinedError("PAYPAL_ORDER_CREATE_UNKNOWN");
        }
        await this.fail(String(a.id), e);
        throw e;
      }
    }
    await this.state(
      String(a.id),
      "CAPTURE_IN_FLIGHT",
      "PAYPAL_CAPTURE_STARTED",
    );
    try {
      return await this.capture(
        c,
        String(a.id),
        await this.provider.captureOrder(orderId, String(a.capture_request_id)),
      );
    } catch (e) {
      if (e instanceof ExecutionQuarantinedError) throw e;
      if (
        e instanceof PayPalProviderError &&
        e.classification === "AMBIGUOUS"
      ) {
        await this.state(
          String(a.id),
          "CAPTURE_UNKNOWN",
          "PAYPAL_CAPTURE_UNKNOWN",
        );
        throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN");
      }
      await this.fail(String(a.id), e);
      throw e;
    }
  }
  async reconcile(
    attemptId: string,
    now = new Date().toISOString(),
  ): Promise<string> {
    const rows = await this.repo
      .sql`select * from payment_attempts where id=${attemptId}`;
    if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
    const a = asRow(rows[0]);
    if (!a.provider_order_id) return String(a.status);
    await this.repo.appendEvidence(
      "PAYPAL_RECONCILIATION_STARTED",
      {
        paymentAttemptId: attemptId,
        paypalOrderId: requiredString(a.provider_order_id, "PROVIDER_ORDER_ID"),
      },
      now,
    );
    let order: PayPalOrderView;
    try {
      order = await this.provider.getOrder(
        requiredString(a.provider_order_id, "PROVIDER_ORDER_ID"),
      );
    } catch {
      return "CAPTURE_UNKNOWN";
    }
    const cap = order.captures[0];
    if (!cap) return String(a.status);
    this.assertBinding(a, cap);
    if (cap.status !== "COMPLETED") {
      await this.repo
        .sql`update payment_attempts set status='CAPTURE_PENDING_PROVIDER',provider_capture_id=${cap.id},provider_capture_status=${cap.status},last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`;
      return "CAPTURE_PENDING_PROVIDER";
    }
    await this.repo.sql.begin(async (tx) => {
      await tx`update payment_attempts set status='CAPTURED',provider_capture_id=${cap.id},provider_capture_status=${cap.status},captured_at=${now},last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`;
      await tx`update execution_grants set status='CONSUMED',consumed_at=${now} where id=${String(a.grant_id)} and status='CLAIMED'`;
      await tx`update authorization_reservations set status='COMMITTED',updated_at=${now} where id=${String(a.reservation_id)} and status='EXECUTING'`;
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYPAL_RECONCILIATION_RESOLVED",
        { paymentAttemptId: attemptId, paypalCaptureId: cap.id },
        now,
      );
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYMENT_COMMITTED",
        { paymentAttemptId: attemptId, paypalCaptureId: cap.id },
        now,
      );
    });
    return "CAPTURED";
  }
  private async ensureAttempt(
    c: ExecutionGrantClaims,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID(),
      create = requestId("create", id),
      capture = requestId("capture", id);
    await this.repo
      .sql`insert into payment_attempts(id,reservation_id,grant_id,proposal_id,mandate_id,principal_id,provider,operation,amount_minor,currency,merchant_reference,idempotency_key,create_order_request_id,capture_request_id,status) values(${id},${c.reservationId},${c.jti},${c.proposalId},${c.mandateId},${c.principalId},'PAYPAL','CAPTURE',${c.amountMinor},${c.currency},${c.merchantId},${create},${create},${capture},'NOT_STARTED') on conflict(reservation_id) do nothing`;
    const rows = await this.repo
      .sql`select * from payment_attempts where reservation_id=${c.reservationId}`;
    if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_PERSISTENCE_FAILED");
    const a = asRow(rows[0]);
    if (
      a.grant_id !== c.jti ||
      a.proposal_id !== c.proposalId ||
      a.mandate_id !== c.mandateId ||
      a.principal_id !== c.principalId ||
      Number(a.amount_minor) !== c.amountMinor ||
      a.currency !== c.currency
    )
      throw new Error("PAYMENT_ATTEMPT_BINDING_MISMATCH");
    await this.repo.appendEvidence(
      "PAYMENT_ATTEMPT_CREATED",
      {
        paymentAttemptId: String(a.id),
        grantId: c.jti,
        reservationId: c.reservationId,
        amountMinor: c.amountMinor,
        currency: c.currency,
      },
      new Date().toISOString(),
    );
    return a;
  }
  private async capture(
    c: ExecutionGrantClaims,
    id: string,
    order: PayPalOrderView,
  ): Promise<{ readonly executionId: string }> {
    const cap = order.captures[0];
    if (!cap) {
      await this.state(id, "CAPTURE_UNKNOWN", "PAYPAL_CAPTURE_UNKNOWN");
      throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN");
    }
    if (
      cap.amountValue !== paypalMoney(c.amountMinor, c.currency) ||
      cap.currency !== c.currency
    ) {
      await this.fail(
        id,
        new PayPalProviderError(
          "STATE_MISMATCH",
          "PAYPAL_CAPTURE_BINDING_MISMATCH",
        ),
      );
      throw new PayPalProviderError(
        "STATE_MISMATCH",
        "PAYPAL_CAPTURE_BINDING_MISMATCH",
      );
    }
    if (cap.status === "COMPLETED") {
      await this.repo
        .sql`update payment_attempts set status='CAPTURED',provider_order_id=${order.id},provider_status=${order.status},provider_capture_id=${cap.id},provider_capture_status=${cap.status},captured_at=now(),updated_at=now() where id=${id}`;
      await this.repo.appendEvidence(
        "PAYPAL_CAPTURE_CONFIRMED",
        {
          paymentAttemptId: id,
          paypalOrderId: order.id,
          paypalCaptureId: cap.id,
          amountMinor: c.amountMinor,
          currency: c.currency,
        },
        new Date().toISOString(),
      );
      return { executionId: cap.id };
    }
    if (cap.status === "PENDING") {
      await this.state(
        id,
        "CAPTURE_PENDING_PROVIDER",
        "PAYPAL_CAPTURE_PENDING",
      );
      throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_PENDING");
    }
    if (["DECLINED", "DENIED", "REFUNDED", "REVERSED"].includes(cap.status)) {
      await this.fail(
        id,
        new PayPalProviderError(
          "DEFINITIVE_REJECTION",
          "PAYPAL_CAPTURE_DECLINED",
        ),
      );
      throw new PayPalProviderError(
        "DEFINITIVE_REJECTION",
        "PAYPAL_CAPTURE_DECLINED",
      );
    }
    await this.state(id, "CAPTURE_UNKNOWN", "PAYPAL_CAPTURE_UNKNOWN");
    throw new ExecutionQuarantinedError("PAYPAL_CAPTURE_UNKNOWN");
  }
  private assertBinding(
    a: Record<string, unknown>,
    c: PayPalOrderView["captures"][number],
  ): void {
    if (
      paypalMoney(Number(a.amount_minor), String(a.currency)) !==
        c.amountValue ||
      a.currency !== c.currency
    )
      throw new PayPalProviderError(
        "STATE_MISMATCH",
        "PAYPAL_CAPTURE_BINDING_MISMATCH",
      );
  }
  private async state(
    id: string,
    status: string,
    event: string,
  ): Promise<void> {
    await this.repo
      .sql`update payment_attempts set status=${status},updated_at=now() where id=${id}`;
    await this.repo.appendEvidence(
      event,
      { paymentAttemptId: id },
      new Date().toISOString(),
    );
  }
  private async fail(id: string, e: unknown): Promise<void> {
    const classification =
      e instanceof PayPalProviderError ? e.classification : "STATE_MISMATCH";
    await this.repo
      .sql`update payment_attempts set status='FAILED',failure_classification=${classification},updated_at=now() where id=${id}`;
    await this.repo.appendEvidence(
      "PAYMENT_FAILED",
      { paymentAttemptId: id, classification },
      new Date().toISOString(),
    );
  }
}

export function paypalProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: FetchLike = fetch,
): PayPalPaymentProvider {
  if (env.PAYPAL_ENVIRONMENT !== "sandbox")
    throw new Error("PAYPAL_2D_SANDBOX_ONLY");
  return new PayPalPaymentProvider(
    new PayPalOAuthClient(
      env.PAYPAL_CLIENT_ID ?? "",
      env.PAYPAL_CLIENT_SECRET ?? "",
      fetcher,
    ),
    fetcher,
    env.PAYPAL_ENVIRONMENT,
  );
}
