/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { DEMO_MERCHANT, hostHarness } from "./helpers/host-harness.js";
import { MISSIONS, idemKey } from "./helpers/mission-fixtures.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { contractScene } from "./helpers/talent.js";
import {
  milestoneState,
  paymentDoc,
  terminationPlan,
} from "../src/missions/contractor-pay.js";
import { classify } from "../src/missions/purchase.js";

/**
 * V3 M50 — deliverables and contractor payment. A deliverable is a claim a person accepts with evidence; a payment instruction is derived
 * from it and is not a payment; the agent pays through the Gateway and PayFlow reconciles from its OWN trace, moving the milestone's
 * budget item. Termination cancels only milestones that have no payment instruction.
 */
const url = process.env.TEST_DATABASE_URL;

describe("M50 milestone state and payment description (pure)", () => {
  it("a milestone's state follows from facts, with cancelled and paid outranking everything else", () => {
    const st = (
      deliverables: ("SUBMITTED" | "ACCEPTED" | "REJECTED")[],
      paymentIssued = false,
      settled = false,
      cancelled = false,
    ) => milestoneState({ deliverables, paymentIssued, settled, cancelled });
    expect(st([])).toBe("NOT_STARTED");
    expect(st(["SUBMITTED"])).toBe("SUBMITTED");
    expect(st(["REJECTED"])).toBe("REJECTED");
    expect(st(["REJECTED", "SUBMITTED"])).toBe("SUBMITTED");
    expect(st(["REJECTED", "ACCEPTED"])).toBe("ACCEPTED");
    expect(st(["ACCEPTED"], true)).toBe("PAYMENT_ISSUED");
    expect(st(["ACCEPTED"], true, true)).toBe("PAID");
    expect(st(["ACCEPTED"], true, true, true)).toBe("CANCELLED");
    expect(st([], false, false, true)).toBe("CANCELLED");
  });

  it("termination cancels exactly the milestones without a payment instruction", () => {
    const plan = terminationPlan([
      { index: 1, paymentIssued: true },
      { index: 2, paymentIssued: false },
      { index: 3, paymentIssued: false },
    ]);
    expect(plan).toEqual({ cancel: [2, 3], keep: [1] });
    expect(terminationPlan([])).toEqual({ cancel: [], keep: [] });
  });

  it("the payment description is one line for the milestone's amount, to the payee, by the agent, under the Authority", () => {
    const doc = paymentDoc({
      currency: "USD",
      milestone: { index: 2, title: "Design system", amountMinor: 12_000 },
      contractId: "tct_1",
      paymentId: "cpy_1",
      agentId: "c",
      authorityId: "auth-1",
      category: "CONTRACTOR",
      payee: "payee.x",
      purpose: "p",
      expiresAt: "2026-11-05T10:00:00.000Z",
    });
    expect(doc).toMatchObject({
      merchant: "payee.x",
      totalMinor: 12_000,
      agentId: "c",
      authorityId: "auth-1",
      requestId: "cpy_1",
      lines: [{ quantity: 1, unitPriceMinor: 12_000 }],
    });
    // the same classifier reads it: a trace for a different amount does not match
    const trace = {
      status: "VERIFIED",
      financialOutcome: "CAPTURED",
      references: {
        mandateId: "auth-1",
        agentId: "c",
        proposalId: "p",
        receiptId: "r",
        providerCaptureId: "cap",
        providerOrderId: "o",
      },
      financial: {
        currency: "USD",
        requestedMinor: 8_400,
        committedMinor: 8_400,
      },
      commerce: {
        logicalMerchant: "payee.x",
        sku: null,
        trustedTotalMinor: 8_400,
        quantity: 1,
      },
    } as const;
    expect(classify(doc, trace).classification).toBe("MISMATCH");
    expect(classify({ ...doc, totalMinor: 8_400 }, trace).classification).toBe(
      "SETTLED",
    );
  });
});

