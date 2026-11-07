import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  compareQuotes,
  landed,
  statusOf,
  type Landed,
  type Money,
  type QuoteDocument,
} from "../src/missions/quotes.js";

/**
 * V3 M34 — quotes and landed cost, against the real Gateway on PostgreSQL. A quote is what a supplier STATED; a total is claimed
 * only when no part of it is unknown; nothing here accepts or commits anything.
 */
const url = process.env.TEST_DATABASE_URL;
const st = (minor: number): Money => ({ basis: "STATED", minor });
const es = (minor: number): Money => ({ basis: "ESTIMATED", minor });
const UNK: Money = { basis: "UNKNOWN" };
const docOf = (over: Partial<QuoteDocument> = {}): QuoteDocument => ({
  lines: [
    { description: "Quiet keyboard", quantity: 2, unitPrice: st(1000) },
    { description: "Wrist rest", quantity: 1, unitPrice: st(500) },
  ],
  shipping: st(300),
  tax: st(250),
  duties: st(0),
  fees: st(100),
  discount: st(200),
  terms: { deliveryDays: 5 },
  ...over,
});
const asLanded = (d: QuoteDocument): Landed => {
  const l = landed(d);
  if ("tooLarge" in l) throw new Error("too large");
  return l;
};

describe("M34 landed cost (pure)", () => {
  it("adds lines, shipping, tax, duties and fees and subtracts the discount, exactly, in integer minor units", () => {
    const l = asLanded(docOf());
    expect(l).toMatchObject({
      subtotalKnownMinor: 2500,
      knownMinor: 2950,
      totalMinor: 2950,
      complete: true,
      hasEstimates: false,
      unknown: [],
    });
  });

  it("anything unknown makes the total unclaimed: only the known part and the list of unknown parts are given", () => {
    const l = asLanded(
      docOf({
        shipping: UNK,
        discount: UNK,
        lines: [{ description: "x", quantity: 3, unitPrice: UNK }],
      }),
    );
    expect(l.complete).toBe(false);
    expect(l.totalMinor).toBeNull();
    expect(l.unknown).toEqual(["line 1 unit price", "shipping", "discount"]);
    expect(l.knownMinor).toBe(250 + 0 + 100);
    const est = asLanded(docOf({ tax: es(250) }));
    expect(est).toMatchObject({
      complete: true,
      hasEstimates: true,
      estimated: ["tax"],
      totalMinor: 2950,
    });
  });

  it("refuses numbers it cannot present honestly: a negative total or one beyond exact integers", () => {
    expect(landed(docOf({ discount: st(1_000_000) }))).toEqual({
      tooLarge: true,
    });
    const huge = docOf({
      lines: Array.from({ length: 50 }, () => ({
        description: "x",
        quantity: 1_000_000,
        unitPrice: st(1_000_000_000_000),
      })),
    });
    expect(landed(huge)).toEqual({ tooLarge: true });
  });

  it("property: the total equals a plain-number recomputation, and raising a cost never lowers it (a discount never raises it)", () => {
    let seed = 5;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + rnd(4) }, () => ({
        description: "x",
        quantity: 1 + rnd(50),
        unitPrice: st(rnd(100_000)),
      }));
      const [sh, tx, du, fe] = [rnd(5000), rnd(5000), rnd(5000), rnd(5000)];
      const disc = rnd(300);
      const d = docOf({
        lines,
        shipping: st(sh),
        tax: st(tx),
        duties: st(du),
        fees: st(fe),
        discount: st(disc),
      });
      const expected =
        lines.reduce(
          (n, l) => n + l.quantity * (l.unitPrice as { minor: number }).minor,
          0,
        ) +
        sh +
        tx +
        du +
        fe -
        disc;
      const l = asLanded(d);
      expect(l.totalMinor).toBe(expected);
      expect(
        asLanded({ ...d, shipping: st(sh + 1) }).totalMinor!,
      ).toBeGreaterThan(l.totalMinor!);
      expect(
        asLanded({ ...d, discount: st(disc + 1) }).totalMinor!,
      ).toBeLessThan(l.totalMinor!);
    }
  });

  it("status and comparison: only complete, current quotes in the mission currency are ranked, the rest say why not", () => {
    const NOW = "2026-10-23T10:00:00.000Z";
    expect(statusOf("2026-10-24T00:00:00.000Z", false, NOW)).toBe("CURRENT");
    expect(statusOf("2026-10-23T10:00:00.000Z", false, NOW)).toBe("EXPIRED");
    expect(statusOf("2026-10-24T00:00:00.000Z", true, NOW)).toBe("SUPERSEDED");
    const q = (
      id: string,
      doc: QuoteDocument,
      over: Partial<{
        currency: string;
        status: "CURRENT" | "EXPIRED" | "SUPERSEDED";
      }> = {},
    ) => ({
      quoteId: id,
      supplierId: "sup_" + id,
      currency: over.currency ?? "USD",
      status: over.status ?? ("CURRENT" as const),
      landed: asLanded(doc),
    });
    const r = compareQuotes(
      [
        q("qte_b", docOf()),
        q("qte_a", docOf()), // same total as b: id decides
        q("qte_c", docOf({ fees: st(0) })), // cheaper
        q("qte_d", docOf({ shipping: UNK })), // incomplete
        q("qte_e", docOf(), { status: "EXPIRED" }),
        q("qte_f", docOf(), { status: "SUPERSEDED" }),
        q("qte_g", docOf(), { currency: "EUR" }),
      ],
      "USD",
    );
    expect(r.ranked.map((x) => [x.quoteId, x.rank, x.overBestMinor])).toEqual([
      ["qte_c", 1, 0],
      ["qte_a", 2, 100],
      ["qte_b", 3, 100],
    ]);
    expect(
      Object.fromEntries(r.notRanked.map((x) => [x.quoteId, x.reason])),
    ).toEqual({
      qte_d: "Not complete: shipping unknown.",
      qte_e: "The quote has expired.",
      qte_f: "A newer quote replaced it.",
      qte_g: "In EUR; no conversion is done.",
    });
  });
});

