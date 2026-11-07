import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  ChannelRegistry,
  sandboxEmailChannel,
} from "../src/missions/channels.js";
import {
  evaluateAcceptance,
  type AcceptanceFacts,
} from "../src/missions/acceptance.js";
import {
  NegotiationDocSchema,
  type NegotiationDoc,
} from "../src/missions/negotiation.js";

/**
 * V3 M39 — accepting an offer and escalating. A pure checklist decides what is possible (hard checks nobody can override, soft ones a
 * person can); the integration tests prove who may accept, that the walk-away cannot be exceeded, that an agent without authority hands
 * the decision to a person, and that accepting commits the budget but tells no one and pays no one.
 */
const url = process.env.TEST_DATABASE_URL;
const rules = (over: Record<string, unknown> = {}): NegotiationDoc =>
  NegotiationDocSchema.parse({
    currency: "USD",
    targetTotalMinor: 40_000,
    walkAwayMinor: 45_000,
    terms: {
      minWarrantyMonths: 12,
      maxDeliveryDays: 10,
      acceptablePaymentTerms: [],
    },
    concessions: {},
    rounds: { maxRounds: 3 },
    negotiatorAgentId: "b",
    expiresAt: "2026-11-20T10:00:00.000Z",
    ...over,
  });
const base = (over: Partial<AcceptanceFacts> = {}): AcceptanceFacts => ({
  missionActive: true,
  quote: {
    current: true,
    complete: true,
    currency: "USD",
    totalMinor: 44_000,
    terms: { warrantyMonths: 12, deliveryDays: 10 },
  },
  missionCurrency: "USD",
  maxCommitmentMinor: 60_000,
  availableMinor: 150_000,
  supplierOutcome: "QUALIFIED",
  rules: rules(),
  negotiationExists: true,
  alreadyAccepted: false,
  negotiationConcluded: false,
  requireApprovalToContract: true,
  humanApprovalAboveMinor: 50_000,
  ...over,
});

