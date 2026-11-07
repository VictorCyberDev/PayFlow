import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
} from "./helpers/mission-fixtures.js";
import {
  ChannelRegistry,
  sandboxEmailChannel,
} from "../src/missions/channels.js";
import {
  nextCounterTotal,
  recommend,
  termsShortfalls,
  type OurCounter,
  type TheirOffer,
} from "../src/missions/counteroffers.js";
import {
  NegotiationDocSchema,
  type NegotiationDoc,
} from "../src/missions/negotiation.js";

/**
 * V3 M38 — counteroffers. Rounds are counted by PayFlow and offers never go backwards; the recommender is checked as a pure function
 * (scenarios, a concession simulation and a 1,000-case property check), then end to end: whatever it recommends, drafting exactly
 * that passes the rules, and the timeline follows the supplier's replies.
 */
const url = process.env.TEST_DATABASE_URL;
const doc = (over: Record<string, unknown> = {}): NegotiationDoc =>
  NegotiationDocSchema.parse({
    currency: "USD",
    targetTotalMinor: 40_000,
    walkAwayMinor: 50_000,
    terms: {
      minWarrantyMonths: 12,
      minReturnWindowDays: 14,
      maxDeliveryDays: 10,
      acceptablePaymentTerms: [],
    },
    concessions: { maxQuantityIncreasePercent: 0, mayExtendDeliveryDays: 0 },
    rounds: { maxRounds: 3 },
    negotiatorAgentId: "b",
    expiresAt: "2026-11-20T10:00:00.000Z",
    ...over,
  });
const T0 = "2026-10-23T09:00:00.000Z";
const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();
const ours = (
  round: number,
  totalMinor: number,
  minute: number,
  status: OurCounter["status"] = "SENT",
): OurCounter => ({
  messageId: `msg_${round}`,
  round,
  totalMinor,
  status,
  at: at(minute),
  seq: minute,
});
const theirs = (
  id: string,
  totalMinor: number | null,
  minute: number,
  over: Partial<TheirOffer> = {},
): TheirOffer => ({
  quoteId: `qte_${id}`,
  totalMinor,
  complete: totalMinor !== null,
  current: true,
  currency: "USD",
  terms: { warrantyMonths: 12, returnWindowDays: 14, deliveryDays: 10 },
  at: at(minute),
  seq: minute,
  ...over,
});

