from pathlib import Path
p=Path('src/paypal.ts')
s=p.read_text()
start=s.index('  async reconcile(')
end=s.index('  private async ensureAttempt(', start)
new=r'''  async reconcile(
    attemptId: string,
    now = new Date().toISOString(),
  ): Promise<string> {
    let rows = await this.repo.sql`select * from payment_attempts where id=${attemptId}`;
    if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
    let a = asRow(rows[0]);

    if (!a.provider_order_id) {
      if (a.status !== "ORDER_CREATE_UNKNOWN") return String(a.status);
      await this.repo.appendEvidence("PAYPAL_RECONCILIATION_STARTED", { paymentAttemptId: attemptId, phase: "ORDER_CREATE_UNKNOWN" }, now);
      let recovered: PayPalOrderView;
      try {
        recovered = await this.provider.createOrder({
          amountValue: paypalMoney(Number(a.amount_minor), String(a.currency)),
          currency: requiredString(a.currency, "CURRENCY"),
          merchantReference: requiredString(a.proposal_id, "PROPOSAL_ID"),
          requestId: requiredString(a.create_order_request_id, "CREATE_ORDER_REQUEST_ID"),
        });
      } catch (e) {
        if (e instanceof PayPalProviderError && e.classification === "AMBIGUOUS") return "ORDER_CREATE_UNKNOWN";
        throw e;
      }
      await this.repo.sql`update payment_attempts set provider_order_id=${recovered.id},provider_status=${recovered.status},status='ORDER_CREATED',payer_action_url=${recovered.payerActionUrl ?? null},last_reconciled_at=${now},updated_at=${now} where id=${attemptId} and status='ORDER_CREATE_UNKNOWN' and provider_order_id is null`;
      if (recovered.payerActionUrl || !["APPROVED", "COMPLETED"].includes(recovered.status)) {
        await this.state(attemptId, "PAYER_ACTION_REQUIRED", "PAYPAL_PAYER_ACTION_REQUIRED");
        return "PAYER_ACTION_REQUIRED";
      }
      rows = await this.repo.sql`select * from payment_attempts where id=${attemptId}`;
      if (!rows[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      a = asRow(rows[0]);
    }

    const orderId = requiredString(a.provider_order_id, "PROVIDER_ORDER_ID");
    await this.repo.appendEvidence("PAYPAL_RECONCILIATION_STARTED", { paymentAttemptId: attemptId, paypalOrderId: orderId }, now);
    let order: PayPalOrderView;
    try { order = await this.provider.getOrder(orderId); }
    catch { return a.status === "ORDER_CREATED" ? "ORDER_CREATED" : "CAPTURE_UNKNOWN"; }
    if (order.id !== orderId) throw new PayPalProviderError("STATE_MISMATCH", "PAYPAL_ORDER_BINDING_MISMATCH");
    let cap = order.captures[0];
    if (!cap && a.status === "CAPTURE_UNKNOWN") {
      if (!["APPROVED", "COMPLETED"].includes(order.status)) return "CAPTURE_UNKNOWN";
      try {
        order = await this.provider.captureOrder(orderId, requiredString(a.capture_request_id, "CAPTURE_REQUEST_ID"));
        if (order.id !== orderId) throw new PayPalProviderError("STATE_MISMATCH", "PAYPAL_ORDER_BINDING_MISMATCH");
        cap = order.captures[0];
      } catch (e) {
        if (e instanceof PayPalProviderError && e.classification === "AMBIGUOUS") return "CAPTURE_UNKNOWN";
        throw e;
      }
    }
    if (!cap) return String(a.status);
    this.assertBinding(a, cap);
    if (cap.status !== "COMPLETED") {
      await this.repo.sql`update payment_attempts set status='CAPTURE_PENDING_PROVIDER',provider_capture_id=${cap.id},provider_capture_status=${cap.status},last_reconciled_at=${now},updated_at=${now} where id=${attemptId}`;
      return "CAPTURE_PENDING_PROVIDER";
    }
    await this.finalizeReconciledCapture(attemptId, orderId, cap, now);
    return "CAPTURED";
  }

  private async finalizeReconciledCapture(attemptId: string, orderId: string, cap: PayPalOrderView["captures"][number], now: string): Promise<void> {
    await this.repo.sql.begin(async (tx) => {
      const attempts = await tx`select * from payment_attempts where id=${attemptId} for update`;
      if (!attempts[0]) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
      const a = asRow(attempts[0]);
      if (requiredString(a.provider_order_id, "PROVIDER_ORDER_ID") !== orderId) throw new Error("PAYMENT_ATTEMPT_ORDER_BINDING_MISMATCH");
      this.assertBinding(a, cap);
      const grants = await tx`select * from execution_grants where id=${String(a.grant_id)} for update`;
      const reservations = await tx`select * from authorization_reservations where id=${String(a.reservation_id)} for update`;
      if (!grants[0] || !reservations[0]) throw new Error("PAYMENT_AUTHORITY_NOT_FOUND");
      const grant = asRow(grants[0]);
      const reservation = asRow(reservations[0]);
      if (grant.status === "CONSUMED" && reservation.status === "COMMITTED" && a.status === "CAPTURED") return;
      if (grant.status !== "CLAIMED") throw new Error("RECONCILIATION_GRANT_NOT_CLAIMED");
      if (reservation.status !== "EXECUTING") throw new Error("RECONCILIATION_RESERVATION_NOT_EXECUTING");
      if (grant.reservation_id !== a.reservation_id || grant.proposal_id !== a.proposal_id || grant.mandate_id !== a.mandate_id || grant.principal_id !== a.principal_id) throw new Error("RECONCILIATION_GRANT_BINDING_MISMATCH");
      if (reservation.proposal_id !== a.proposal_id || reservation.mandate_id !== a.mandate_id || Number(reservation.amount_minor) !== Number(a.amount_minor) || reservation.currency !== a.currency) throw new Error("RECONCILIATION_RESERVATION_BINDING_MISMATCH");
      const attemptUpdated = await tx`update payment_attempts set status='CAPTURED',provider_capture_id=${cap.id},provider_capture_status=${cap.status},captured_at=${now},last_reconciled_at=${now},updated_at=${now} where id=${attemptId} and provider_order_id=${orderId} and status in ('CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER','CAPTURE_IN_FLIGHT','ORDER_CREATED') returning id`;
      const grantUpdated = await tx`update execution_grants set status='CONSUMED',consumed_at=${now} where id=${String(a.grant_id)} and status='CLAIMED' returning id`;
      const reservationUpdated = await tx`update authorization_reservations set status='COMMITTED',updated_at=${now} where id=${String(a.reservation_id)} and status='EXECUTING' returning id`;
      if (attemptUpdated.length !== 1 || grantUpdated.length !== 1 || reservationUpdated.length !== 1) throw new Error("RECONCILIATION_FINALIZATION_TRANSITION_FAILED");
      await this.repo.appendEvidenceInTransaction(tx, "PAYPAL_RECONCILIATION_RESOLVED", { paymentAttemptId: attemptId, paypalOrderId: orderId, paypalCaptureId: cap.id }, now);
      await this.repo.appendEvidenceInTransaction(tx, "PAYMENT_COMMITTED", { paymentAttemptId: attemptId, paypalOrderId: orderId, paypalCaptureId: cap.id }, now);
    });
  }
'''
p.write_text(s[:start]+new+s[end:])
