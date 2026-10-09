import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
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
  readonly purchaseUnits: readonly {
    referenceId: string;
    amountValue?: string;
    currency?: string;
  }[];
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
        reference_id: z.string().min(1),
        amount: z
          .object({ value: z.string(), currency_code: z.string() })
          .optional(),
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
          Prefer: "return=representation",
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
      purchaseUnits: (p.purchase_units ?? []).map((u) => ({
        referenceId: u.reference_id,
        ...(u.amount
          ? { amountValue: u.amount.value, currency: u.amount.currency_code }
          : {}),
      })),
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
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_RECONCILIATION_TIME");
    // Session-scoped serialization survives transaction boundaries, but never
    // holds a transaction across a provider request. Process death releases it.
    const db = await this.repo.sql.reserve();
    let locked = false;
    try {
      await db`select pg_advisory_lock(hashtextextended(${attemptId}, 2))`;
      locked = true;
      const rows =
        await db`select * from payment_attempts where id=${attemptId}`;
      if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      let a = asRow(rows[0]);
      if (["FAILED", "CANCELLED", "NOT_STARTED"].includes(String(a.status)))
        return String(a.status);
      await this.reconciliationTransaction(db, async (tx) => {
        const attempts =
          await tx`select * from payment_attempts where id=${attemptId} for update`;
        if (!attempts[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
        a = asRow(attempts[0]);
        await this.assertAuthority(tx, a, a.status === "CAPTURED");
        if (
          a.status === "CAPTURED" &&
          (!a.provider_order_id ||
            !a.provider_capture_id ||
            a.provider_capture_status !== "COMPLETED")
        )
          throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
      });
      await this.reconciliationTransaction(db, (tx) =>
        this.repo.appendEvidenceInTransaction(
          tx,
          "PAYPAL_RECONCILIATION_STARTED",
          { paymentAttemptId: attemptId },
          now,
        ),
      );

      if (!a.provider_order_id) {
        if (
          !["ORDER_CREATE_UNKNOWN", "ORDER_CREATING"].includes(String(a.status))
        )
          throw new Error("PAYMENT_ATTEMPT_ORDER_MISSING");
        if (!this.retryWindow(a, now)) return String(a.status);
        let created: PayPalOrderView;
        try {
          created = await this.provider.createOrder({
            amountValue: paypalMoney(
              Number(a.amount_minor),
              String(a.currency),
            ),
            currency: requiredString(a.currency, "CURRENCY"),
            // Original create uses the proposal as PayPal reference_id.
            merchantReference: requiredString(a.proposal_id, "PROPOSAL_ID"),
            requestId: requiredString(
              a.create_order_request_id,
              "CREATE_REQUEST_ID",
            ),
          });
        } catch {
          await this.reconciliationState(db, a, "ORDER_CREATE_UNKNOWN", now);
          return "ORDER_CREATE_UNKNOWN";
        }
        this.assertOrder(a, created, true);
        const status =
          created.payerActionUrl ||
          ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"].includes(created.status)
            ? "PAYER_ACTION_REQUIRED"
            : "ORDER_CREATED";
        await this.reconciliationTransaction(db, async (tx) => {
          const rows =
            await tx`select * from payment_attempts where id=${attemptId} for update`;
          if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
          const current = asRow(rows[0]);
          this.assertUnchanged(a, current);
          await this.assertAuthority(tx, current);
          const changed =
            await tx`update payment_attempts set provider_order_id=${created.id},provider_status=${created.status},payer_action_url=${created.payerActionUrl ?? null},status=${status},last_reconciled_at=${now},updated_at=${now} where id=${attemptId} and status=${String(a.status)} returning id`;
          if (changed.length !== 1)
            throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
          await this.repo.appendEvidenceInTransaction(
            tx,
            "PAYPAL_ORDER_RECOVERED",
            {
              paymentAttemptId: attemptId,
              paypalOrderId: created.id,
            },
            now,
          );
        });
        a = {
          ...a,
          provider_order_id: created.id,
          provider_status: created.status,
          status,
        };
        if (status === "PAYER_ACTION_REQUIRED") return status;
      }

      let order: PayPalOrderView;
      try {
        // Always retrieve provider state before considering a capture retry.
        order = await this.provider.getOrder(
          requiredString(a.provider_order_id, "PROVIDER_ORDER_ID"),
        );
      } catch {
        if (a.status === "CAPTURED")
          throw new Error("PAYPAL_FINALIZED_ORDER_UNVERIFIED");
        return String(a.status);
      }
      this.assertOrder(a, order, true);
      if (order.captures.length === 0) {
        // APPROVED + a fully bound single purchase unit + no captures is the
        // only automatic retry condition. COMPLETED without capture is unknown.
        if (
          order.status !== "APPROVED" ||
          order.payerActionUrl ||
          !this.retryWindow(a, now)
        )
          return String(a.status);
        if (
          ![
            "CAPTURE_UNKNOWN",
            "CAPTURE_IN_FLIGHT",
            "ORDER_CREATED",
            "PAYER_ACTION_REQUIRED",
          ].includes(String(a.status))
        )
          return String(a.status);
        try {
          order = await this.provider.captureOrder(
            requiredString(a.provider_order_id, "PROVIDER_ORDER_ID"),
            requiredString(a.capture_request_id, "CAPTURE_REQUEST_ID"),
          );
        } catch {
          await this.reconciliationState(db, a, "CAPTURE_UNKNOWN", now);
          return "CAPTURE_UNKNOWN";
        }
        this.assertOrder(a, order, false);
      }
      const cap = order.captures[0];
      if (!cap || !["COMPLETED", "PENDING"].includes(cap.status)) {
        await this.reconciliationState(db, a, "CAPTURE_UNKNOWN", now);
        return "CAPTURE_UNKNOWN";
      }
      this.assertBinding(a, cap);
      if (cap.status === "PENDING") {
        await this.reconciliationState(
          db,
          a,
          "CAPTURE_PENDING_PROVIDER",
          now,
          cap,
        );
        return "CAPTURE_PENDING_PROVIDER";
      }
      if (order.status !== "COMPLETED")
        throw new Error("PAYPAL_ORDER_STATUS_MISMATCH");
      await this.reconciliationTransaction(db, async (tx) => {
        const rows =
          await tx`select * from payment_attempts where id=${attemptId} for update`;
        if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
        const current = asRow(rows[0]);
        this.assertUnchanged(a, current);
        await this.assertAuthority(tx, current, current.status === "CAPTURED");
        this.assertOrder(current, order, false);
        this.assertBinding(current, cap);
        if (current.status === "CAPTURED") {
          if (
            current.provider_capture_id !== cap.id ||
            current.provider_capture_status !== cap.status
          )
            throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
          return;
        }
        const attempt =
          await tx`update payment_attempts set status='CAPTURED',provider_status=${order.status},provider_capture_id=${cap.id},provider_capture_status=${cap.status},captured_at=${now},last_reconciled_at=${now},updated_at=${now} where id=${attemptId} and status=${String(current.status)} returning id,status`;
        const grant =
          await tx`update execution_grants set status='CONSUMED',consumed_at=${now} where id=${String(current.grant_id)} and status='CLAIMED' returning id,status`;
        const reservation =
          await tx`update authorization_reservations set status='COMMITTED',updated_at=${now} where id=${String(current.reservation_id)} and status='EXECUTING' returning id,status`;
        if (
          attempt.length !== 1 ||
          grant.length !== 1 ||
          reservation.length !== 1 ||
          attempt[0]!.id !== attemptId ||
          attempt[0]!.status !== "CAPTURED" ||
          grant[0]!.id !== current.grant_id ||
          grant[0]!.status !== "CONSUMED" ||
          reservation[0]!.id !== current.reservation_id ||
          reservation[0]!.status !== "COMMITTED"
        )
          throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYPAL_RECONCILIATION_RESOLVED",
          {
            paymentAttemptId: attemptId,
            paypalCaptureId: cap.id,
          },
          now,
        );
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYMENT_COMMITTED",
          {
            paymentAttemptId: attemptId,
            paypalCaptureId: cap.id,
          },
          now,
        );
      });
      return "CAPTURED";
    } finally {
      try {
        if (locked)
          await db`select pg_advisory_unlock(hashtextextended(${attemptId}, 2))`;
      } finally {
        db.release();
      }
    }
  }
  private async reconciliationTransaction<T>(
    db: Sql,
    action: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    // postgres.js reserved connections expose SQL but no begin() at runtime.
    // Explicit transaction statements keep all locks and writes on that session.
    await db`begin`;
    try {
      const result = await action(db);
      await db`commit`;
      return result;
    } catch (error) {
      await db`rollback`;
      throw error;
    }
  }
  private retryWindow(a: Record<string, unknown>, now: string): boolean {
    // Conservative six-hour Orders idempotency retention, measured from the
    // original attempt, never extended by a retry or an UNKNOWN update.
    const age = Date.parse(now) - new Date(String(a.created_at)).getTime();
    return Number.isFinite(age) && age >= 0 && age < 6 * 60 * 60 * 1000;
  }
  private assertUnchanged(
    a: Record<string, unknown>,
    current: Record<string, unknown>,
  ): void {
    for (const field of [
      "id",
      "status",
      "grant_id",
      "reservation_id",
      "proposal_id",
      "mandate_id",
      "principal_id",
      "amount_minor",
      "currency",
      "merchant_reference",
      "provider",
      "operation",
      "create_order_request_id",
      "capture_request_id",
      "provider_order_id",
      "provider_capture_id",
    ]) {
      if (a[field] !== current[field])
        throw new Error("PAYMENT_ATTEMPT_CHANGED_DURING_RECONCILIATION");
    }
  }
  private async assertAuthority(
    tx: Sql,
    a: Record<string, unknown>,
    finalized = false,
  ): Promise<void> {
    const grants =
      await tx`select * from execution_grants where id=${requiredString(a.grant_id, "GRANT_ID")} for update`;
    const reservations =
      await tx`select * from authorization_reservations where id=${requiredString(a.reservation_id, "RESERVATION_ID")} for update`;
    if (!grants[0] || !reservations[0])
      throw new Error("PAYMENT_AUTHORITY_MISSING");
    const g = asRow(grants[0]),
      r = asRow(reservations[0]);
    if (g.status !== (finalized ? "CONSUMED" : "CLAIMED"))
      throw new Error("GRANT_FINALIZATION_STATE_INVALID");
    if (r.status !== (finalized ? "COMMITTED" : "EXECUTING"))
      throw new Error("RESERVATION_FINALIZATION_STATE_INVALID");
    if (
      a.provider !== "PAYPAL" ||
      a.operation !== "CAPTURE" ||
      g.id !== a.grant_id ||
      r.id !== a.reservation_id ||
      g.reservation_id !== r.id ||
      g.proposal_id !== a.proposal_id ||
      r.proposal_id !== a.proposal_id ||
      g.mandate_id !== a.mandate_id ||
      r.mandate_id !== a.mandate_id ||
      g.principal_id !== a.principal_id ||
      g.receipt_id !== r.receipt_id ||
      g.merchant_id !== a.merchant_reference ||
      Number(g.amount_minor) !== Number(a.amount_minor) ||
      Number(r.amount_minor) !== Number(a.amount_minor) ||
      g.currency !== a.currency ||
      r.currency !== a.currency
    )
      throw new Error("PAYMENT_AUTHORITY_BINDING_MISMATCH");
    paypalMoney(Number(a.amount_minor), requiredString(a.currency, "CURRENCY"));
    requiredString(a.create_order_request_id, "CREATE_REQUEST_ID");
    requiredString(a.capture_request_id, "CAPTURE_REQUEST_ID");
  }
  private assertOrder(
    a: Record<string, unknown>,
    order: PayPalOrderView,
    requireAmount: boolean,
  ): void {
    requiredString(order.id, "PROVIDER_ORDER_ID");
    const unit = order.purchaseUnits[0];
    if (
      (a.provider_order_id && order.id !== a.provider_order_id) ||
      ![
        "CREATED",
        "SAVED",
        "APPROVED",
        "PAYER_ACTION_REQUIRED",
        "COMPLETED",
      ].includes(order.status) ||
      order.purchaseUnits.length !== 1 ||
      !unit ||
      unit.referenceId !== a.proposal_id ||
      ((requireAmount ||
        unit.amountValue !== undefined ||
        unit.currency !== undefined) &&
        (unit.amountValue !==
          paypalMoney(Number(a.amount_minor), String(a.currency)) ||
          unit.currency !== a.currency)) ||
      order.captures.length > 1
    )
      throw new PayPalProviderError(
        "STATE_MISMATCH",
        "PAYPAL_ORDER_BINDING_MISMATCH",
      );
    const cap = order.captures[0];
    if (a.provider_capture_id && !cap)
      throw new PayPalProviderError(
        "STATE_MISMATCH",
        "PAYPAL_CAPTURE_ID_MISMATCH",
      );
    if (cap) {
      requiredString(cap.id, "PROVIDER_CAPTURE_ID");
      this.assertBinding(a, cap);
      if (a.provider_capture_id && a.provider_capture_id !== cap.id)
        throw new PayPalProviderError(
          "STATE_MISMATCH",
          "PAYPAL_CAPTURE_ID_MISMATCH",
        );
    }
  }
  private async reconciliationState(
    db: Sql,
    a: Record<string, unknown>,
    status: string,
    now: string,
    cap?: PayPalOrderView["captures"][number],
  ): Promise<void> {
    await this.reconciliationTransaction(db, async (tx) => {
      const rows =
        await tx`select * from payment_attempts where id=${String(a.id)} for update`;
      if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      const current = asRow(rows[0]);
      this.assertUnchanged(a, current);
      await this.assertAuthority(tx, current);
      const changed =
        await tx`update payment_attempts set status=${status},provider_capture_id=${cap?.id ?? (current.provider_capture_id ? requiredString(current.provider_capture_id, "PROVIDER_CAPTURE_ID") : null)},provider_capture_status=${cap?.status ?? (current.provider_capture_status ? requiredString(current.provider_capture_status, "PROVIDER_CAPTURE_STATUS") : null)},last_reconciled_at=${now},updated_at=${now} where id=${String(a.id)} and status=${String(current.status)} returning id`;
      if (changed.length !== 1)
        throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYPAL_RECONCILIATION_UNRESOLVED",
        { paymentAttemptId: String(a.id), status },
        now,
      );
    });
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