describe("M38 concession schedule and recommendation (pure)", () => {
  it("opens at the target, then meets the supplier part-way, never above the walk-away and never back down", () => {
    const d = doc();
    expect(nextCounterTotal(d, null, 70_000)).toBe(40_000);
    expect(
      nextCounterTotal(
        doc({ targetTotalMinor: 50_000, walkAwayMinor: 50_000 }),
        null,
        70_000,
      ),
    ).toBe(50_000);
    expect(nextCounterTotal(d, 40_000, 48_000)).toBe(44_000);
    expect(nextCounterTotal(d, 44_000, 48_000)).toBe(46_000);
    expect(nextCounterTotal(d, 46_000, 47)).toBe(46_000); // they are already below: never lower our offer
    expect(nextCounterTotal(d, 49_999, 90_000)).toBe(50_000); // capped at the walk-away
    expect(nextCounterTotal(d, 50_000, 90_000)).toBe(50_000);
    expect(nextCounterTotal(d, 40_000, 40_001)).toBe(40_001); // at least one minor unit of movement
    // simulation: against an offer that never moves, our offers rise strictly until the walk-away and then stop
    let prev: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      const next = nextCounterTotal(d, prev, 60_000);
      if (prev !== null) expect(next).toBeGreaterThanOrEqual(prev);
      seen.push(next);
      if (next === prev) break;
      prev = next;
    }
    expect(seen.at(-1)).toBe(50_000);
    expect(seen.length).toBeLessThan(15);
  });

  it("terms shortfalls: silence is a shortfall, the delivery allowance applies", () => {
    const d = doc({
      concessions: { maxQuantityIncreasePercent: 0, mayExtendDeliveryDays: 2 },
    });
    expect(
      termsShortfalls(d, {
        warrantyMonths: 12,
        returnWindowDays: 14,
        deliveryDays: 12,
      }),
    ).toEqual([]);
    expect(
      termsShortfalls(d, {
        warrantyMonths: 12,
        returnWindowDays: 14,
        deliveryDays: 13,
      }),
    ).toEqual(["DELIVERY_TOO_LATE"]);
    expect(termsShortfalls(d, {})).toEqual([
      "WARRANTY_BELOW_FLOOR",
      "RETURN_WINDOW_BELOW_FLOOR",
      "DELIVERY_TOO_LATE",
    ]);
    expect(
      termsShortfalls(doc({ terms: { acceptablePaymentTerms: [] } }), {}),
    ).toEqual([]);
  });

  it("recommendations follow the conversation", () => {
    const d = doc();
    const rec = (o: OurCounter[], t: TheirOffer[], dd = d) =>
      recommend({ doc: dd, ours: o, theirs: t });
    expect(rec([], []).action).toBe("NEED_BASELINE");
    expect(rec([], [theirs("a", null, 1)]).action).toBe("NEED_BASELINE"); // incomplete
    expect(rec([], [theirs("a", 60_000, 1, { current: false })]).action).toBe(
      "NEED_BASELINE",
    ); // expired or replaced
    expect(rec([], [theirs("a", 60_000, 1, { currency: "EUR" })]).action).toBe(
      "NEED_BASELINE",
    ); // no conversion
    expect(rec([], [theirs("a", 60_000, 1)])).toMatchObject({
      action: "COUNTER",
      round: 1,
      totalMinor: 40_000,
      gapMinor: 20_000,
      asks: { warrantyMonths: 12, returnWindowDays: 14, deliveryDays: 10 },
    });
    expect(rec([ours(1, 40_000, 5)], [theirs("a", 60_000, 1)]).action).toBe(
      "WAIT",
    );
    expect(
      rec(
        [ours(1, 40_000, 5)],
        [theirs("a", 60_000, 1), theirs("b", 48_000, 9)],
      ),
    ).toMatchObject({ action: "COUNTER", round: 2, totalMinor: 44_000 });
    // acceptable: within the walk-away and floors and target, or no higher than what we already offered
    expect(rec([], [theirs("a", 39_000, 1)])).toMatchObject({
      action: "REVIEW_FOR_ACCEPTANCE",
      termsShortfalls: [],
    });
    expect(
      rec(
        [],
        [
          theirs("a", 39_000, 1, {
            terms: {
              warrantyMonths: 6,
              returnWindowDays: 14,
              deliveryDays: 10,
            },
          }),
        ],
      ),
    ).toMatchObject({ action: "COUNTER" }); // price fine, a floor missed: keep asking
    expect(
      rec(
        [ours(1, 44_000, 5)],
        [theirs("a", 60_000, 1), theirs("b", 43_500, 9, { terms: {} })],
      ),
    ).toMatchObject({
      action: "REVIEW_FOR_ACCEPTANCE",
      theirTotalMinor: 43_500,
    });
    // no rounds left
    const used = [ours(1, 40_000, 5), ours(2, 44_000, 15), ours(3, 47_000, 25)];
    expect(
      rec(used, [theirs("a", 60_000, 1), theirs("b", 55_000, 30)]),
    ).toMatchObject({ action: "WALK_AWAY", theirTotalMinor: 55_000 });
    expect(
      rec(used, [theirs("a", 60_000, 1), theirs("b", 49_000, 30)]).action,
    ).toBe("REVIEW_FOR_ACCEPTANCE");
    // at the walk-away and still above it; or a repeated offer above it
    expect(
      rec(
        [ours(1, 50_000, 5)],
        [theirs("a", 60_000, 1), theirs("b", 58_000, 9)],
      ).action,
    ).toBe("WALK_AWAY");
    expect(
      rec(
        [ours(1, 40_000, 5)],
        [theirs("a", 60_000, 1), theirs("b", 60_000, 9)],
      ),
    ).toMatchObject({ action: "WALK_AWAY" });
    // a rejected or failed counter does not count (callers only pass live ones), pending ones do
    expect(
      rec([ours(1, 40_000, 5, "PENDING_APPROVAL")], [theirs("a", 60_000, 1)])
        .action,
    ).toBe("WAIT");
  });

  it("property: a recommended counter is always inside the rules and never a step back, and acceptance is never recommended above the walk-away", () => {
    let seed = 1234;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    let counters = 0;
    for (let i = 0; i < 1000; i++) {
      const walk = 2_000 + rnd(3_000);
      const d = doc({
        walkAwayMinor: walk,
        targetTotalMinor: 1_000 + rnd(walk - 999),
        rounds: { maxRounds: 1 + rnd(5) },
      });
      const n = rnd(d.rounds.maxRounds + 1);
      let last = 0;
      const o: OurCounter[] = Array.from({ length: n }, (_, k) => {
        last += 1 + rnd(400);
        return ours(k + 1, Math.min(last, walk), 10 * (k + 1));
      });
      const th: TheirOffer[] = Array.from({ length: 1 + rnd(3) }, (_, k) =>
        theirs(
          String(k),
          rnd(5) === 0 ? null : 500 + rnd(6_000),
          10 * k + rnd(8),
          rnd(4) === 0 ? { terms: {} } : {},
        ),
      );
      const r = recommend({ doc: d, ours: o, theirs: th });
      if (r.action === "COUNTER") {
        counters++;
        expect(r.totalMinor).toBeLessThanOrEqual(walk);
        expect(r.totalMinor).toBeGreaterThanOrEqual(o.at(-1)?.totalMinor ?? 0);
        expect(r.round).toBe(o.length + 1);
        expect(r.round).toBeLessThanOrEqual(d.rounds.maxRounds);
      }
      if (r.action === "REVIEW_FOR_ACCEPTANCE")
        expect(r.theirTotalMinor).toBeLessThanOrEqual(walk);
      if (r.action === "WALK_AWAY" && r.theirTotalMinor !== null)
        expect(r.theirTotalMinor).toBeGreaterThan(0);
    }
    expect(counters).toBeGreaterThan(100);
  });
});

