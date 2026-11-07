import { PayFlowClient } from "../../packages/sdk-typescript/src/index.js";
import { DEMO_MERCHANT, type Harness } from "./host-harness.js";
import { activeMission, contract, idemKey } from "./mission-fixtures.js";

/** Shared setup for M41+: an active mission, a qualified supplier, an accepted quote and a purchase order, optionally paid and reconciled. */
export const TRUNCATE =
  "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events,mission_acceptances,mission_escalations,mission_purchase_orders,mission_purchase_reconciliations,mission_orders,mission_order_events";

export async function settledPurchase(
  h: Harness,
  opts: { pay?: boolean; total?: number } = {},
) {
  const total = opts.total ?? 8_400;
  const post = (t: string, p: string, b: unknown = {}) =>
    h.call(t, "POST", p, b);
  const m = await activeMission(
    h,
    contract({
      spendingCategories: ["KEYBOARD"],
      approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      merchantRestrictions: { mode: "ONLY", ids: [DEMO_MERCHANT] },
      maxCommitmentMinor: 60_000,
      totalBudgetMinor: 150_000,
      agents: [
        { agentId: "a", capabilities: ["READ", "COMPARE"] },
        {
          agentId: "b",
          capabilities: ["READ", "NEGOTIATE", "CONTRACT", "PURCHASE"],
        },
        { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
      ],
    }),
  );
  const sid = (
    (await (
      await post(m.owner, `/v1/admin/org/missions/${m.id}/suppliers`, {
        externalRef: DEMO_MERCHANT,
        displayName: "Demo Merchant",
      })
    ).json()) as { supplierId: string }
  ).supplierId;
  for (const [criterion, evidenceKind, ref] of [
    ["IDENTITY", "OWNER_ATTESTATION", undefined],
    ["PAYMENT_ACCEPTED", "OWNER_ATTESTATION", undefined],
    ["RETURN_POLICY", "DOCUMENT_REF", "returns.pdf"],
  ] as const)
    await post(m.owner, `/v1/admin/org/suppliers/${sid}/facts`, {
      criterion,
      status: "VERIFIED",
      evidenceKind,
      ...(ref ? { evidenceRef: ref } : {}),
      idempotencyKey: idemKey("f"),
    });
  const q = await post(m.owner, `/v1/admin/org/missions/${m.id}/quotes`, {
    supplierId: sid,
    currency: "USD",
    validUntil: "2026-11-10T10:00:00.000Z",
    document: {
      lines: [
        {
          description: "Keyboard",
          quantity: 1,
          unitPrice: { basis: "STATED", minor: total },
        },
      ],
      shipping: { basis: "STATED", minor: 0 },
      tax: { basis: "STATED", minor: 0 },
      duties: { basis: "STATED", minor: 0 },
      fees: { basis: "STATED", minor: 0 },
      discount: { basis: "STATED", minor: 0 },
      terms: {},
    },
    source: { kind: "SUPPLIER_STATED", ref: "email" },
    idempotencyKey: idemKey("q"),
  });
  const qid = ((await q.json()) as { quote: { quoteId: string } }).quote
    .quoteId;
  const acc = (
    (await (
      await post(m.owner, `/v1/admin/org/quotes/${qid}/accept`, {
        idempotencyKey: idemKey("a"),
      })
    ).json()) as { acceptance: { acceptanceId: string } }
  ).acceptance;
  const po = (
    (await (
      await post(
        m.owner,
        `/v1/admin/org/acceptances/${acc.acceptanceId}/purchase-order`,
        {
          agentId: "c",
          category: "KEYBOARD",
          purpose: "Studio keyboard",
          idempotencyKey: idemKey("po"),
        },
      )
    ).json()) as { order: { poId: string; authorityId: string } }
  ).order;
  let proposalId: string | null = null;
  if (opts.pay ?? true) {
    const paid = await new PayFlowClient({
      baseUrl: h.origin,
      accessToken: m.c,
    }).actions.execute({
      item: "Quiet keyboard",
      amount: total,
      currency: "USD",
      merchant: DEMO_MERCHANT,
      nonce: `m41-${Math.random().toString(36).slice(2)}-0123456789`,
      authority: po.authorityId,
      agent: "c",
    });
    proposalId = paid.proof!.proposalId!;
    await post(m.owner, `/v1/admin/org/purchase-orders/${po.poId}/reconcile`, {
      proposalId,
    });
  }
  return { ...m, sid, poId: po.poId, proposalId };
}
