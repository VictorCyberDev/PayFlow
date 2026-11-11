/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";

/**
 * Journey A — founder procurement, end to end, driven the way a customer actually drives it.
 *
 * The milestone tests for M26-M50 each authenticate with an operator-minted bearer token
 * (`hostHarness.ownerOf()`), which no customer ever has. This journey uses only what a person who
 * signed up on the website holds: a session cookie and a CSRF token, plus the agent credential the
 * app itself issued them. It crosses M26 (mission contract), M27 (plan), M33 (supplier
 * qualification), M34 (quotes and landed cost), M39 (acceptance), M40 (procurement and purchase
 * order), the Gateway execution path, M41 reconciliation and Proof.
 *
 * Account -> Mission -> Plan -> Supplier -> Quote -> Approval -> Purchase -> Reconciliation -> Proof.
 */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "journey-a-customer-password";
const MERCHANT = "payflow.demo.merchant";
const st = (minor: number) => ({ basis: "STATED" as const, minor });

(url ? describe : describe.skip)(
  "Journey A: founder procurement as a real customer (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts," +
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities," +
        "mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps," +
        "mission_task_events,mandates,mission_suppliers,mission_supplier_facts," +
        "mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_acceptances," +
        "mission_escalations,mission_purchase_orders,mission_purchase_reconciliations",
    });
    let n = 0;
    const idem = (p: string) =>
      `${p}-journey-a-key-${String(++n).padStart(10, "0")}`;
    type Customer = { cookie: string; csrf: string; organizationId: string };

    /** Signs someone up on the website and signs them in. Nothing operator-minted is used. */
    const customer = async (): Promise<Customer> => {
      h.advance(61_000);
      const email = `journey-a-${++n}@example.com`;
      const up = await fetch(h.origin + "/v1/app/signup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({
          email,
          password: PASSWORD,
          displayName: "Fay",
          organizationName: "Fay Studio",
        }),
      });
      expect(up.status, await up.clone().text()).toBe(201);
      const li = await fetch(h.origin + "/v1/app/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(li.status).toBe(200);
      const cookie = li.headers.get("set-cookie")!.split(";")[0]!;
      const me: any = await (
        await fetch(h.origin + "/v1/app/me", {
          headers: { cookie, origin: h.origin },
        })
      ).json();
      return {
        cookie,
        csrf: me.csrfToken,
        organizationId: me.member.organizationId,
      };
    };
    const as = (
      c: Customer,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          origin: h.origin,
          cookie: c.cookie,
          "x-pf-csrf": c.csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ok = async (r: Response, expected: number) => {
      expect(r.status, await r.clone().text()).toBe(expected);
      return (await r.json()) as any;
    };
    /** The agent pays with its own credential, over the wire shape the SDK sends. */
    const pay = (
      token: string,
      body: Record<string, unknown>,
    ): Promise<Response> =>
      fetch(h.origin + "/v1/actions/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

    /** Everything up to and including an issued purchase order. */
    const uptoOrder = async () => {
      const c = await customer();
      // The person enrols the agent their mission will use, and issues it a credential.
      const { agentId } = await ok(
        await as(c, "POST", "/v1/app/agents", { displayName: "Buyer" }),
        201,
      );
      const { token: agentToken } = await ok(
        await as(c, "POST", `/v1/app/agents/${agentId}/credentials`, {}),
        201,
      );
      const created = await ok(
        await as(c, "POST", "/v1/admin/org/missions", {
          contract: {
            objective: "Equip the studio",
            intendedOutcome: "Delivered within budget",
            successCriteria: ["quotes compared"],
            currency: "USD",
            totalBudgetMinor: 150_000,
            maxCommitmentMinor: 60_000,
            spendingCategories: ["KEYBOARD"],
            approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
            merchantRestrictions: { mode: "ONLY", ids: [MERCHANT] },
            agents: [
              {
                agentId,
                capabilities: [
                  "PURCHASE",
                  "REQUEST_APPROVAL",
                  "READ",
                  "COMPARE",
                ],
              },
            ],
            approvalConditions: { humanApprovalAboveMinor: 30_000 },
            expiresAt: "2026-11-23T10:00:00.000Z",
          },
          idempotencyKey: idem("m"),
        }),
        201,
      );
      const mid = created.mission.missionId as string;
      expect(created.mission.status).toBe("DRAFT");
      const approved = await ok(
        await as(c, "POST", `/v1/admin/org/missions/${mid}/approve`, {
          version: 1,
        }),
        200,
      );
      expect(approved.mission.status).toBe("ACTIVE");

      const plan = await ok(
        await as(c, "POST", `/v1/admin/org/missions/${mid}/plans`, {
          source: "TEMPLATE",
          idempotencyKey: idem("p"),
        }),
        201,
      );
      expect(plan.plan.status).toBe("ACTIVE");

      const { supplierId } = await ok(
        await as(c, "POST", `/v1/admin/org/missions/${mid}/suppliers`, {
          externalRef: MERCHANT,
          displayName: "Demo Merchant",
        }),
        201,
      );
      for (const [criterion, evidenceKind, ref] of [
        ["IDENTITY", "OWNER_ATTESTATION"],
        ["PAYMENT_ACCEPTED", "OWNER_ATTESTATION"],
        ["RETURN_POLICY", "DOCUMENT_REF", "returns.pdf"],
      ] as const)
        await ok(
          await as(c, "POST", `/v1/admin/org/suppliers/${supplierId}/facts`, {
            criterion,
            status: "VERIFIED",
            evidenceKind,
            ...(ref ? { evidenceRef: ref } : {}),
            idempotencyKey: idem("f"),
          }),
          201,
        );

      const quote = await ok(
        await as(c, "POST", `/v1/admin/org/missions/${mid}/quotes`, {
          supplierId,
          currency: "USD",
          validUntil: "2026-11-10T10:00:00.000Z",
          document: {
            lines: [
              {
                sku: "PF-KB-QUIET-BROWN-BLACK",
                description: "Keyboard",
                quantity: 1,
                unitPrice: st(8400),
              },
            ],
            shipping: st(0),
            tax: st(0),
            duties: st(0),
            fees: st(0),
            discount: st(0),
            terms: {},
          },
          source: { kind: "SUPPLIER_STATED", ref: "email" },
          idempotencyKey: idem("q"),
        }),
        201,
      );
      const compared = await ok(
        await as(c, "POST", `/v1/admin/org/missions/${mid}/quotes/compare`, {}),
        200,
      );
      // The comparison is derived from the quote, not invented: it ranks the one that exists.
      expect(compared.ranked.map((r: any) => r.quoteId)).toContain(
        quote.quote.quoteId,
      );

      const accepted = await ok(
        await as(
          c,
          "POST",
          `/v1/admin/org/quotes/${quote.quote.quoteId}/accept`,
          { idempotencyKey: idem("a") },
        ),
        201,
      );
      expect(accepted.outcome).toBe("ACCEPTED");
      expect(accepted.acceptance.totalMinor).toBe(8400);

      const po = await ok(
        await as(
          c,
          "POST",
          `/v1/admin/org/acceptances/${accepted.acceptance.acceptanceId}/purchase-order`,
          {
            agentId,
            category: "KEYBOARD",
            purpose: "Studio keyboard",
            idempotencyKey: idem("po"),
          },
        ),
        201,
      );
      // The order is bound to the agent, the merchant, the total and a compiled mission Authority.
      expect(po.order).toMatchObject({
        agentId,
        merchant: MERCHANT,
        totalMinor: 8400,
      });
      expect(po.order.authorityId).toMatch(/^mission-authority-/u);
      return { c, mid, agentId, agentToken, order: po.order };
    };

    const purchase = (
      s: Awaited<ReturnType<typeof uptoOrder>>,
      over: Record<string, unknown> = {},
    ) => ({
      authority: s.order.authorityId,
      agentId: s.agentId,
      action: "purchase",
      query: { text: "Keyboard", quantity: 1 },
      amount: { minor: 8400, currency: "USD" },
      merchant: { id: MERCHANT },
      nonce: `ja-${Math.random().toString(36).slice(2)}-0123456789`,
      ...over,
      missionOrder: s.order.poId,
    });

    it("a customer reaches a captured purchase: the money moves once, reconciles, and Proof verifies", async () => {
      const s = await uptoOrder();
      const paid = await ok(await pay(s.agentToken, purchase(s)), 200);
      expect(paid).toMatchObject({
        status: "COMPLETED",
        effectCount: 1,
        rail: "PAYPAL_SANDBOX",
      });
      const proposalId = paid.proof.proposalId as string;

      // Reconciled from PayFlow's own trace, by the person, through the app.
      const rec = await ok(
        await as(
          s.c,
          "POST",
          `/v1/admin/org/purchase-orders/${s.order.poId}/reconcile`,
          { proposalId },
        ),
        200,
      );
      expect(rec.reconciliation).toMatchObject({ seq: 1, proposalId });

      // Proof verifies, and says money was actually captured.
      const proof = await ok(
        await fetch(h.origin + `/v1/proofs/${proposalId}`, {
          headers: { authorization: `Bearer ${s.agentToken}` },
        }),
        200,
      );
      expect(proof.proof).toMatchObject({
        status: "VERIFIED",
        financialOutcome: "CAPTURED",
      });

      // The budget records the settled commitment and nothing more.
      const ledger = await ok(
        await as(s.c, "GET", `/v1/admin/org/missions/${s.mid}/ledger`),
        200,
      );
      expect(ledger.summary).toMatchObject({
        currency: "USD",
        ceilingMinor: 150_000,
        exposureMinor: 8400,
        availableMinor: 141_600,
      });
    });

    it("a replay of the same purchase never pays twice", async () => {
      const s = await uptoOrder();
      const once = purchase(s);
      expect((await ok(await pay(s.agentToken, once), 200)).status).toBe(
        "COMPLETED",
      );
      const again = await ok(await pay(s.agentToken, once), 200);
      expect(again).toMatchObject({
        reason: "REPLAY_DETECTED",
        effectCount: 0,
      });
      const [{ n: captures }] = (await h.repo
        .sql`select count(*)::int n from transaction_proposals`) as any;
      expect(captures).toBe(1);
    });

    it("a purchase above the mission's own commitment limit is refused, and nothing is written", async () => {
      const s = await uptoOrder();
      const before = (
        (await h.repo
          .sql`select count(*)::int n from authorization_reservations`) as any
      )[0].n;
      const over = await ok(
        await pay(
          s.agentToken,
          purchase(s, { amount: { minor: 90_000, currency: "USD" } }),
        ),
        200,
      );
      expect(over.status).not.toBe("COMPLETED");
      expect(over.effectCount).toBe(0);
      const after = (
        (await h.repo
          .sql`select count(*)::int n from authorization_reservations`) as any
      )[0].n;
      expect(after).toBe(before);
    });

    it("another customer's organization cannot see or spend against this mission", async () => {
      const s = await uptoOrder();
      const stranger = await customer();
      // The mission is invisible across tenants...
      const seen = await as(
        stranger,
        "GET",
        `/v1/admin/org/missions/${s.mid}/ledger`,
      );
      expect([403, 404]).toContain(seen.status);
      // ...and so is issuing an order against its acceptance.
      const theirOrder = await as(
        stranger,
        "POST",
        `/v1/admin/org/purchase-orders/${s.order.poId}/reconcile`,
        { proposalId: "whatever-0000000000000000" },
      );
      expect([403, 404]).toContain(theirOrder.status);
    });
  },
);