(url ? describe : describe.skip)(
  "M50 contractor payment (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({ extraTruncate: TRUNCATE });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (res: Response) =>
      (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const submit = (
      t: string,
      cid: string,
      n: number,
      base = "/v1/admin/org",
      summary = "Done: see the repo",
    ) =>
      post(t, `${base}/contracts/${cid}/milestones/${n}/deliverables`, {
        submission: { summary, refs: ["https://example.test/pr/1"] },
        idempotencyKey: idemKey("d"),
      });
    const decide = (t: string, did: string, b: Record<string, unknown>) =>
      post(t, `/v1/admin/org/deliverables/${did}/decide`, b);
    const accept = async (
      s: { owner: string; a: string; contractId: string },
      n = 1,
    ) => {
      const did = (await body(await submit(s.a, s.contractId, n, "/v1/agent")))
        .deliverableId as string;
      const r = await decide(s.owner, did, {
        decision: "ACCEPT",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "review.md",
      });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      return did;
    };
    const pay = (
      t: string,
      did: string,
      b: Record<string, unknown> = {},
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/deliverables/${did}/payment`, {
        agentId: "c",
        payee: DEMO_MERCHANT,
        purpose: "Milestone payment",
        idempotencyKey: idemKey("p"),
        ...b,
      });
    const view = async (t: string, id: string) =>
      (await body(await get(t, `/v1/admin/org/missions/${id}/contracts`)))
        .contracts[0];

    it("a deliverable is a claim: one open at a time, only a person decides, acceptance needs evidence, and an accepted milestone takes no more", async () => {
      const s = await contractScene(h);
      expect((await submit(s.a, s.contractId, 3, "/v1/agent")).status).toBe(
        422,
      );
      const first = await submit(s.a, s.contractId, 1, "/v1/agent");
      const firstBody = await body(first);
      expect([first.status, firstBody.status]).toEqual([201, "SUBMITTED"]);
      const did = firstBody.deliverableId as string;
      const open = await submit(s.owner, s.contractId, 1);
      expect([open.status, (await body(open)).reason]).toEqual([
        409,
        "ALREADY_OPEN",
      ]);
      expect(
        (
          await post(s.a, `/v1/agent/deliverables/${did}/decide`, {
            decision: "ACCEPT",
            evidenceKind: "DOCUMENT_REF",
          })
        ).status,
      ).toBe(404); // agents have no decide route
      expect(
        (
          await decide(s.a, did, {
            decision: "ACCEPT",
            evidenceKind: "DOCUMENT_REF",
          })
        ).status,
      ).toBe(401);
      const noEv = await decide(s.owner, did, { decision: "ACCEPT" });
      expect([noEv.status, (await body(noEv)).reason]).toEqual([
        422,
        "EVIDENCE_REQUIRED",
      ]);
      expect(
        (
          await body(
            await decide(s.owner, did, {
              decision: "REJECT",
              note: "tests missing",
            }),
          )
        ).status,
      ).toBe("REJECTED");
      const again = await decide(s.owner, did, {
        decision: "ACCEPT",
        evidenceKind: "DOCUMENT_REF",
      });
      expect([again.status, (await body(again)).reason]).toEqual([
        409,
        "ALREADY_DECIDED",
      ]);
      expect(
        (await body(await decide(s.owner, did, { decision: "REJECT" })))
          .replayed,
      ).toBe(true);
      expect((await view(s.owner, s.id)).milestones[0].state).toBe("REJECTED");
      const second = (await body(await submit(s.owner, s.contractId, 1)))
        .deliverableId as string;
      expect(
        (
          await body(
            await decide(s.owner, second, {
              decision: "ACCEPT",
              evidenceKind: "OWNER_ATTESTATION",
            }),
          )
        ).status,
      ).toBe("ACCEPTED");
      const late = await submit(s.owner, s.contractId, 1);
      expect([late.status, (await body(late)).reason]).toEqual([
        409,
        "ALREADY_ACCEPTED",
      ]);
      const v = await view(s.owner, s.id);
      expect(v.milestones.map((m: { state: string }) => m.state)).toEqual([
        "ACCEPTED",
        "NOT_STARTED",
      ]);
      expect(
        v.milestones[0].deliverables.map((d: { status: string }) => d.status),
      ).toEqual(["REJECTED", "ACCEPTED"]);
      await expect(
        h.repo
          .sql`update mission_deliverables set status = 'SUBMITTED' where deliverable_id = ${did}`,
      ).rejects.toThrow(/decided deliverable cannot change/);
    });

    it("a payment instruction needs an accepted deliverable, a payee the Authority names and an agent that can purchase; once per milestone", async () => {
      const s = await contractScene(h);
      const did = (await body(await submit(s.a, s.contractId, 1, "/v1/agent")))
        .deliverableId as string;
      const early = await pay(s.owner, did);
      expect([early.status, (await body(early)).reason]).toEqual([
        409,
        "NOT_ACCEPTED",
      ]);
      await decide(s.owner, did, {
        decision: "ACCEPT",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "r.md",
      });
      const wrongPayee = await pay(s.owner, did, { payee: "somebody.else" });
      expect([wrongPayee.status, (await body(wrongPayee)).reason]).toEqual([
        422,
        "PAYEE_NOT_IN_AUTHORITY",
      ]);
      const noCap = await pay(s.owner, did, { agentId: "a" });
      expect([noCap.status, (await body(noCap)).reason]).toEqual([
        403,
        "CAPABILITY_REFUSED",
      ]);
      const ok = await pay(s.owner, did);
      expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(201);
      const p = (await body(ok)).payment;
      expect(p).toMatchObject({
        milestoneIndex: 1,
        amountMinor: 8_400,
        payee: DEMO_MERCHANT,
        agentId: "c",
        notice: expect.stringContaining("not a payment") as string,
      });
      const again = await pay(s.owner, did, { idempotencyKey: "x".repeat(16) });
      expect([again.status, (await body(again)).reason]).toEqual([
        409,
        "ALREADY_ISSUED",
      ]);
      expect((await view(s.owner, s.id)).milestones[0]).toMatchObject({
        state: "PAYMENT_ISSUED",
        budgetStage: "COMMITTED",
        paymentId: p.paymentId,
      });
      expect(h.provider.captureCalls).toBe(0); // issuing pays no one
    });

    it("the agent pays through the Gateway and PayFlow settles the milestone from its own trace, once", async () => {
      const s = await contractScene(h);
      const did = await accept(s, 1);
      const p = (await body(await pay(s.owner, did))).payment;
      const paid = await new PayFlowClient({
        baseUrl: h.origin,
        accessToken: s.c,
      }).actions.execute({
        item: "Quiet keyboard",
        amount: 8_400,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `m50-${Math.random().toString(36).slice(2)}-0123456789`,
        authority: p.authorityId,
        agent: "c",
        missionOrder: p.paymentId,
      });
      expect(paid, JSON.stringify(paid)).toMatchObject({ status: "COMPLETED" });
      const proposalId = paid.proof!.proposalId!;
      expect(
        (
          await post(
            s.b,
            `/v1/agent/contractor-payments/${p.paymentId}/reconcile`,
            { proposalId },
          )
        ).status,
      ).toBe(403);
      const r = await post(
        s.owner,
        `/v1/admin/org/contractor-payments/${p.paymentId}/reconcile`,
        { proposalId },
      );
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      expect(await body(r)).toMatchObject({
        classification: "SETTLED",
        ledgerSteps: ["RESERVED", "IN_FLIGHT", "SETTLED"],
        milestoneStage: "SETTLED",
        replayed: false,
      });
      const again = await body(
        await post(
          s.c,
          `/v1/agent/contractor-payments/${p.paymentId}/reconcile`,
          { proposalId },
        ),
      );
      expect([again.replayed, again.milestoneStage]).toEqual([true, "SETTLED"]);
      expect(
        (await view(s.owner, s.id)).milestones.map(
          (m: { state: string }) => m.state,
        ),
      ).toEqual(["PAID", "NOT_STARTED"]);
      const none = await post(
        s.owner,
        `/v1/admin/org/contractor-payments/${p.paymentId}/reconcile`,
        { proposalId: "does-not-exist-1" },
      );
      expect([none.status, (await body(none)).reason]).toEqual([
        409,
        "TRACE_UNAVAILABLE",
      ]);
      expect(h.provider.captureCalls).toBe(1);
    });

    it("a payment that differs from the instruction is refused at the Gateway before the provider; reconciliation stays a second line that holds the budget as UNKNOWN", async () => {
      const s = await contractScene(h);
      const did1 = await accept(s, 1); // 8,400
      const did2 = await accept(s, 2); // 12,000
      const p1 = (await body(await pay(s.owner, did1))).payment;
      const p2 = (await body(await pay(s.owner, did2))).payment;
      expect(p2.amountMinor).toBe(12_000);
      const exec = (amount: number, authority: string, order: string) =>
        new PayFlowClient({
          baseUrl: h.origin,
          accessToken: s.c,
        }).actions.execute({
          item: "Quiet keyboard",
          amount,
          currency: "USD",
          merchant: DEMO_MERCHANT,
          nonce: `m50-${Math.random().toString(36).slice(2)}-0123456789`,
          authority,
          agent: "c",
          missionOrder: order,
        });
      // first line: neither the instruction's amount nor the catalog's amount gets 12,000 paid through the demo rail
      expect(await exec(8_400, p2.authorityId, p2.paymentId)).toMatchObject({
        status: "DENIED",
        effectCount: 0,
        reason: "ORDER_CLAIMED_TERMS_MISMATCH",
      });
      expect(await exec(12_000, p2.authorityId, p2.paymentId)).toMatchObject({
        status: "DENIED",
        effectCount: 0,
      });
      expect(h.provider.captureCalls).toBe(0);
      // second line: a genuine payment for instruction 1 offered as the payment for instruction 2 holds instruction 2's budget
      const paid = await exec(8_400, p1.authorityId, p1.paymentId);
      expect(paid).toMatchObject({ status: "COMPLETED" });
      const r = await body(
        await post(
          s.owner,
          `/v1/admin/org/contractor-payments/${p2.paymentId}/reconcile`,
          { proposalId: paid.proof!.proposalId! },
        ),
      );
      expect(r.classification).toBe("MISMATCH");
      expect(r.problems).toContain("AMOUNT_DIFFERS");
      expect(r.milestoneStage).toBe("UNKNOWN");
    });

    it("a capture for a milestone that another payment already settled is a DUPLICATE and moves nothing", async () => {
      const s = await contractScene(h);
      const did = await accept(s, 1);
      const p = (await body(await pay(s.owner, did))).payment;
      const paid = await new PayFlowClient({
        baseUrl: h.origin,
        accessToken: s.c,
      }).actions.execute({
        item: "Quiet keyboard",
        amount: 8_400,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `m50-${Math.random().toString(36).slice(2)}-0123456789`,
        authority: p.authorityId,
        agent: "c",
        missionOrder: p.paymentId,
      });
      await h.repo
        .sql`insert into mission_contractor_payment_reconciliations (payment_id, proposal_id, classification, trace_status, financial_outcome, refs, problems, ledger_steps, actor_kind, actor_id, occurred_at)
      values (${p.paymentId}, 'earlier-payment', 'SETTLED', 'VERIFIED', 'CAPTURED', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'MEMBER', 'x', now())`;
      const r = await body(
        await post(
          s.owner,
          `/v1/admin/org/contractor-payments/${p.paymentId}/reconcile`,
          { proposalId: paid.proof!.proposalId! },
        ),
      );
      expect(r).toMatchObject({
        classification: "DUPLICATE",
        ledgerSteps: [],
        milestoneStage: "COMMITTED",
        problems: ["PAYMENT_ALREADY_SETTLED_BY_ANOTHER_PAYMENT"],
      });
    });

    it("an instruction is refused above the Authority or when the milestone's budget is no longer committed; only the instruction's agent reconciles; another agent's payment is foreign and moves nothing", async () => {
      const s = await contractScene(h);
      const did = await accept(s, 1);
      const [auth] = await h.repo.sql<
        { authority_id: string }[]
      >`select authority_id from mission_authorities where mission_id = ${s.id} and agent_id = 'c' and category = 'KEYBOARD'`;
      await h.repo
        .sql`update mandates set document = jsonb_set(document, '{maxSingleTransactionMinor}', '8399') where id = ${auth!.authority_id}`;
      const above = await pay(s.owner, did);
      expect([above.status, (await body(above)).reason]).toEqual([
        422,
        "ABOVE_AUTHORITY",
      ]);
      await h.repo
        .sql`update mandates set document = jsonb_set(document, '{maxSingleTransactionMinor}', '60000') where id = ${auth!.authority_id}`;
      // the milestone's budget item is cancelled out from under the instruction
      const items = await h.repo.sql<
        { item_id: string }[]
      >`select item_id from mission_ledger_items where mission_id = ${s.id} and amount_minor = 8400`;
      const gone = await post(
        s.owner,
        `/v1/admin/org/ledger/items/${items[0]!.item_id}/transition`,
        { to: "CANCELLED", idempotencyKey: idemKey("x") },
      );
      expect(gone.status).toBe(200);
      const notCommitted = await pay(s.owner, did);
      expect([notCommitted.status, (await body(notCommitted)).reason]).toEqual([
        409,
        "MILESTONE_NOT_COMMITTED",
      ]);
    });

    it("another agent that can purchase cannot reconcile, and its own payment is foreign to the instruction: nothing moves and its references are withheld", async () => {
      const s = await contractScene(h);
      const did = await accept(s, 1);
      const p = (await body(await pay(s.owner, did))).payment;
      // a payment under an unrelated (non-mission) Authority of the same tenant is foreign to the instruction
      const generic = await h.authority();
      const gAgent = String(
        (
          await h.repo
            .sql`select authorized_agent_id from mandates where id = ${generic}`
        )[0]!.authorized_agent_id,
      );
      const bPaid = await new PayFlowClient({
        baseUrl: h.origin,
        accessToken: await h.agentToken(gAgent),
      }).actions.execute({
        item: "Quiet keyboard",
        amount: 8_400,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `m50-${Math.random().toString(36).slice(2)}-0123456789`,
        authority: generic,
        agent: gAgent,
      });
      expect(bPaid).toMatchObject({ status: "COMPLETED" });
      const notBuyer = await post(
        s.b,
        `/v1/agent/contractor-payments/${p.paymentId}/reconcile`,
        { proposalId: bPaid.proof!.proposalId! },
      );
      expect([notBuyer.status, (await body(notBuyer)).reason]).toEqual([
        403,
        "NOT_THE_BUYER",
      ]);
      const r = await body(
        await post(
          s.owner,
          `/v1/admin/org/contractor-payments/${p.paymentId}/reconcile`,
          { proposalId: bPaid.proof!.proposalId! },
        ),
      );
      expect(r).toMatchObject({
        classification: "MISMATCH",
        ledgerSteps: [],
        milestoneStage: "COMMITTED",
      });
      expect(r.problems).toEqual(
        expect.arrayContaining(["AUTHORITY_DIFFERS", "AGENT_DIFFERS"]),
      );
      const [row] = await h.repo
        .sql`select trace_status, refs from mission_contractor_payment_reconciliations where payment_id = ${p.paymentId}`;
      expect([row!.trace_status, row!.refs]).toEqual(["WITHHELD", {}]);
    });

    it("termination cancels the milestones with no payment instruction, releases their budget, keeps the rest, and closes the contract to new work", async () => {
      const s = await contractScene(h);
      const did = await accept(s, 1);
      await pay(s.owner, did);
      const before = await body(
        await get(s.owner, `${MISSIONS}/${s.id}/ledger`),
      );
      expect(before.summary.exposureMinor).toBe(20_400);
      expect(
        (
          await post(s.c, `/v1/agent/contracts/${s.contractId}/terminate`, {
            reason: "x",
          })
        ).status,
      ).toBe(404); // agents cannot terminate
      const t = await post(
        s.owner,
        `/v1/admin/org/contracts/${s.contractId}/terminate`,
        { reason: "scope dropped" },
      );
      expect(await body(t)).toMatchObject({
        cancelledMilestones: [2],
        keptMilestones: [1],
        replayed: false,
      });
      const after = await body(
        await get(s.owner, `${MISSIONS}/${s.id}/ledger`),
      );
      expect(after.summary.exposureMinor).toBe(8_400); // milestone 2's budget is released
      expect(
        (
          await body(
            await post(
              s.owner,
              `/v1/admin/org/contracts/${s.contractId}/terminate`,
              { reason: "again" },
            ),
          )
        ).replayed,
      ).toBe(true);
      const v = await view(s.owner, s.id);
      expect([
        v.terminated,
        v.milestones.map((m: { state: string }) => m.state),
      ]).toEqual([true, ["PAYMENT_ISSUED", "CANCELLED"]]);
      const late = await submit(s.owner, s.contractId, 2);
      expect([late.status, (await body(late)).reason]).toEqual([
        409,
        "CONTRACT_TERMINATED",
      ]);
      await expect(
        h.repo.sql`delete from mission_contract_terminations`,
      ).rejects.toThrow(/append-only/);
    });
  },
);
