import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
import type { ExecutionGrantClaims, ExecutionSink } from "./execution-grant.js";
import { mandateFingerprint, proposalDigest } from "./canonical.js";
import { ExecutionQuarantinedError } from "./execution-outcome.js";
import { persistedDate, type PostgresTrustRepository } from "./persistence.js";

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
        signal: AbortSignal.timeout(15_000),
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
        signal: AbortSignal.timeout(15_000),
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

export function withinPayPalRetryWindow(
  createdAt: unknown,
  now: string,
): boolean {
  const origin =
    createdAt instanceof Date
      ? createdAt.getTime()
      : Date.parse(String(createdAt));
  const age = Date.parse(now) - origin;
  return Number.isFinite(age) && age >= 0 && age < 6 * 60 * 60 * 1000;
}

export class PayPalExecutionRail implements ExecutionSink {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly provider: PaymentProvider,
    private readonly clock = () => new Date().toISOString(),
  ) {}
  readonly finalizesAuthority = true;
  async execute(
    c: ExecutionGrantClaims,
  ): Promise<{ readonly executionId: string }> {
    const a = await this.ensureAttempt(c);
    try {
      const status = await this.reconcile(String(a.id), this.clock());
      if (status !== "CAPTURED")
        throw new ExecutionQuarantinedError(
          status === "ORDER_CREATE_UNKNOWN"
            ? "PAYPAL_ORDER_CREATE_UNKNOWN"
            : status === "CAPTURE_UNKNOWN"
              ? "PAYPAL_CAPTURE_UNKNOWN"
              : status,
        );
      const rows = await this.repo
        .sql`select provider_capture_id from payment_attempts where id=${String(a.id)}`;
      return {
        executionId: requiredString(
          rows[0]?.provider_capture_id,
          "PROVIDER_CAPTURE_ID",
        ),
      };
    } catch (error) {
      if (error instanceof ExecutionQuarantinedError) throw error;
      // Once authority is claimed, an infrastructure/validation error is not
      // evidence that the provider did not act. Never release its reservation.
      throw new ExecutionQuarantinedError("PAYMENT_REQUIRES_INVESTIGATION");
    }
  }
  async reconcile(attemptId: string, now = this.clock()): Promise<string> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_RECONCILIATION_TIME");
    const requestedAt = Date.parse(now),
      clockOrigin = Date.parse(this.clock()),
      elapsedOrigin = performance.now();
    if (!Number.isFinite(clockOrigin))
      throw new Error("INVALID_RECONCILIATION_CLOCK");
    const currentTime = () => {
      const clockNow = Date.parse(this.clock());
      if (!Number.isFinite(clockNow))
        throw new Error("INVALID_RECONCILIATION_CLOCK");
      // An entry timestamp must not remain valid across a provider wait or a
      // blocked lock. Monotonic elapsed time also protects against clock rollback.
      return new Date(
        requestedAt +
          Math.max(
            0,
            clockNow - clockOrigin,
            performance.now() - elapsedOrigin,
          ),
      ).toISOString();
    };
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
      if (["FAILED", "CANCELLED"].includes(String(a.status)))
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
          !["NOT_STARTED", "ORDER_CREATE_UNKNOWN", "ORDER_CREATING"].includes(
            String(a.status),
          )
        )
          throw new Error("PAYMENT_ATTEMPT_ORDER_MISSING");
        if (!this.retryWindow(a, now)) return String(a.status);
        await this.dispatch(db, a, "ORDER_CREATING", currentTime);
        a = { ...a, status: "ORDER_CREATING" };
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
          await this.reconciliationState(
            db,
            a,
            "ORDER_CREATE_UNKNOWN",
            currentTime(),
          );
          return "ORDER_CREATE_UNKNOWN";
        }
        try {
          this.assertOrder(a, created, true);
        } catch (error) {
          await this.reconciliationState(
            db,
            a,
            "ORDER_CREATE_UNKNOWN",
            currentTime(),
          );
          throw error;
        }
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
          const observedAt = currentTime();
          const changed =
            await tx`update payment_attempts set provider_order_id=${created.id},provider_status=${created.status},payer_action_url=${created.payerActionUrl ?? null},status=${status},last_reconciled_at=${observedAt},updated_at=${observedAt} where id=${attemptId} and status=${String(a.status)} returning id`;
          if (changed.length !== 1)
            throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
          await this.repo.appendEvidenceInTransaction(
            tx,
            "PAYPAL_ORDER_RECOVERED",
            {
              paymentAttemptId: attemptId,
              paypalOrderId: created.id,
            },
            observedAt,
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
        await this.dispatch(db, a, "CAPTURE_IN_FLIGHT", currentTime);
        a = { ...a, status: "CAPTURE_IN_FLIGHT" };
        try {
          order = await this.provider.captureOrder(
            requiredString(a.provider_order_id, "PROVIDER_ORDER_ID"),
            requiredString(a.capture_request_id, "CAPTURE_REQUEST_ID"),
          );
        } catch {
          await this.reconciliationState(
            db,
            a,
            "CAPTURE_UNKNOWN",
            currentTime(),
          );
          return "CAPTURE_UNKNOWN";
        }
        try {
          this.assertOrder(a, order, false);
        } catch (error) {
          await this.reconciliationState(
            db,
            a,
            "CAPTURE_UNKNOWN",
            currentTime(),
          );
          throw error;
        }
      }
      const cap = order.captures[0];
      if (!cap || !["COMPLETED", "PENDING"].includes(cap.status)) {
        await this.reconciliationState(db, a, "CAPTURE_UNKNOWN", currentTime());
        return "CAPTURE_UNKNOWN";
      }
      this.assertBinding(a, cap);
      if (cap.status === "PENDING") {
        await this.reconciliationState(
          db,
          a,
          "CAPTURE_PENDING_PROVIDER",
          currentTime(),
          cap,
        );
        return "CAPTURE_PENDING_PROVIDER";
      }
      if (order.status !== "COMPLETED") {
        await this.reconciliationState(db, a, "CAPTURE_UNKNOWN", currentTime());
        throw new Error("PAYPAL_ORDER_STATUS_MISMATCH");
      }
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
        const observedAt = currentTime();
        const attempt =
          await tx`update payment_attempts set status='CAPTURED',provider_status=${order.status},provider_capture_id=${cap.id},provider_capture_status=${cap.status},captured_at=${observedAt},last_reconciled_at=${observedAt},updated_at=${observedAt} where id=${attemptId} and status=${String(current.status)} returning id,status`;
        const grant =
          await tx`update execution_grants set status='CONSUMED',consumed_at=${observedAt} where id=${String(current.grant_id)} and status='CLAIMED' returning id,status`;
        const reservation =
          await tx`update authorization_reservations set status='COMMITTED',updated_at=${observedAt} where id=${String(current.reservation_id)} and status='EXECUTING' returning id,status`;
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
          observedAt,
        );
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYMENT_COMMITTED",
          {
            paymentAttemptId: attemptId,
            paypalCaptureId: cap.id,
          },
          observedAt,
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
  private async dispatch(
    db: Sql,
    a: Record<string, unknown>,
    status: string,
    currentTime: () => string,
  ): Promise<void> {
    await this.reconciliationTransaction(db, async (tx) => {
      const rows =
        await tx`select * from payment_attempts where id=${String(a.id)} for update`;
      if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      const current = asRow(rows[0]);
      this.assertUnchanged(a, current);
      await this.assertAuthority(tx, current);
      const grants =
        await tx`select * from execution_grants where id=${String(a.grant_id)}`;
      const g = asRow(grants[0]);
      const mandate = await this.repo.getMandate(
        String(a.mandate_id),
        tx,
        true,
      );
      const agent = await this.repo.getAgent(String(g.agent_id), tx);
      await this.repo.assertMandateActive(String(a.mandate_id), tx);
      const receipt = await this.repo.getReceipt(String(g.receipt_id), tx);
      const approval =
        receipt?.decision === "ESCALATE"
          ? await this.repo.getApprovalByReceipt(String(g.receipt_id), tx)
          : null;
      const reservations =
        await tx`select expires_at from authorization_reservations where id=${String(a.reservation_id)}`;
      const now = currentTime();
      if (!this.retryWindow(a, now))
        throw new Error("PAYPAL_RETRY_WINDOW_EXPIRED");
      if (
        receipt?.decision === "ESCALATE" &&
        (!approval ||
          approval.status !== "APPROVED" ||
          Date.parse(approval.approvedAt) > Date.parse(now) ||
          approval.principalId !== a.principal_id ||
          approval.proposalId !== a.proposal_id)
      )
        throw new Error("VALID_APPROVAL_REQUIRED");
      if (
        !mandate ||
        !agent ||
        agent.status !== "ACTIVE" ||
        agent.principalId !== a.principal_id ||
        Date.parse(now) < Date.parse(agent.issuedAt) ||
        Date.parse(now) >= Date.parse(agent.expiresAt) ||
        Date.parse(now) < Date.parse(mandate.createdAt) ||
        Date.parse(now) >= Date.parse(mandate.expiresAt) ||
        Date.parse(now) < persistedDate(g.issued_at).getTime() ||
        Date.parse(now) >= persistedDate(g.expires_at).getTime() ||
        Date.parse(now) >=
          persistedDate(reservations[0]?.expires_at).getTime() ||
        !agent.capabilities.includes(g.capability as never) ||
        !mandate.allowedCapabilities.includes(g.capability as never) ||
        mandateFingerprint(mandate) !== g.mandate_fingerprint
      )
        throw new Error("PAYMENT_AUTHORITY_NOT_CURRENT");
      const changed =
        await tx`update payment_attempts set status=${status},updated_at=${now} where id=${String(a.id)} and status=${String(a.status)} returning id`;
      if (changed.length !== 1)
        throw new Error("PAYMENT_DISPATCH_STATE_INVALID");
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYPAL_OPERATION_DISPATCHED",
        { paymentAttemptId: String(a.id), status },
        now,
      );
    });
  }
  async claimedGrantsWithoutAttempts(): Promise<readonly string[]> {
    const rows = await this.repo
      .sql`select g.id from execution_grants g left join payment_attempts p on p.grant_id=g.id where g.status='CLAIMED' and p.id is null order by g.claimed_at,g.id`;
    return rows.map((row) => requiredString(row.id, "GRANT_ID"));
  }
  async reconciliationCandidates(): Promise<readonly string[]> {
    const rows = await this.repo
      .sql`select id from payment_attempts where provider='PAYPAL' and status not in ('CAPTURED','FAILED','CANCELLED') order by created_at,id`;
    return rows.map((row) => requiredString(row.id, "ID"));
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
    return withinPayPalRetryWindow(a.created_at, now);
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
      "idempotency_key",
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
    const claimedAt = persistedDate(g.claimed_at).getTime();
    if (
      claimedAt < persistedDate(g.issued_at).getTime() ||
      claimedAt >= persistedDate(g.expires_at).getTime()
    )
      throw new Error("PAYMENT_AUTHORITY_CLAIM_TIME_INVALID");
    persistedDate(r.created_at);
    persistedDate(r.updated_at);
    persistedDate(a.updated_at);
    if (finalized) {
      persistedDate(g.consumed_at);
      persistedDate(a.captured_at);
      const committed =
        await tx`select id from evidence_events where type='PAYMENT_COMMITTED' and data->>'paymentAttemptId'=${String(a.id)} and data->>'paypalCaptureId'=${String(a.provider_capture_id)}`;
      if (committed.length !== 1)
        throw new Error("PAYMENT_FINALIZATION_EVIDENCE_MISSING");
    }
    for (const value of [
      g.issued_at,
      g.expires_at,
      r.expires_at,
      a.created_at,
    ]) {
      if (!Number.isFinite(persistedDate(value).getTime()))
        throw new Error("MALFORMED_PAYMENT_AUTHORITY_TIME");
    }
    if (
      ![
        "NOT_STARTED",
        "ORDER_CREATING",
        "ORDER_CREATE_UNKNOWN",
        "ORDER_CREATED",
        "PAYER_ACTION_REQUIRED",
        "CAPTURE_PENDING",
        "CAPTURE_IN_FLIGHT",
        "CAPTURE_UNKNOWN",
        "CAPTURE_PENDING_PROVIDER",
        "CAPTURED",
        "FAILED",
        "CANCELLED",
      ].includes(String(a.status))
    )
      throw new Error("MALFORMED_PAYMENT_ATTEMPT_STATUS");
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
    const mandate = await this.repo.getMandate(String(a.mandate_id), tx, true);
    const proposal = await this.repo.getProposal(
      String(a.proposal_id),
      tx,
      true,
    );
    const receipt = await this.repo.getReceipt(String(g.receipt_id), tx);
    if (
      !mandate ||
      !proposal ||
      !receipt ||
      mandate.principalId !== a.principal_id ||
      mandate.authorizedAgentId !== g.agent_id ||
      proposal.agentId !== g.agent_id ||
      proposal.mandateId !== a.mandate_id ||
      proposal.amount.minor !== Number(a.amount_minor) ||
      proposal.amount.currency !== a.currency ||
      proposal.merchant.id !== a.merchant_reference ||
      proposal.requestedCapability !== g.capability ||
      proposalDigest(proposal) !== g.proposal_digest ||
      receipt.proposalId !== a.proposal_id ||
      receipt.mandateId !== a.mandate_id ||
      receipt.agentId !== g.agent_id ||
      receipt.amount.minor !== Number(a.amount_minor) ||
      receipt.amount.currency !== a.currency ||
      receipt.mandateFingerprint !== g.mandate_fingerprint ||
      !["ALLOW", "ESCALATE"].includes(receipt.decision) ||
      !["CREATE_ORDER", "CAPTURE_PAYMENT"].includes(String(g.capability))
    )
      throw new Error("PAYMENT_AUTHORITY_BINDING_MISMATCH");
    await this.repo.assertReceiptProposal(String(g.receipt_id), proposal, tx);
    await this.repo.assertGrantSnapshot(String(g.id), tx);
    const claim =
      await tx`select id from evidence_events where type='EXECUTION_AUTHORITY_CLAIMED' and data->>'grantId'=${String(g.id)} and data->>'reservationId'=${String(r.id)}`;
    if (claim.length !== 1) throw new Error("PAYMENT_AUTHORITY_CLAIM_UNPROVEN");
    paypalMoney(Number(a.amount_minor), requiredString(a.currency, "CURRENCY"));
    if (
      a.create_order_request_id !== requestId("create", String(a.id)) ||
      a.capture_request_id !== requestId("capture", String(a.id)) ||
      a.idempotency_key !== a.create_order_request_id
    )
      throw new Error("PAYMENT_REQUEST_KEY_BINDING_MISMATCH");
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
    return this.repo.sql.begin(async (tx) => {
      const grants =
        await tx`select * from execution_grants where id=${c.jti} for update`;
      const g = grants[0];
      if (!g || !["CLAIMED", "CONSUMED"].includes(String(g.status)))
        throw new Error("PAYMENT_GRANT_NOT_CLAIMED");
      for (const [column, value] of Object.entries({
        principal_id: c.principalId,
        agent_id: c.agentId,
        mandate_id: c.mandateId,
        proposal_id: c.proposalId,
        receipt_id: c.receiptId,
        reservation_id: c.reservationId,
        proposal_digest: c.proposalDigest,
        mandate_fingerprint: c.mandateFingerprint,
        capability: c.capability,
        currency: c.currency,
        merchant_id: c.merchantId,
        kid: c.kid,
        version: c.version,
        audience: c.audience,
      })) {
        if (g[column] !== value)
          throw new Error("PAYMENT_GRANT_BINDING_MISMATCH");
      }
      if (
        Number(g.amount_minor) !== c.amountMinor ||
        persistedDate(g.issued_at).toISOString() !== c.issuedAt ||
        persistedDate(g.expires_at).toISOString() !== c.expiresAt
      )
        throw new Error("PAYMENT_GRANT_BINDING_MISMATCH");
      const existing =
        await tx`select * from payment_attempts where reservation_id=${c.reservationId}`;
      if (existing[0]) {
        const a = asRow(existing[0]);
        if (a.grant_id !== c.jti)
          throw new Error("PAYMENT_ATTEMPT_BINDING_MISMATCH");
        return a;
      }
      if (g.status !== "CLAIMED") throw new Error("PAYMENT_AUTHORITY_MISSING");
      const id = randomUUID(),
        create = requestId("create", id),
        capture = requestId("capture", id);
      const now = this.clock();
      const rows =
        await tx`insert into payment_attempts(id,reservation_id,grant_id,proposal_id,mandate_id,principal_id,provider,operation,amount_minor,currency,merchant_reference,idempotency_key,create_order_request_id,capture_request_id,status,created_at,updated_at) values(${id},${c.reservationId},${c.jti},${c.proposalId},${c.mandateId},${c.principalId},'PAYPAL','CAPTURE',${c.amountMinor},${c.currency},${c.merchantId},${create},${create},${capture},'NOT_STARTED',${now},${now}) returning *`;
      const a = asRow(rows[0]);
      await this.assertAuthority(tx, a);
      await this.repo.appendEvidenceInTransaction(
        tx,
        "PAYMENT_ATTEMPT_CREATED",
        {
          paymentAttemptId: id,
          grantId: c.jti,
          reservationId: c.reservationId,
          amountMinor: c.amountMinor,
          currency: c.currency,
        },
        now,
      );
      return a;
    });
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