(url ? describe : describe.skip)(
  "M34 quotes (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const FUTURE = "2026-10-30T10:00:00.000Z";
    const mission = () =>
      activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: {
            mode: "ONLY",
            ids: ["payflow.demo.merchant", "second.merchant"],
          },
          agents: [
            {
              agentId: "a",
              capabilities: ["SEARCH", "READ", "COMPARE", "VERIFY"],
            },
            { agentId: "b", capabilities: ["READ"] },
            { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
          ],
        }),
      );
    const supplier = async (
      owner: string,
      id: string,
      externalRef = "payflow.demo.merchant",
    ) =>
      (
        (await (
          await post(owner, `/v1/admin/org/missions/${id}/suppliers`, {
            externalRef,
          })
        ).json()) as { supplierId: string }
      ).supplierId;
    const body = (supplierId: string, over: Record<string, unknown> = {}) => ({
      supplierId,
      currency: "USD",
      validUntil: FUTURE,
      document: docOf(),
      source: {
        kind: "SUPPLIER_STATED",
        ref: "email 2026-10-22 from sales@supplier.example",
      },
      idempotencyKey: idemKey("q"),
      ...over,
    });
    type Q = {
      quoteId: string;
      status: string;
      landed: Landed;
      supersedes: string | null;
      ledgerItemId: string | null;
    };
    const record = async (
      t: string,
      id: string,
      supplierId: string,
      over: Record<string, unknown> = {},
      base = "/v1/admin/org/missions",
    ) => {
      const r = await post(t, `${base}/${id}/quotes`, body(supplierId, over));
      return {
        status: r.status,
        json: (await r.json()) as {
          quote: Q;
          reason?: string;
          detail?: string;
          replayed?: boolean;
        },
      };
    };
    const quotes = async (t: string, id: string) =>
      (await (
        await h.call(t, "GET", `/v1/admin/org/missions/${id}/quotes`)
      ).json()) as { quotes: Q[]; notice: string };
    const ledger = async (t: string, id: string) =>
      (await (await h.call(t, "GET", `${MISSIONS}/${id}/ledger`)).json()) as {
        summary: { exposureMinor: number };
        items: {
          itemId: string;
          label: string;
          amountMinor: number;
          stage: string;
          verification: string;
        }[];
      };

    it("recording: the supplier, contract, expiry and source evidence are all checked; keys are idempotent; the schema is strict", async () => {
      const { owner, a, b, c, id } = await mission();
      const sid = await supplier(owner, id);
      const ok = await record(owner, id, sid);
      expect(ok.status).toBe(201);
      expect(ok.json.quote.landed).toMatchObject({
        complete: true,
        totalMinor: 2950,
      });
      expect((await quotes(owner, id)).notice).toContain("not an acceptance");
      // agents: COMPARE records, READ alone does not, no grant at all does not
      expect((await record(a, id, sid, {}, "/v1/agent/missions")).status).toBe(
        201,
      );
      expect((await record(b, id, sid, {}, "/v1/agent/missions")).status).toBe(
        403,
      );
      expect((await record(c, id, sid, {}, "/v1/agent/missions")).status).toBe(
        403,
      );
      // a supplier that is not this mission's, or that the contract bars, cannot have a quote
      expect((await record(owner, id, `sup_${"0".repeat(24)}`)).status).toBe(
        404,
      );
      const barred = await supplier(owner, id, "barred.merchant");
      const r = await record(owner, id, barred);
      expect([r.status, r.json.reason]).toEqual([
        403,
        "SUPPLIER_NOT_ALLOWED_BY_CONTRACT",
      ]);
      // time
      expect(
        (
          await record(owner, id, sid, {
            validUntil: "2026-10-23T10:00:00.000Z",
          })
        ).json.reason,
      ).toBe("QUOTE_EXPIRED");
      expect(
        (
          await record(owner, id, sid, {
            validUntil: "2028-10-23T10:00:00.000Z",
          })
        ).status,
      ).toBe(400);
      // source evidence
      const bad = async (source: unknown, who = owner) =>
        (await record(who, id, sid, { source })).json.detail;
      expect(await bad({ kind: "DOCUMENT_REF" })).toBe("REFERENCE_REQUIRED");
      expect(
        await bad({ kind: "CONNECTOR_CALL", ref: `cal_${"0".repeat(24)}` }),
      ).toBe("NO_SUCH_SUCCESSFUL_CONNECTOR_CALL_FOR_THIS_MISSION");
      const agentOwnerReported = await record(
        a,
        id,
        sid,
        { source: { kind: "OWNER_REPORTED" } },
        "/v1/agent/missions",
      );
      expect(agentOwnerReported.json.detail).toBe(
        "OWNER_REPORTED_IS_A_PERSONS_ACT",
      );
      expect(
        (await record(owner, id, sid, { source: { kind: "OWNER_REPORTED" } }))
          .status,
      ).toBe(201);
      // a real connector call of this mission is accepted as the source
      await post(
        owner,
        "/v1/admin/org/connectors/payflow-demo-catalog/install",
        { acknowledgedDataUse: true },
      );
      const call = (
        (await (
          await post(a, `/v1/agent/missions/${id}/connectors/invoke`, {
            connectorId: "payflow-demo-catalog",
            capability: "SEARCH",
            query: { text: "keyboard" },
            idempotencyKey: idemKey("c"),
          })
        ).json()) as { callId: string }
      ).callId;
      expect(
        (
          await record(owner, id, sid, {
            source: { kind: "CONNECTOR_CALL", ref: call },
          })
        ).status,
      ).toBe(201);
      // strict schema: unknown fields, floats, negatives, zero quantity, unknown basis
      for (const [label, over] of [
        ["extra field", { extra: 1 }],
        ["float money", { document: docOf({ shipping: st(10.5) }) }],
        ["negative money", { document: docOf({ shipping: st(-1) }) }],
        [
          "zero quantity",
          {
            document: docOf({
              lines: [{ description: "x", quantity: 0, unitPrice: st(1) }],
            }),
          },
        ],
        [
          "bad basis",
          { document: { ...docOf(), tax: { basis: "GUESSED", minor: 1 } } },
        ],
        [
          "unknown with an amount",
          { document: { ...docOf(), tax: { basis: "UNKNOWN", minor: 5 } } },
        ],
        [
          "discount beyond the total",
          { document: docOf({ discount: st(1_000_000) }) },
        ],
        ["bad currency", { currency: "usd" }],
      ] as const)
        expect(
          (await record(owner, id, sid, over as Record<string, unknown>))
            .status,
          label,
        ).toBe(400);
      // idempotency
      const key = idemKey("same");
      const first = await record(owner, id, sid, { idempotencyKey: key });
      const again = await record(owner, id, sid, { idempotencyKey: key });
      expect([
        first.json.replayed,
        again.json.replayed,
        again.json.quote.quoteId,
      ]).toEqual([false, true, first.json.quote.quoteId]);
      expect(
        (await record(owner, id, sid, { idempotencyKey: key, currency: "EUR" }))
          .status,
      ).toBe(409);
    });

    it("incomplete and estimated quotes are shown for what they are, and quotes expire with time", async () => {
      const { owner, id } = await mission();
      const sid = await supplier(owner, id);
      const inc = await record(owner, id, sid, {
        document: docOf({ shipping: UNK, tax: es(250) }),
      });
      expect(inc.json.quote.landed).toMatchObject({
        complete: false,
        totalMinor: null,
        unknown: ["shipping"],
        estimated: ["tax"],
        knownMinor: 2650,
      });
      const ok = await record(owner, id, sid);
      expect(ok.json.quote.status).toBe("CURRENT");
      h.advance(8 * 86_400_000); // past FUTURE (7 days)
      const later = (
        (await (
          await h.call(ADMIN_TOKEN, "POST", "/v1/admin/members", {
            organizationId: "payflow-sandbox",
            environment: "SANDBOX",
            displayName: "later",
            role: "OWNER",
          })
        ).json()) as { token: string }
      ).token;
      expect(
        (await quotes(later, id)).quotes.every((q) => q.status === "EXPIRED"),
      ).toBe(true);
    });

    it("a newer quote supersedes an older one once; history stays; rows are immutable", async () => {
      const { owner, id } = await mission();
      const s1 = await supplier(owner, id);
      const s2 = await supplier(owner, id, "second.merchant");
      const old = (await record(owner, id, s1)).json.quote;
      const other = (await record(owner, id, s2)).json.quote;
      const newer = await record(owner, id, s1, {
        supersedes: old.quoteId,
        document: docOf({ fees: st(0) }),
      });
      expect(newer.status).toBe(201);
      expect(newer.json.quote.supersedes).toBe(old.quoteId);
      const list = (await quotes(owner, id)).quotes;
      expect(
        Object.fromEntries(list.map((q) => [q.quoteId, q.status])),
      ).toEqual({
        [old.quoteId]: "SUPERSEDED",
        [other.quoteId]: "CURRENT",
        [newer.json.quote.quoteId]: "CURRENT",
      });
      const again = await record(owner, id, s1, { supersedes: old.quoteId });
      expect([again.status, again.json.reason]).toEqual([
        409,
        "QUOTE_SUPERSEDED",
      ]);
      expect(
        (await record(owner, id, s1, { supersedes: other.quoteId })).status,
      ).toBe(404); // another supplier's quote
      expect(
        (await record(owner, id, s1, { supersedes: `qte_${"0".repeat(24)}` }))
          .status,
      ).toBe(404);
      await expect(
        h.repo
          .sql`update mission_quotes set currency = 'EUR' where quote_id = ${old.quoteId}`,
      ).rejects.toThrow();
      await expect(
        h.repo.sql`delete from mission_quotes where quote_id = ${old.quoteId}`,
      ).rejects.toThrow();
    });

    it("comparison ranks only complete, current quotes in the mission currency by landed cost, and explains the rest", async () => {
      const { owner, a, c, id } = await mission();
      const s1 = await supplier(owner, id);
      const s2 = await supplier(owner, id, "second.merchant");
      const cheap = (
        await record(owner, id, s1, { document: docOf({ fees: st(0) }) })
      ).json.quote;
      const dear = (
        await record(owner, id, s2, { document: docOf({ shipping: st(900) }) })
      ).json.quote;
      const part = (
        await record(owner, id, s2, { document: docOf({ tax: UNK }) })
      ).json.quote;
      const eur = (await record(owner, id, s1, { currency: "EUR" })).json.quote;
      const cmp = async (t: string, base: string, quoteIds?: string[]) =>
        post(t, `${base}/${id}/quotes/compare`, quoteIds ? { quoteIds } : {});
      const r = (await (await cmp(owner, "/v1/admin/org/missions")).json()) as {
        ranked: {
          quoteId: string;
          rank: number;
          totalMinor: number;
          overBestMinor: number;
        }[];
        notRanked: { quoteId: string; reason: string }[];
        currency: string;
      };
      expect(r.currency).toBe("USD");
      expect(
        r.ranked.map((x) => [x.quoteId, x.rank, x.totalMinor, x.overBestMinor]),
      ).toEqual([
        [cheap.quoteId, 1, 2850, 0],
        [dear.quoteId, 2, 3550, 700],
      ]);
      expect(
        Object.fromEntries(r.notRanked.map((x) => [x.quoteId, x.reason])),
      ).toEqual({
        [part.quoteId]: "Not complete: tax unknown.",
        [eur.quoteId]: "In EUR; no conversion is done.",
      });
      const sub = (await (
        await cmp(owner, "/v1/admin/org/missions", [dear.quoteId, part.quoteId])
      ).json()) as { ranked: unknown[]; notRanked: unknown[] };
      expect([sub.ranked.length, sub.notRanked.length]).toEqual([1, 1]);
      expect(
        (
          await cmp(owner, "/v1/admin/org/missions", [
            dear.quoteId,
            `qte_${"1".repeat(24)}`,
          ])
        ).status,
      ).toBe(404);
      expect((await cmp(a, "/v1/agent/missions")).status).toBe(200);
      expect((await cmp(c, "/v1/agent/missions")).status).toBe(403);
      const stranger = await h.ownerOf("org-other");
      expect((await cmp(stranger, "/v1/admin/org/missions")).status).toBe(404);
    });

    it("putting a quote in the budget creates exactly one QUOTED, unverified ledger item that holds nothing until a person approves it", async () => {
      const { owner, a, c, id } = await mission();
      const sid = await supplier(owner, id);
      const good = (await record(owner, id, sid)).json.quote;
      const inc = (
        await record(owner, id, sid, { document: docOf({ fees: UNK }) })
      ).json.quote;
      const eur = (await record(owner, id, sid, { currency: "EUR" })).json
        .quote;
      const old = (await record(owner, id, sid)).json.quote;
      await record(owner, id, sid, { supersedes: old.quoteId });
      const key = idemKey("l");
      const toLedger = (
        t: string,
        qid: string,
        base = "/v1/admin/org/quotes",
      ) => post(t, `${base}/${qid}/ledger`, { idempotencyKey: key });
      // refusals first: incomplete, wrong currency, superseded, no grant, no permission
      expect(
        (
          (await (await toLedger(owner, inc.quoteId)).json()) as {
            reason: string;
          }
        ).reason,
      ).toBe("QUOTE_INCOMPLETE");
      expect(
        (
          (await (await toLedger(owner, eur.quoteId)).json()) as {
            reason: string;
          }
        ).reason,
      ).toBe("CURRENCY_MISMATCH");
      expect(
        (
          (await (await toLedger(owner, old.quoteId)).json()) as {
            reason: string;
          }
        ).reason,
      ).toBe("QUOTE_SUPERSEDED");
      expect((await toLedger(c, good.quoteId, "/v1/agent/quotes")).status).toBe(
        403,
      );
      expect(
        (await toLedger(await h.member("DEVELOPER"), good.quoteId)).status,
      ).toBe(403);
      expect((await ledger(owner, id)).items).toHaveLength(0);
      // the real thing: a person, an agent, and a race all land on one item
      const results = await Promise.all([
        toLedger(owner, good.quoteId),
        toLedger(a, good.quoteId, "/v1/agent/quotes"),
        toLedger(owner, good.quoteId),
        toLedger(a, good.quoteId, "/v1/agent/quotes"),
        toLedger(owner, good.quoteId),
        toLedger(owner, good.quoteId),
      ]);
      for (const r of results)
        expect([200, 201], await r.clone().text()).toContain(r.status);
      const ids = new Set(
        await Promise.all(
          results.map(
            async (r) => ((await r.json()) as { itemId: string }).itemId,
          ),
        ),
      );
      expect(ids.size).toBe(1);
      const led = await ledger(owner, id);
      const mine = led.items.filter((i) => i.label.startsWith("Quote from"));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        amountMinor: 2950,
        stage: "QUOTED",
        verification: "UNVERIFIED",
      });
      expect(led.summary.exposureMinor).toBe(0); // a quote holds no budget
      expect(
        (await quotes(owner, id)).quotes.find(
          (q) => q.quoteId === good.quoteId,
        )!.ledgerItemId,
      ).toBe([...ids][0]);
      // a person approving it in the ledger is what consumes budget
      const approve = await post(
        owner,
        `/v1/admin/org/ledger/items/${[...ids][0]}/transition`,
        { to: "APPROVED", idempotencyKey: idemKey("t") },
      );
      expect(approve.status).toBe(200);
      expect((await ledger(owner, id)).summary.exposureMinor).toBe(2950);
      const link = await h.repo
        .sql`select count(*)::int as n from mission_quote_ledger where quote_id = ${good.quoteId}`;
      expect(link[0]!.n).toBe(1);
      await expect(
        h.repo
          .sql`delete from mission_quote_ledger where quote_id = ${good.quoteId}`,
      ).rejects.toThrow();
    });

    it("an expired quote cannot be put in the budget; permissions and pause hold", async () => {
      const { owner, a, id } = await mission();
      const sid = await supplier(owner, id);
      const q = (
        await record(owner, id, sid, { validUntil: "2026-10-23T11:00:00.000Z" })
      ).json.quote;
      const dev = await h.member("DEVELOPER");
      expect(
        (await post(dev, `/v1/admin/org/missions/${id}/quotes`, body(sid)))
          .status,
      ).toBe(403);
      expect(
        (await h.call(dev, "GET", `/v1/admin/org/missions/${id}/quotes`))
          .status,
      ).toBe(200);
      expect(
        (await post(owner, "/v1/admin/org/pause", { reason: "t" })).status,
      ).toBe(200);
      expect((await record(a, id, sid, {}, "/v1/agent/missions")).status).toBe(
        423,
      );
      await post(owner, "/v1/admin/org/resume", {});
      h.advance(2 * 3_600_000);
      const later = (
        (await (
          await h.call(ADMIN_TOKEN, "POST", "/v1/admin/members", {
            organizationId: "payflow-sandbox",
            environment: "SANDBOX",
            displayName: "later",
            role: "OWNER",
          })
        ).json()) as { token: string }
      ).token;
      const r = await post(later, `/v1/admin/org/quotes/${q.quoteId}/ledger`, {
        idempotencyKey: idemKey("l"),
      });
      expect([
        r.status,
        ((await r.json()) as { reason: string }).reason,
      ]).toEqual([409, "QUOTE_EXPIRED"]);
    });
  },
);
