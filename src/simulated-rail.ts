import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { PayPalOrderView, PaymentProvider } from "./paypal.js";

/**
 * SIMULATED payment rail for the public developer sandbox. It implements the same PaymentProvider
 * contract the PayPal rail uses, so the Trust Kernel, Reservation, one-time grant, Execution
 * Boundary, reconciliation and Proof are the real ones. Only the provider is simulated: no money,
 * no PayPal. Every order id starts with `SIM-`, which labels Proof and responses as simulated.
 *
 * Deterministic and idempotent by request id: a repeated create or capture returns the same order
 * and never a second one. It never fabricates an ambiguous outcome unless told to by a test.
 */
export const SIMULATED_ORDER_PREFIX = "SIM-";

const orderIdFor = (requestId: string): string =>
  SIMULATED_ORDER_PREFIX +
  createHash("sha256")
    .update("sim-order:" + requestId)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();

export class SimulatedPaymentProvider implements PaymentProvider {
  constructor(private readonly sql: Sql) {}

  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    const commerce = input.commerce;
    if (!commerce) throw new Error("SIMULATED_RAIL_REQUIRES_COMMERCE_TERMS");
    const id = orderIdFor(input.requestId);
    const view: PayPalOrderView = {
      id,
      // The sandbox models a pre-approved delegated instrument: orders are born APPROVED.
      status: "APPROVED",
      purchaseUnits: [
        {
          referenceId: input.merchantReference,
          amountValue: input.amountValue,
          currency: input.currency,
          payeeMerchantId: commerce.payee.merchant_id,
          customId: commerce.custom_id,
          items: commerce.items,
          breakdown: commerce.breakdown,
        },
      ],
      captures: [],
    };
    await this.sql`
      insert into simulated_provider_orders (order_id, create_request_id, view)
      values (${id}, ${input.requestId}, ${this.sql.json(view as never)})
      on conflict (create_request_id) do nothing`;
    return this.read(id);
  }

  async getOrder(orderId: string): Promise<PayPalOrderView> {
    return this.read(orderId);
  }

  async captureOrder(
    orderId: string,
    requestId: string,
  ): Promise<PayPalOrderView> {
    const current = await this.read(orderId);
    if (current.captures.length > 0) return current; // idempotent: never a second capture
    const unit = current.purchaseUnits[0]!;
    const captured: PayPalOrderView = {
      id: current.id,
      status: "COMPLETED",
      purchaseUnits: current.purchaseUnits,
      captures: [
        {
          id: "SIMCAP-" + orderId.slice(SIMULATED_ORDER_PREFIX.length),
          status: "COMPLETED",
          amountValue: unit.amountValue!,
          currency: unit.currency!,
          orderId: current.id,
        },
      ],
    };
    await this.sql`
      update simulated_provider_orders
      set view = ${this.sql.json(captured as never)}, capture_request_id = coalesce(capture_request_id, ${requestId})
      where order_id = ${orderId} and capture_request_id is null`;
    return this.read(orderId);
  }

  private async read(orderId: string): Promise<PayPalOrderView> {
    const rows = await this
      .sql`select view from simulated_provider_orders where order_id = ${orderId}`;
    if (!rows[0]) throw new Error("SIMULATED_ORDER_NOT_FOUND");
    return rows[0].view as PayPalOrderView;
  }
}

/** True when a provider order id belongs to the simulated rail. */
export const isSimulatedOrder = (providerOrderId: unknown): boolean =>
  typeof providerOrderId === "string" &&
  providerOrderId.startsWith(SIMULATED_ORDER_PREFIX);