describe("M39 acceptance checklist (pure)", () => {
  it("everything holding lets a person accept; an agent only when the rules, the mission and the total all allow it", () => {
    const person = evaluateAcceptance(base());
    expect([
      person.personMayAccept,
      person.agentMayAccept,
      person.hardFailures,
      person.softFailures,
    ]).toEqual([true, false, [], []]);
    const allowAgent = base({
      rules: rules({ acceptanceRule: "AGENT_WITHIN_LIMITS" }),
      requireApprovalToContract: false,
    });
    expect(evaluateAcceptance(allowAgent).agentMayAccept).toBe(true);
    // each condition for the agent, broken one at a time
    expect(
      evaluateAcceptance({ ...allowAgent, requireApprovalToContract: true })
        .agentMayAccept,
    ).toBe(false);
    expect(
      evaluateAcceptance({ ...allowAgent, humanApprovalAboveMinor: undefined })
        .agentMayAccept,
    ).toBe(false);
    expect(
      evaluateAcceptance({ ...allowAgent, humanApprovalAboveMinor: 43_999 })
        .agentMayAccept,
    ).toBe(false);
    expect(
      evaluateAcceptance({ ...allowAgent, humanApprovalAboveMinor: 44_000 })
        .agentMayAccept,
    ).toBe(true); // exactly at the threshold
    expect(
      evaluateAcceptance({ ...allowAgent, rules: rules() }).agentMayAccept,
    ).toBe(false);
    expect(
      evaluateAcceptance({
        ...allowAgent,
        rules: null,
        negotiationExists: false,
      }).agentMayAccept,
    ).toBe(false); // no rules, no agent authority
    expect(
      evaluateAcceptance({
        ...allowAgent,
        quote: { ...allowAgent.quote, terms: {} },
      }).agentMayAccept,
    ).toBe(false); // a missed floor is a person's call
  });

  it("each hard check has its own code, the walk-away is hard, and a missed term floor is soft", () => {
    const codes = (f: AcceptanceFacts) => evaluateAcceptance(f).hardFailures;
    expect(codes(base({ missionActive: false }))).toEqual(["MISSION_ACTIVE"]);
    expect(codes(base({ alreadyAccepted: true }))).toEqual([
      "NOT_ALREADY_ACCEPTED",
    ]);
    expect(codes(base({ negotiationConcluded: true }))).toEqual([
      "NOT_ALREADY_ACCEPTED",
    ]);
    expect(codes(base({ quote: { ...base().quote, current: false } }))).toEqual(
      ["QUOTE_CURRENT"],
    );
    expect(
      codes(
        base({ quote: { ...base().quote, complete: false, totalMinor: null } }),
      ),
    ).toEqual(["QUOTE_COMPLETE"]);
    expect(
      codes(base({ quote: { ...base().quote, currency: "EUR" } })),
    ).toEqual(["CURRENCY_MATCH"]);
    expect(codes(base({ supplierOutcome: "INCOMPLETE" }))).toEqual([
      "SUPPLIER_QUALIFIED",
    ]);
    expect(codes(base({ maxCommitmentMinor: 43_999 }))).toEqual([
      "WITHIN_LARGEST_COMMITMENT",
    ]);
    expect(codes(base({ availableMinor: 43_999 }))).toEqual([
      "WITHIN_AVAILABLE_BUDGET",
    ]);
    expect(codes(base({ availableMinor: null }))).toEqual([]);
    expect(codes(base({ rules: null }))).toEqual(["RULES_IN_FORCE"]);
    expect(
      codes(base({ quote: { ...base().quote, totalMinor: 45_001 } })),
    ).toEqual(["WITHIN_WALK_AWAY"]);
    expect(
      codes(base({ quote: { ...base().quote, totalMinor: 45_000 } })),
    ).toEqual([]);
    const soft = evaluateAcceptance(
      base({
        quote: {
          ...base().quote,
          terms: { warrantyMonths: 6, deliveryDays: 10 },
        },
      }),
    );
    expect([
      soft.personMayAccept,
      soft.softFailures,
      soft.hardFailures,
    ]).toEqual([true, ["TERMS_MEET_FLOORS"], []]);
    // no negotiation: only the contract-level checks apply
    expect(
      evaluateAcceptance(base({ rules: null, negotiationExists: false }))
        .personMayAccept,
    ).toBe(true);
  });

  it("property: a person may accept exactly when no hard check fails, and an agent only if a person could and nothing soft failed", () => {
    let seed = 8;
    // Higher bits: the low bits of this generator cycle quickly.
    const rnd = (n: number) =>
      ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n;
    let agentOk = 0;
    for (let i = 0; i < 1500; i++) {
      const rule =
        rnd(4) === 0
          ? null
          : rules({
              acceptanceRule: rnd(2) ? "AGENT_WITHIN_LIMITS" : "PERSON_ALWAYS",
              walkAwayMinor: 40_000 + rnd(10_000),
              targetTotalMinor: 30_000 + rnd(9_000),
            });
      const wild = base({
        missionActive: rnd(10) !== 0,
        rules: rule,
        negotiationExists: rule !== null || rnd(2) === 0,
        quote: {
          current: rnd(8) !== 0,
          complete: rnd(8) !== 0,
          currency: rnd(10) === 0 ? "EUR" : "USD",
          totalMinor: rnd(8) === 0 ? null : 38_000 + rnd(12_000),
          terms: {
            ...(rnd(5) ? { warrantyMonths: 6 + rnd(10) } : {}),
            ...(rnd(5) ? { deliveryDays: 5 + rnd(10) } : {}),
          },
        },
        supplierOutcome: (
          [
            "QUALIFIED",
            "QUALIFIED",
            "QUALIFIED",
            "INCOMPLETE",
            "NOT_QUALIFIED",
          ] as const
        )[rnd(5)]!,
        availableMinor: rnd(6) === 0 ? 40_000 : 100_000,
        requireApprovalToContract: rnd(2) === 0,
        humanApprovalAboveMinor:
          rnd(3) === 0 ? undefined : 40_000 + rnd(12_000),
        alreadyAccepted: rnd(15) === 0,
        negotiationConcluded: rnd(15) === 0,
      });
      // A third of the cases start from "everything an agent needs" and break at most one thing, so the agent branch is really exercised.
      const friendly = base({
        rules: rules({
          acceptanceRule: "AGENT_WITHIN_LIMITS",
          walkAwayMinor: 50_000,
        }),
        requireApprovalToContract: false,
        humanApprovalAboveMinor: 50_000,
        quote: {
          current: true,
          complete: true,
          currency: "USD",
          totalMinor: 38_000 + rnd(12_000),
          terms: { warrantyMonths: 12 + rnd(3), deliveryDays: 3 + rnd(7) },
        },
      });
      const broken: AcceptanceFacts[] = [
        { ...friendly, missionActive: false },
        { ...friendly, supplierOutcome: "INCOMPLETE" },
        {
          ...friendly,
          quote: { ...friendly.quote, terms: { deliveryDays: 5 } },
        },
        { ...friendly, requireApprovalToContract: true },
        { ...friendly, humanApprovalAboveMinor: 37_000 },
        { ...friendly, availableMinor: 30_000 },
      ];
      const f =
        rnd(3) !== 0
          ? wild
          : rnd(4) === 0
            ? broken[rnd(broken.length)]!
            : friendly;
      const ev = evaluateAcceptance(f);
      // an independent statement of the hard rules
      const t = f.quote.totalMinor;
      const hardOk =
        f.missionActive &&
        !f.alreadyAccepted &&
        !f.negotiationConcluded &&
        f.quote.current &&
        f.quote.complete &&
        t !== null &&
        f.quote.currency === f.missionCurrency &&
        f.supplierOutcome === "QUALIFIED" &&
        t <= f.maxCommitmentMinor &&
        (f.availableMinor === null || t <= f.availableMinor) &&
        (!f.negotiationExists ||
          (f.rules !== null && t <= f.rules.walkAwayMinor));
      expect(ev.personMayAccept, JSON.stringify(f)).toBe(hardOk);
      if (ev.agentMayAccept) {
        agentOk++;
        expect(ev.personMayAccept).toBe(true);
        expect(ev.softFailures).toEqual([]);
        expect(f.rules?.acceptanceRule).toBe("AGENT_WITHIN_LIMITS");
        expect(f.requireApprovalToContract).toBe(false);
        expect(t! <= f.humanApprovalAboveMinor!).toBe(true);
      }
    }
    expect(agentOk).toBeGreaterThan(10);
  });
});