(url ? describe : describe.skip)(
  "M38 counteroffers (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events",
      channels: () => new ChannelRegistry().register(sandboxEmailChannel),
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const st = (minor: number) => ({ basis: "STATED", minor });
    const scene = async () => {
      const m = await activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: { mode: "ONLY", ids: ["s1"] },
          maxCommitmentMinor: 60_000,
          expiresAt: "2026-11-23T10:00:00.000Z",
          agents: [
            {
              agentId: "a",
              capabilities: ["READ", "DRAFT", "COMMUNICATE", "COMPARE"],
            },
            {
              agentId: "b",
              capabilities: ["READ", "DRAFT", "NEGOTIATE", "COMPARE"],
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
      const n = (await (
        await post(m.b, `/v1/agent/missions/${m.id}/negotiations`, {
          supplierId: sid,
          idempotencyKey: idemKey("n"),
          document: doc(),
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
        supersedes?: string;
        shipping?: unknown;
      } = {},
    ) => {
      const r = await post(s.owner, `/v1/admin/org/missions/${s.id}/quotes`, {
        supplierId: s.sid,
        currency: "USD",
        validUntil: "2026-11-10T10:00:00.000Z",
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
          terms: over.terms ?? {},
        },
        source: { kind: "SUPPLIER_STATED", ref: "email" },
        ...(over.supersedes ? { supersedes: over.supersedes } : {}),
        idempotencyKey: idemKey("q"),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { quote: { quoteId: string } }).quote.quoteId;
    };
    const counter = (
      s: S,
      round: number,
      totalMinor: number,
      terms: Record<string, unknown> = {
        warrantyMonths: 12,
        returnWindowDays: 14,
        deliveryDays: 10,
      },
    ) => ({
      supplierId: s.sid,
      contactId: s.cid,
      kind: "NEGOTIATION",
      negotiationId: s.nid,
      subject: `Offer ${round}`,
      body: "Our offer for the full quantity is below.",
      move: {
        kind: "COUNTER",
        round,
        currency: "USD",
        totalMinor,
        terms,
        quantityIncreasePercent: 0,
        disclosing: [],
      },
      idempotencyKey: idemKey("m"),
    });
    const draft = (s: S, b: unknown) =>
      post(s.b, `/v1/agent/missions/${s.id}/messages`, b);
    const reason = async (r: Response) =>
      (await r.json()) as { reason: string; detail?: string };
    const sendIt = async (s: S, b: unknown) => {
      const m = (await (await draft(s, b)).json()) as {
        message: { messageId: string };
      };
      expect(
        (
          await post(
            s.owner,
            `/v1/admin/org/messages/${m.message.messageId}/approve`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await post(
            s.owner,
            `/v1/admin/org/messages/${m.message.messageId}/send`,
          )
        ).status,
      ).toBe(200);
      return m.message.messageId;
    };
    type TL = {
      status: string;
      entries: {
        side: string;
        kind: string;
        totalMinor: number | null;
        round?: number;
        status: string;
      }[];
      recommendation: {
        action: string;
        round?: number;
        totalMinor?: number;
        gapMinor?: number;
        asks?: Record<string, number>;
        theirTotalMinor?: number;
        termsShortfalls?: string[];
      };
      notice: string;
    };
    const timeline = async (
      t: string,
      s: S,
      base = "/v1/admin/org/negotiations",
    ) => (await (await get(t, `${base}/${s.nid}/timeline`)).json()) as TL;

    it("rounds are counted by PayFlow and offers never go backwards: the sender cannot dodge the round limit by always saying round 1", async () => {
      const s = await scene();
      const refused = async (b: unknown) =>
        (await reason(await draft(s, b))).detail;
      expect(await refused(counter(s, 2, 40_000))).toBe(
        "ROUND_MISMATCH:expected 1",
      );
      expect(await refused(counter(s, 4, 40_000))).toMatch(/ROUND_LIMIT/u);
      const r1 = await draft(s, counter(s, 1, 40_000));
      expect(r1.status).toBe(201);
      expect(await refused(counter(s, 1, 41_000))).toBe(
        "ROUND_MISMATCH:expected 2",
      ); // "round 1" again
      expect(await refused(counter(s, 2, 39_999))).toBe(
        "OFFER_BELOW_PREVIOUS_OFFER:40000",
      ); // taking a concession back
      expect((await draft(s, counter(s, 2, 40_000))).status).toBe(201); // equal is not a step back
      expect((await draft(s, counter(s, 3, 45_000))).status).toBe(201);
      expect(await refused(counter(s, 4, 46_000))).toMatch(/ROUND_LIMIT/u); // the third and last round was used
      // a rejected counter frees its round
      const s2 = await scene();
      const first = (await (
        await draft(s2, counter(s2, 1, 40_000))
      ).json()) as { message: { messageId: string } };
      expect(
        (
          await post(
            s2.owner,
            `/v1/admin/org/messages/${first.message.messageId}/reject`,
          )
        ).status,
      ).toBe(200);
      expect((await draft(s2, counter(s2, 1, 41_000))).status).toBe(201);
    });

    it("concurrent drafts cannot take the same round, and approval re-counts: a counter whose predecessor was rejected must be redrafted", async () => {
      const s = await scene();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, k) =>
          draft(s, counter(s, 1, 40_000 + k)),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 201))
        expect((await reason(r)).detail).toMatch(/^ROUND_MISMATCH/u);
      const s2 = await scene();
      const m1 = (await (await draft(s2, counter(s2, 1, 40_000))).json()) as {
        message: { messageId: string };
      };
      const m2 = (await (await draft(s2, counter(s2, 2, 42_000))).json()) as {
        message: { messageId: string };
      };
      expect(
        (
          await post(
            s2.owner,
            `/v1/admin/org/messages/${m1.message.messageId}/reject`,
          )
        ).status,
      ).toBe(200);
      const late = await post(
        s2.owner,
        `/v1/admin/org/messages/${m2.message.messageId}/approve`,
      );
      expect([late.status, (await reason(late)).detail]).toEqual([
        422,
        "ROUND_MISMATCH:expected 1",
      ]);
    });

    it("the timeline and the recommendation follow the supplier's replies, and whatever is recommended can be drafted as is", async () => {
      const s = await scene();
      let t = await timeline(s.owner, s);
      expect(t.recommendation.action).toBe("NEED_BASELINE");
      expect(t.notice).toContain("A recommendation only");
      const q1 = await quote(s, 60_000, {
        terms: { warrantyMonths: 6, deliveryDays: 14 },
      });
      t = await timeline(s.owner, s);
      expect(t.recommendation).toMatchObject({
        action: "COUNTER",
        round: 1,
        totalMinor: 40_000,
        gapMinor: 20_000,
        asks: { warrantyMonths: 12, returnWindowDays: 14, deliveryDays: 10 },
      });
      // act on it exactly as recommended
      const act = async () => {
        const rec = (await timeline(s.b, s, "/v1/agent/negotiations"))
          .recommendation;
        expect(rec.action).toBe("COUNTER");
        return sendIt(
          s,
          counter(s, rec.round!, rec.totalMinor!, {
            warrantyMonths: rec.asks!["warrantyMonths"],
            returnWindowDays: rec.asks!["returnWindowDays"],
            deliveryDays: rec.asks!["deliveryDays"],
          }),
        );
      };
      await act();
      t = await timeline(s.owner, s);
      expect(t.recommendation.action).toBe("WAIT");
      expect(
        t.entries.map((e) => [e.side, e.kind, e.totalMinor, e.status]),
      ).toEqual([
        ["THEIRS", "QUOTE", 60_000, "SUPERSEDED"]
          .slice(0, 3)
          .concat(["CURRENT"]),
        ["OURS", "COUNTER", 40_000, "SENT"],
      ]);
      // they answer with a better quote: the next counter meets them part-way
      const q2 = await quote(s, 48_000, {
        supersedes: q1,
        terms: { warrantyMonths: 6, deliveryDays: 14 },
      });
      t = await timeline(s.owner, s);
      expect(t.recommendation).toMatchObject({
        action: "COUNTER",
        round: 2,
        totalMinor: 44_000,
        gapMinor: 4_000,
      });
      await act();
      // then they come in at or below our last offer: a person should look at accepting
      await quote(s, 43_500, {
        supersedes: q2,
        terms: { warrantyMonths: 12, returnWindowDays: 14, deliveryDays: 10 },
      });
      t = await timeline(s.owner, s);
      expect(t.recommendation).toMatchObject({
        action: "REVIEW_FOR_ACCEPTANCE",
        theirTotalMinor: 43_500,
        termsShortfalls: [],
      });
      expect(
        t.entries.filter((e) => e.side === "OURS").map((e) => e.round),
      ).toEqual([1, 2]);
    });

    it("a supplier that will not move above the walk-away ends in a walk-away recommendation; nothing is ever sent by the recommendation itself", async () => {
      const s = await scene();
      const q1 = await quote(s, 70_000);
      await sendIt(s, counter(s, 1, 40_000));
      const q2 = await quote(s, 70_000, { supersedes: q1 });
      const t = await timeline(s.owner, s);
      expect(t.recommendation).toMatchObject({
        action: "WALK_AWAY",
        theirTotalMinor: 70_000,
      });
      void q2;
      const out = await h.repo
        .sql`select count(*)::int as n from mission_messages where status = 'SENT'`;
      expect(out[0]!.n).toBe(1); // only the one we sent ourselves
    });

    it("who may read it: the named negotiator, people with view access; not other agents or other tenants", async () => {
      const s = await scene();
      await quote(s, 60_000);
      expect(
        (await get(s.b, `/v1/agent/negotiations/${s.nid}/timeline`)).status,
      ).toBe(200);
      expect(
        (await get(s.a, `/v1/agent/negotiations/${s.nid}/timeline`)).status,
      ).toBe(403); // no NEGOTIATE grant
      expect(
        (await get(s.c, `/v1/agent/negotiations/${s.nid}/timeline`)).status,
      ).toBe(403);
      expect(
        (
          await get(
            await h.member("DEVELOPER"),
            `/v1/admin/org/negotiations/${s.nid}/timeline`,
          )
        ).status,
      ).toBe(200);
      const stranger = await h.ownerOf("org-other");
      expect(
        (await get(stranger, `/v1/admin/org/negotiations/${s.nid}/timeline`))
          .status,
      ).toBe(404);
      expect(
        (
          await get(
            s.b,
            `/v1/agent/negotiations/ngt_${"0".repeat(24)}/timeline`,
          )
        ).status,
      ).toBe(404);
    });
  },
);
