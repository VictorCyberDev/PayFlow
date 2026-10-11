import type { CheckoutManifest } from "./checkout-contracts.js";
import type { PayPalOrderView } from "./paypal.js";
import { paypalMoney, PayPalProviderError } from "./paypal.js";

export interface PayPalCommerceItem {
  readonly name: string;
  readonly description: string;
  readonly sku: string;
  readonly quantity: string;
  readonly unit_amount: {
    readonly currency_code: string;
    readonly value: string;
  };
  readonly category: "PHYSICAL_GOODS";
}
export interface PayPalCommerceRequest {
  readonly payee: { readonly merchant_id: string };
  readonly custom_id: string;
  readonly items: readonly PayPalCommerceItem[];
  readonly breakdown: Readonly<
    Record<string, { currency_code: string; value: string }>
  >;
}
function zeroMoney(n: number, currency: string): string {
  return n === 0
    ? currency === "JPY"
      ? "0"
      : "0.00"
    : paypalMoney(n, currency);
}
export function paypalCommerceRequest(
  m: CheckoutManifest,
): PayPalCommerceRequest {
  if (m.customerFeeMinor !== 0)
    throw new Error("COMMERCE_PROVIDER_RESPONSE_INVALID");
  const money = (n: number) => ({
    currency_code: m.currency,
    value: zeroMoney(n, m.currency),
  });
  return {
    payee: { merchant_id: m.expectedPayPalMerchantId },
    custom_id: m.manifestId,
    items: [
      {
        name: m.sku,
        description: `${m.condition};${m.variant.switchType};${m.variant.finish};${m.variant.layout}`,
        sku: m.sku,
        quantity: String(m.quantity),
        unit_amount: money(m.unitAmountMinor),
        category: "PHYSICAL_GOODS",
      },
    ],
    breakdown: {
      item_total: money(m.subtotalMinor),
      tax_total: money(m.taxMinor),
      shipping: money(m.shippingMinor),
      discount: money(m.customerDiscountMinor),
    },
  };
}
export function verifyPayPalCommerce(
  m: CheckoutManifest,
  order: PayPalOrderView,
  capture = false,
): void {
  const fail = (reason: string): never => {
    throw new PayPalProviderError("STATE_MISMATCH", reason);
  };
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(order.id) ||
    order.purchaseUnits.length !== 1
  )
    fail("COMMERCE_PROVIDER_RESPONSE_INVALID");
  const u = order.purchaseUnits[0]!;
  if (u.amountValue !== paypalMoney(m.totalMinor, m.currency))
    fail("COMMERCE_AMOUNT_MISMATCH");
  if (u.currency !== m.currency) fail("COMMERCE_CURRENCY_MISMATCH");
  if (!u.payeeMerchantId) fail("COMMERCE_RECIPIENT_UNAVAILABLE");
  if (u.payeeMerchantId !== m.expectedPayPalMerchantId)
    fail("COMMERCE_RECIPIENT_MISMATCH");
  if (u.customId !== m.manifestId || u.items?.length !== 1)
    fail("COMMERCE_ITEM_MISMATCH");
  const item = u.items![0]!;
  const expected = paypalCommerceRequest(m).items[0]!;
  if (item.quantity !== String(m.quantity)) fail("COMMERCE_QUANTITY_MISMATCH");
  if (
    item.sku !== m.sku ||
    item.name !== expected.name ||
    item.description !== expected.description ||
    item.category !== "PHYSICAL_GOODS"
  )
    fail("COMMERCE_ITEM_MISMATCH");
  if (item.unit_amount.value !== expected.unit_amount.value)
    fail("COMMERCE_AMOUNT_MISMATCH");
  if (item.unit_amount.currency_code !== m.currency)
    fail("COMMERCE_CURRENCY_MISMATCH");
  const breakdown = u.breakdown;
  if (!breakdown) fail("COMMERCE_PROVIDER_RESPONSE_INVALID");
  const components = paypalCommerceRequest(m).breakdown;
  for (const [key, value] of Object.entries(components)) {
    const actual = breakdown![key];
    // Providers may omit zero components; nonzero authorized components must exist.
    if (!actual && Number(value.value) === 0) continue;
    if (
      !actual ||
      actual.value !== value.value ||
      actual.currency_code !== value.currency_code
    )
      fail("COMMERCE_AMOUNT_MISMATCH");
  }
  for (const [key, value] of Object.entries(breakdown!)) {
    if (
      !(key in components) &&
      (Number(value.value) !== 0 || value.currency_code !== m.currency)
    )
      fail("COMMERCE_AMOUNT_MISMATCH");
  }
  if (capture) {
    if (order.captures.length !== 1) fail("COMMERCE_PROVIDER_RESPONSE_INVALID");
    const c = order.captures[0]!;
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) ||
      !["COMPLETED", "PENDING"].includes(c.status)
    )
      fail("COMMERCE_PROVIDER_RESPONSE_INVALID");
    if (c.amountValue !== paypalMoney(m.totalMinor, m.currency))
      fail("COMMERCE_AMOUNT_MISMATCH");
    if (c.currency !== m.currency) fail("COMMERCE_CURRENCY_MISMATCH");
    if (c.orderId !== undefined && c.orderId !== order.id)
      fail("COMMERCE_PROVIDER_RESPONSE_INVALID");
  }
}