(url ? describe : describe.skip)(
  "M39 acceptance (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events,mission_acceptances,mission_escalations",
      channels: () => new ChannelRegistry().register(sandboxEmailChannel),
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const st = (minor: number) => ({ basis: "STATED", minor });
    /** `agentMayAccept`: the mission lets an agent contract within limits (and the rules say so). */
    const scene = async (agentMayAccept = false) => {
      const m = await activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: { mode: "ONLY", ids: ["s1"] },
          maxCommitmentMinor: 60_000,
          totalBudgetMinor: 150_000,
          expiresAt: "2026-11-23T10:00:00.000Z",
          approvalConditions: {
            humanApprovalAboveMinor: 46_000,
            requireApprovalToNegotiate: true,
            requireApprovalToContract: !agentMayAccept,
          },
          agents: [
            {
              agentId: "a",
              capabilities: [
                "READ",
                "DRAFT",
                "COMMUNICATE",
                "COMPARE",
                "NEGOTIATE",
              ],
            },
            {
              agentId: "b",
              capabilities: [
                "READ",
                "DRAFT",
                "NEGOTIATE",
                "COMPARE",
                "CONTRACT",
              ],
            },
            { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
          ],
        }),
      );
      const sid = (
        (await (
          await post(m.owner, `/v1/admin/org/missions/${m.id}/suppliers`, {
            externalRef: "s1",
            displayName: "Acme Parts",
          })
        ).json()) as { supplierId: string }
      ).supplierId;
      const f = (
        criterion: string,
        evidenceKind: string,
        evidenceRef?: string,
      ) =>
        post(m.owner, `/v1/admin/org/suppliers/${sid}/facts`, {
          criterion,
          status: "VERIFIED",
          evidenceKind,
          ...(evidenceRef ? { evidenceRef } : {}),
          idempotencyKey: idemKey("f"),
        });
      await f("IDENTITY", "OWNER_ATTESTATION");
      await f("PAYMENT_ACCEPTED", "OWNER_ATTESTATION");
      await f("RETURN_POLICY", "DOCUMENT_REF", "returns.pdf");
      const cid = (
        (await (
          await post(m.owner, `/v1/admin/org/suppliers/${sid}/contacts`, {
            address: "sales@acme.example",
            basis: "site footer",
          })
        ).json()) as { contactId: string }
      ).contactId;
      const doc = {
        currency: "USD",
        targetTotalMinor: 40_000,
        walkAwayMinor: 45_000,
        terms: { minWarrantyMonths: 12, acceptablePaymentTerms: [] },
        concessions: {},
        rounds: { maxRounds: 3 },
        negotiatorAgentId: "b",
        acceptanceRule: agentMayAccept
          ? "AGENT_WITHIN_LIMITS"
          : "PERSON_ALWAYS",
        expiresAt: "2026-11-20T10:00:00.000Z",
      };
      const n = (await (
        await post(m.b, `/v1/agent/missions/${m.id}/negotiations`, {
          supplierId: sid,
          idempotencyKey: idemKey("n"),
          document: doc,
        })
      ).json()) as { negotiationId: string };
      expect(
        (
          await post(
            m.owner,
            `/v1/admin/org/negotiations/${n.negotiationId}/versions/1/approve`,
            {},
          )
        ).status,
      ).toBe(200);
      return { ...m, sid, cid, nid: n.negotiationId };
    };
    type S = Awaited<ReturnType<typeof scene>>;
    const quote = async (
      s: S,
      total: number,
      over: {
        terms?: Record<string, number>;
        currency?: string;
        shipping?: unknown;
        supersedes?: string;
        validUntil?: string;
      } = {},
    ) => {
      const r = await post(s.owner, `/v1/admin/org/missions/${s.id}/quotes`, {
        supplierId: s.sid,
        currency: over.currency ?? "USD",
        validUntil: over.validUntil ?? "2026-11-10T10:00:00.000Z",
        document: {
          lines: [
            {
              description: "Parts",
              sku: "KB",
              quantity: 1,
              unitPrice: st(total),
            },
          ],
          shipping: over.shipping ?? st(0),
          tax: st(0),
          duties: st(0),
          fees: st(0),
          discount: st(0),
          terms: over.terms ?? { warrantyMonths: 12, deliveryDays: 10 },
        },
        source: { kind: "SUPPLIER_STATED", ref: "email" },
        ...(over.supersedes ? { supersedes: over.supersedes } : {}),
        idempotencyKey: idemKey("q"),
      });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      return ((await r.json()) as { quote: { quoteId: string } }).quote.quoteId;
    };
    const accept = (
      t: string,
      qid: string,
      b: Record<string, unknown> = {},
      base = "/v1/admin/org/quotes",
    ) =>
      post(t, `${base}/${qid}/accept`, { idempotencyKey: idemKey("a"), ...b });
    const reason = async (r: Response) =>
      (await r.json()) as {
        reason: string;
        detail?: string;
        outcome?: string;
        acceptance?: {
          acceptanceId: string;
          basis: string;
          status: string;
          ledgerItemId: string;
          overrideReason: string | null;
          notice: string;
        };
        escalation?: { escalationId: string; status: string; kind: string };
        replayed?: boolean;
      };
    const ledger = async (t: string, id: string) =>
      (await (await get(t, `${MISSIONS}/${id}/ledger`)).json()) as {
        summary: { exposureMinor: number };
        items: { itemId: string; stage: string }[];
      };
    const lists = async (t: string, id: string) =>
      (await (
        await get(t, `/v1/admin/org/missions/${id}/acceptances`)
      ).json()) as {
        acceptances: { acceptanceId: string; status: string }[];
        escalations: {
          escalationId: string;
          status: string;
          snapshot: { hardFailures: string[]; softFailures: string[] };
        }[];
      };

    it("a person accepts: the budget is committed, the negotiation concludes, no one is told and no one is paid; only the owner may", async () => {
      const s = await scene();
      const q = await quote(s, 44_000);
      const check = (await (
        await get(s.b, `/v1/agent/quotes/${q}/acceptance-check`)
      ).json()) as {
        personMayAccept: boolean;
        agentMayAccept: boolean;
        evaluation: { checks: { code: string; ok: boolean }[] };
      };
      expect([check.personMayAccept, check.agentMayAccept]).toEqual([
        true,
        false,
      ]);
      expect(check.evaluation.checks.every((c) => c.ok)).toBe(true);
      const fin = await h.member("FINANCE_ADMIN");
      const dev = await h.member("DEVELOPER");
      for (const who of [fin, dev])
        expect((await accept(who, q)).status).toBe(403);
      expect((await accept(s.a, q)).status).toBe(401); // wrong route for an agent credential
      const key = idemKey("same");
      const r = await accept(s.owner, q, { idempotencyKey: key });
      expect(r.status).toBe(201);
      const a = await reason(r);
      expect([a.outcome, a.acceptance!.basis, a.acceptance!.status]).toEqual([
        "ACCEPTED",
        "PERSON",
        "ACCEPTED",
      ]);
      expect(a.acceptance!.notice).toContain(
        "did not tell the supplier and did not pay",
      );
      const led = await ledger(s.owner, s.id);
      expect(led.summary.exposureMinor).toBe(44_000);
      expect(
        led.items.find((i) => i.itemId === a.acceptance!.ledgerItemId)!.stage,
      ).toBe("APPROVED");
      // nothing was sent and no payment path was touched
      expect(
        (await h.repo.sql`select count(*)::int as n from mission_messages`)[0]!
          .n,
      ).toBe(0);
      // replay returns the same acceptance; a second key for the same quote is refused
      const again = await reason(
        await accept(s.owner, q, { idempotencyKey: key }),
      );
      expect([again.replayed, again.acceptance!.acceptanceId]).toEqual([
        true,
        a.acceptance!.acceptanceId,
      ]);
      const second = await accept(s.owner, q);
      expect([second.status, (await reason(second)).detail]).toEqual([
        422,
        "NOT_ALREADY_ACCEPTED",
      ]);
      // the negotiation has concluded: it takes no more counters
      const counter = await post(s.b, `/v1/agent/missions/${s.id}/messages`, {
        supplierId: s.sid,
        contactId: s.cid,
        kind: "NEGOTIATION",
        negotiationId: s.nid,
        subject: "More",
        body: "One more offer.",
        idempotencyKey: idemKey("m"),
        move: {
          kind: "COUNTER",
          round: 1,
          currency: "USD",
          totalMinor: 41_000,
          terms: { warrantyMonths: 12 },
          quantityIncreasePercent: 0,
          disclosing: [],
        },
      });
      expect([counter.status, (await reason(counter)).detail]).toEqual([
        422,
        "NEGOTIATION_CONCLUDED",
      ]);
      await expect(
        h.repo
          .sql`update mission_acceptances set total_minor = 1 where acceptance_id = ${a.acceptance!.acceptanceId}`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`delete from mission_acceptances where acceptance_id = ${a.acceptance!.acceptanceId}`,
      ).rejects.toThrow();
      const stranger = await h.ownerOf("org-other");
      expect((await accept(stranger, q)).status).toBe(404);
      expect(
        (await get(stranger, `/v1/admin/org/missions/${s.id}/acceptances`))
          .status,
      ).toBe(404);
    });

    it("the walk-away cannot be exceeded by anyone; a missed term floor needs a reason from a person", async () => {
      const s = await scene();
      const over = await quote(s, 45_001);
      for (const body of [{}, { overrideReason: "we really want it" }]) {
        const r = await accept(s.owner, over, body);
        expect([r.status, (await reason(r)).detail]).toEqual([
          422,
          "WITHIN_WALK_AWAY",
        ]);
      }
      const at = await quote(s, 45_000);
      expect((await accept(s.owner, at)).status).toBe(201);
      const s2 = await scene();
      const weak = await quote(s2, 44_000, {
        terms: { warrantyMonths: 6, deliveryDays: 10 },
      });
      const need = await accept(s2.owner, weak);
      expect([
        need.status,
        (await reason(need)).reason,
        (await reason(await accept(s2.owner, weak))).detail,
      ]).toEqual([422, "OVERRIDE_REQUIRED", "TERMS_MEET_FLOORS"]);
      const ok = await reason(
        await accept(s2.owner, weak, {
          overrideReason: "Warranty is covered by the manufacturer",
        }),
      );
      expect([ok.outcome, ok.acceptance!.overrideReason]).toEqual([
        "ACCEPTED",
        "Warranty is covered by the manufacturer",
      ]);
    });

    it("anything that is not true of the world refuses acceptance: expired or replaced, incomplete, other currency, unqualified, no budget, a stopped mission", async () => {
      const s = await scene();
      const detail = async (qid: string) =>
        (await reason(await accept(s.owner, qid))).detail;
      const old = await quote(s, 44_000);
      await quote(s, 43_000, { supersedes: old });
      expect(await detail(old)).toBe("QUOTE_CURRENT");
      expect(
        await detail(
          await quote(s, 44_000, { shipping: { basis: "UNKNOWN" } }),
        ),
      ).toBe("QUOTE_COMPLETE");
      expect(await detail(await quote(s, 44_000, { currency: "EUR" }))).toBe(
        "CURRENCY_MATCH",
      );
      // the budget: 150,000 - 120,000 = 30,000 < 44,000
      for (const amount of [60_000, 60_000]) {
        const c = (await (
          await post(s.owner, `${MISSIONS}/${s.id}/ledger/items`, {
            kind: "GOODS",
            label: "held",
            amountMinor: amount,
            currency: "USD",
            stage: "QUOTED",
            idempotencyKey: idemKey("i"),
          })
        ).json()) as { item: { itemId: string } };
        await post(
          s.owner,
          `/v1/admin/org/ledger/items/${c.item.itemId}/transition`,
          { to: "APPROVED", idempotencyKey: idemKey("t") },
        );
      }
      expect(await detail(await quote(s, 44_500))).toBe(
        "WITHIN_AVAILABLE_BUDGET",
      );
      // the supplier loses its standing
      await post(s.owner, `/v1/admin/org/suppliers/${s.sid}/facts`, {
        criterion: "IDENTITY",
        status: "FAILED",
        idempotencyKey: idemKey("f"),
      });
      expect(await detail(await quote(s, 44_100))).toContain(
        "SUPPLIER_QUALIFIED",
      );
      // a stopped mission
      const p = await scene();
      const pq = await quote(p, 44_000);
      await post(p.owner, `${MISSIONS}/${p.id}/pause`, { reason: "t" });
      expect((await reason(await accept(p.owner, pq))).detail).toContain(
        "MISSION_ACTIVE",
      );
    });

    it("an agent without authority hands the decision to a person: it escalates, once, and the person decides", async () => {
      const s = await scene(); // rules say PERSON_ALWAYS
      const q = await quote(s, 44_000);
      const asks = await accept(s.b, q, {}, "/v1/agent/quotes");
      const e = await reason(asks);
      expect([
        asks.status,
        e.outcome,
        e.escalation!.kind,
        e.escalation!.status,
      ]).toEqual([201, "ESCALATED", "ACCEPTANCE_REQUEST", "OPEN"]);
      expect((await ledger(s.owner, s.id)).summary.exposureMinor).toBe(0); // nothing committed
      const again = await reason(await accept(s.b, q, {}, "/v1/agent/quotes"));
      expect([
        again.outcome,
        again.escalation!.escalationId,
        again.replayed,
      ]).toEqual(["ESCALATED", e.escalation!.escalationId, true]); // one request waiting
      expect((await accept(s.c, q, {}, "/v1/agent/quotes")).status).toBe(403); // no CONTRACT grant
      const l = await lists(s.owner, s.id);
      expect(l.escalations).toHaveLength(1);
      expect(l.escalations[0]!.snapshot.hardFailures).toEqual([]);
      // only the owner resolves it
      const resolve = (t: string, body: unknown) =>
        post(
          t,
          `/v1/admin/org/escalations/${e.escalation!.escalationId}/resolve`,
          body,
        );
      expect(
        (await resolve(await h.member("FINANCE_ADMIN"), { decision: "ACCEPT" }))
          .status,
      ).toBe(403);
      const done = await reason(
        await resolve(s.owner, { decision: "ACCEPT", note: "Reviewed" }),
      );
      expect(done).toMatchObject({ status: "ACCEPTED" });
      expect(
        (done as unknown as { acceptance: { basis: string } }).acceptance.basis,
      ).toBe("PERSON");
      expect((await ledger(s.owner, s.id)).summary.exposureMinor).toBe(44_000);
      expect((await resolve(s.owner, { decision: "DECLINE" })).status).toBe(
        409,
      ); // already resolved
      // declining leaves everything as it was
      const s2 = await scene();
      const q2 = await quote(s2, 44_000);
      const e2 = await reason(await accept(s2.b, q2, {}, "/v1/agent/quotes"));
      const declined = await post(
        s2.owner,
        `/v1/admin/org/escalations/${e2.escalation!.escalationId}/resolve`,
        { decision: "DECLINE", note: "Wait for a better offer" },
      );
      expect(((await declined.json()) as { status: string }).status).toBe(
        "DECLINED",
      );
      expect((await ledger(s2.owner, s2.id)).summary.exposureMinor).toBe(0);
      await expect(
        h.repo
          .sql`update mission_escalations set reason = 'x' where escalation_id = ${e2.escalation!.escalationId}`,
      ).rejects.toThrow();
    });

    it("an agent accepts alone only when the mission, the approved rules and the total all allow it; a missed floor still goes to a person", async () => {
      const s = await scene(true);
      const q = await quote(s, 44_000);
      const r = await reason(await accept(s.b, q, {}, "/v1/agent/quotes"));
      expect([r.outcome, r.acceptance!.basis]).toEqual([
        "ACCEPTED",
        "AGENT_WITHIN_LIMITS",
      ]);
      expect((await ledger(s.owner, s.id)).summary.exposureMinor).toBe(44_000);
      const [row] = await h.repo
        .sql`select accepted_by_kind, accepted_by, override_reason from mission_acceptances where quote_id = ${q}`;
      expect([
        row!.accepted_by_kind,
        row!.accepted_by,
        row!.override_reason,
      ]).toEqual(["AGENT", "b", null]);
      // a weak quote (warranty below the floor) is the person's call even though the agent may otherwise accept
      const s2 = await scene(true);
      const weak = await quote(s2, 44_000, {
        terms: { warrantyMonths: 6, deliveryDays: 10 },
      });
      const e = await reason(await accept(s2.b, weak, {}, "/v1/agent/quotes"));
      expect(e.outcome).toBe("ESCALATED");
      expect((await ledger(s2.owner, s2.id)).summary.exposureMinor).toBe(0);
      // an agent that is not the named negotiator does not accept on its own authority either (a also lacks CONTRACT)
      expect((await accept(s2.a, weak, {}, "/v1/agent/quotes")).status).toBe(
        403,
      );
      // a quote over the walk-away is refused outright, not escalated
      const big = await quote(s2, 46_000);
      const refused = await accept(s2.b, big, {}, "/v1/agent/quotes");
      expect([refused.status, (await reason(refused)).detail]).toEqual([
        422,
        "WITHIN_WALK_AWAY",
      ]);
    });

    it("a person can withdraw an acceptance before anything is built on it: the budget is released and the negotiation reopens, but the quote is never accepted twice", async () => {
      const s = await scene();
      const q = await quote(s, 44_000);
      const a = (await reason(await accept(s.owner, q))).acceptance!;
      const withdraw = (t: string) =>
        post(t, `/v1/admin/org/acceptances/${a.acceptanceId}/withdraw`, {
          reason: "Supplier changed the terms",
        });
      expect((await withdraw(await h.member("FINANCE_ADMIN"))).status).toBe(
        403,
      );
      expect(
        (
          await post(
            s.owner,
            `/v1/admin/org/acceptances/${a.acceptanceId}/withdraw`,
            {},
          )
        ).status,
      ).toBe(400); // a reason is required
      const w = (await (await withdraw(s.owner)).json()) as {
        status: string;
        replayed: boolean;
      };
      expect([w.status, w.replayed]).toEqual(["WITHDRAWN", false]);
      expect(
        ((await (await withdraw(s.owner)).json()) as { replayed: boolean })
          .replayed,
      ).toBe(true);
      const led = await ledger(s.owner, s.id);
      expect(led.summary.exposureMinor).toBe(0);
      expect(led.items.find((i) => i.itemId === a.ledgerItemId)!.stage).toBe(
        "CANCELLED",
      );
      // the same quote cannot be accepted again; a different one can, because the negotiation is open again
      const again = await accept(s.owner, q);
      expect([again.status, (await reason(again)).detail]).toEqual([
        422,
        "NOT_ALREADY_ACCEPTED",
      ]);
      const q2 = await quote(s, 43_000);
      expect((await accept(s.owner, q2)).status).toBe(201);
      expect((await ledger(s.owner, s.id)).summary.exposureMinor).toBe(43_000);
    });

    it("a request to walk away is a person's decision: agreeing ends the negotiation, declining keeps it", async () => {
      const s = await scene();
      const raise = (key = idemKey("w")) =>
        post(s.b, `/v1/agent/missions/${s.id}/escalations`, {
          kind: "WALK_AWAY_REQUEST",
          negotiationId: s.nid,
          reason: "The supplier will not move above the walk-away",
          idempotencyKey: key,
        });
      const first = await reason(await raise());
      expect(first.escalation!.kind).toBe("WALK_AWAY_REQUEST");
      const dup = await reason(await raise());
      expect([dup.escalation!.escalationId, dup.replayed]).toEqual([
        first.escalation!.escalationId,
        true,
      ]);
      expect(
        (
          await post(s.c, `/v1/agent/missions/${s.id}/escalations`, {
            kind: "WALK_AWAY_REQUEST",
            negotiationId: s.nid,
            reason: "x",
            idempotencyKey: idemKey("w"),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(s.b, `/v1/agent/missions/${s.id}/escalations`, {
            kind: "ACCEPTANCE_REQUEST",
            reason: "x",
            idempotencyKey: idemKey("w"),
          })
        ).status,
      ).toBe(400); // an acceptance request needs a quote
      const res = await post(
        s.owner,
        `/v1/admin/org/escalations/${first.escalation!.escalationId}/resolve`,
        { decision: "ACCEPT", note: "Agreed, we walk away" },
      );
      expect(res.status).toBe(200);
      const views = (await (
        await get(s.owner, `/v1/admin/org/missions/${s.id}/negotiations`)
      ).json()) as { negotiations: { status: string }[] };
      expect(views.negotiations[0]!.status).toBe("REVOKED");
    });
  },
);
