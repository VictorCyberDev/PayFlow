import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  MAX_ELIGIBLE,
  optimize,
  type OptInput,
  type OptQuote,
} from "../src/missions/sourcing.js";

/**
 * V3 M35 — sourcing optimization. The search is exhaustive over the recorded quotes, so "optimal" is checked here against an
 * independent brute-force oracle on hundreds of random instances; the integration tests then prove only usable quotes are
 * considered, nothing is committed by a run, and adopting is a person's idempotent act.
 */
const url = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------------------------------- the oracle
/** Brute force with none of optimize()'s pruning: every subset, recomputed from scratch. */
function oracle(i: OptInput) {
  const skus = i.demand.map((d) => d.sku);
  const ok = (q: OptQuote) => {
    const matched = q.lines.some((l) => l.sku !== null && skus.includes(l.sku));
    const extras = q.lines.some((l) => l.sku === null || !skus.includes(l.sku));
    return (
      matched &&
      (i.allowExtras || !extras) &&
      q.totalMinor <= i.maxCommitmentMinor
    );
  };
  const pool = [...i.quotes]
    .filter(ok)
    .sort((a, b) => (a.quoteId < b.quoteId ? -1 : 1));
  const plans: {
    total: number;
    surplus: number;
    suppliers: number;
    key: string;
  }[] = [];
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const chosen = pool.filter((_, k) => (mask >> k) & 1);
    let surplus = 0;
    let covered = true;
    for (const d of i.demand) {
      const got = chosen.reduce(
        (a, q) =>
          a +
          q.lines
            .filter((l) => l.sku === d.sku)
            .reduce((x, l) => x + l.quantity, 0),
        0,
      );
      if (got < d.quantity) covered = false;
      surplus += Math.max(0, got - d.quantity);
    }
    surplus += chosen.reduce(
      (a, q) =>
        a +
        q.lines
          .filter((l) => l.sku === null || !skus.includes(l.sku))
          .reduce((x, l) => x + l.quantity, 0),
      0,
    );
    const total = chosen.reduce((a, q) => a + q.totalMinor, 0);
    if (
      !covered ||
      surplus > i.maxSurplusUnits ||
      (i.availableMinor !== null && total > i.availableMinor)
    )
      continue;
    plans.push({
      total,
      surplus,
      suppliers: new Set(chosen.map((q) => q.supplierId)).size,
      key: chosen.map((q) => q.quoteId).join("|"),
    });
  }
  plans.sort(
    (a, b) =>
      a.total - b.total ||
      a.surplus - b.surplus ||
      a.suppliers - b.suppliers ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return plans;
}

const quote = (
  id: string,
  supplier: string,
  total: number,
  lines: OptQuote["lines"],
): OptQuote => ({
  quoteId: id,
  supplierId: supplier,
  totalMinor: total,
  lines,
});
const base = (over: Partial<OptInput> = {}): OptInput => ({
  demand: [{ sku: "KB", quantity: 10 }],
  quotes: [],
  availableMinor: 1_000_000,
  maxCommitmentMinor: 600_000,
  humanApprovalAboveMinor: undefined,
  maxSurplusUnits: 0,
  allowExtras: false,
  ...over,
});

describe("M35 optimizer (pure)", () => {
  it("matches an independent brute-force oracle on 600 random instances: cost, tie-breaks and the next best plans", () => {
    let seed = 2026;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    let feasible = 0;
    for (let t = 0; t < 600; t++) {
      const skus = ["A", "B", "C"].slice(0, 1 + rnd(3));
      const demand = skus.map((s) => ({ sku: s, quantity: 1 + rnd(8) }));
      const n = 1 + rnd(8);
      const quotes = Array.from({ length: n }, (_, k) =>
        quote(
          `qte_${String(k).padStart(2, "0")}`,
          `sup_${rnd(3)}`,
          100 + rnd(900),
          [
            ...skus
              .filter(() => rnd(2) === 0)
              .map((s) => ({ sku: s, quantity: 1 + rnd(6) })),
            ...(rnd(5) === 0 ? [{ sku: "X", quantity: 1 + rnd(3) }] : []),
            ...(rnd(9) === 0 ? [{ sku: null, quantity: 1 }] : []),
          ],
        ),
      );
      const input = base({
        demand,
        quotes,
        availableMinor: rnd(4) === 0 ? null : 300 + rnd(2500),
        maxCommitmentMinor: 400 + rnd(700),
        maxSurplusUnits: rnd(3),
        allowExtras: rnd(2) === 0,
      });
      const want = oracle(input);
      const got = optimize(input);
      if (want.length === 0) {
        expect(
          got.status === "INFEASIBLE" || got.status === "TOO_MANY_ELIGIBLE",
          JSON.stringify(input),
        ).toBe(true);
        continue;
      }
      feasible++;
      expect(got.status).toBe("OPTIMAL");
      if (got.status !== "OPTIMAL") continue;
      const tup = (p: {
        totalMinor: number;
        surplusUnits: number;
        supplierIds: readonly string[];
        quoteIds: readonly string[];
      }) => [
        p.totalMinor,
        p.surplusUnits,
        p.supplierIds.length,
        p.quoteIds.join("|"),
      ];
      expect(tup(got.best), JSON.stringify(input)).toEqual([
        want[0]!.total,
        want[0]!.surplus,
        want[0]!.suppliers,
        want[0]!.key,
      ]);
      expect([got.best, ...got.alternatives].map(tup)).toEqual(
        want.slice(0, 3).map((p) => [p.total, p.surplus, p.suppliers, p.key]),
      );
      // every plan is real: covers the demand, within budget and surplus
      for (const p of [got.best, ...got.alternatives]) {
        expect(p.coverage.every((c) => c.covered >= c.required)).toBe(true);
        if (input.availableMinor !== null)
          expect(p.totalMinor).toBeLessThanOrEqual(input.availableMinor);
        expect(p.surplusUnits).toBeLessThanOrEqual(input.maxSurplusUnits);
      }
    }
    expect(feasible).toBeGreaterThan(60); // the instances are not all trivially infeasible
  });

  it("matches the oracle when many plans tie on cost, so the tie-breaks (surplus, supplier count, quote ids) decide which three are shown", () => {
    let seed = 77;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let t = 0; t < 400; t++) {
      const demand = [{ sku: "A", quantity: 2 + rnd(4) }];
      const quotes = Array.from({ length: 3 + rnd(6) }, (_, k) =>
        quote(
          `qte_${String(k).padStart(2, "0")}`,
          `sup_${rnd(3)}`,
          100 * (1 + rnd(2)),
          [{ sku: "A", quantity: 1 + rnd(4) }],
        ),
      );
      const input = base({
        demand,
        quotes,
        availableMinor: null,
        maxSurplusUnits: 4,
      });
      const want = oracle(input);
      const got = optimize(input);
      if (want.length === 0) continue;
      expect(got.status).toBe("OPTIMAL");
      if (got.status !== "OPTIMAL") continue;
      expect(
        [got.best, ...got.alternatives].map((p) => [
          p.totalMinor,
          p.surplusUnits,
          p.supplierIds.length,
          p.quoteIds.join("|"),
        ]),
      ).toEqual(
        want.slice(0, 3).map((p) => [p.total, p.surplus, p.suppliers, p.key]),
      );
    }
  });

  it("is independent of input order and says why quotes were left out", () => {
    const quotes = [
      quote("qte_a", "s1", 51_000, [{ sku: "KB", quantity: 10 }]),
      quote("qte_b", "s2", 27_500, [{ sku: "KB", quantity: 6 }]),
      quote("qte_c", "s3", 16_500, [{ sku: "KB", quantity: 4 }]),
      quote("qte_d", "s4", 900, [{ sku: "MOUSE", quantity: 3 }]), // nothing that was asked for
      quote("qte_e", "s5", 800, [
        { sku: "KB", quantity: 10 },
        { sku: "MOUSE", quantity: 1 },
      ]), // extras
      quote("qte_f", "s6", 700_000, [{ sku: "KB", quantity: 10 }]), // beyond the largest commitment
    ];
    const first = optimize(base({ quotes }));
    for (let i = 0; i < 20; i++)
      expect(
        optimize(base({ quotes: [...quotes].sort(() => Math.random() - 0.5) })),
      ).toEqual(first);
    expect(first.status).toBe("OPTIMAL");
    if (first.status !== "OPTIMAL") return;
    expect(first.best).toMatchObject({
      quoteIds: ["qte_b", "qte_c"],
      totalMinor: 44_000,
      surplusUnits: 0,
      supplierIds: ["s2", "s3"],
    });
    expect(first.alternatives.map((p) => p.quoteIds)).toEqual([["qte_a"]]);
    expect(
      Object.fromEntries(first.excluded.map((e) => [e.quoteId, e.reason])),
    ).toEqual({
      qte_d: "Offers nothing that was asked for.",
      qte_e: "Also contains items that were not asked for.",
      qte_f: "Exceeds the contract's largest single commitment.",
    });
    // allowing extras admits the cheap one, with its extra unit counted as surplus and refused unless tolerated
    const tolerant = optimize(
      base({ quotes, allowExtras: true, maxSurplusUnits: 1 }),
    );
    expect(tolerant.status === "OPTIMAL" && tolerant.best.quoteIds).toEqual([
      "qte_e",
    ]);
    const strict = optimize(
      base({ quotes, allowExtras: true, maxSurplusUnits: 0 }),
    );
    expect(strict.status === "OPTIMAL" && strict.best.quoteIds).toEqual([
      "qte_b",
      "qte_c",
    ]);
  });

  it("infeasible results say exactly why: coverage, a budget shortfall to the minor unit, or the surplus limit", () => {
    const quotes = [
      quote("qte_a", "s1", 30_000, [{ sku: "KB", quantity: 6 }]),
      quote("qte_b", "s2", 20_000, [{ sku: "KB", quantity: 4 }]),
    ];
    const cover = optimize(
      base({ demand: [{ sku: "KB", quantity: 11 }], quotes }),
    );
    expect(cover).toMatchObject({
      status: "INFEASIBLE",
      reasons: ["COVERAGE:KB needs 11, eligible quotes offer 10"],
    });
    const budget = optimize(base({ quotes, availableMinor: 45_000 }));
    expect(budget).toMatchObject({
      status: "INFEASIBLE",
      reasons: ["BUDGET_SHORTFALL:5000"],
      cheapestWithoutBudgetMinor: 50_000,
      budgetEnforced: true,
    });
    const exactly = optimize(base({ quotes, availableMinor: 50_000 }));
    expect(exactly.status).toBe("OPTIMAL");
    const surplus = optimize(
      base({ demand: [{ sku: "KB", quantity: 9 }], quotes }),
    );
    expect(surplus.status === "INFEASIBLE" && surplus.reasons[0]).toMatch(
      /^SURPLUS_LIMIT/u,
    );
    expect(optimize(base({ quotes, availableMinor: null })).status).toBe(
      "OPTIMAL",
    );
    expect(
      (
        optimize(base({ quotes, availableMinor: null })) as {
          budgetEnforced?: boolean;
        }
      ).budgetEnforced,
    ).toBe(false);
  });

  it("flags plans that need a person, and refuses to search more than it can exhaust", () => {
    const quotes = [
      quote("qte_a", "s1", 51_000, [{ sku: "KB", quantity: 10 }]),
    ];
    const r = optimize(base({ quotes, humanApprovalAboveMinor: 30_000 }));
    expect(r.status === "OPTIMAL" && r.best.requiresHumanApproval).toEqual([
      "qte_a",
    ]);
    const many = Array.from({ length: MAX_ELIGIBLE + 1 }, (_, k) =>
      quote(`qte_${String(k).padStart(2, "0")}`, "s", 100 + k, [
        { sku: "KB", quantity: 1 },
      ]),
    );
    expect(optimize(base({ quotes: many }))).toMatchObject({
      status: "TOO_MANY_ELIGIBLE",
      eligible: MAX_ELIGIBLE + 1,
      limit: MAX_ELIGIBLE,
    });
    // exactly the limit still runs, and quickly
    const t0 = Date.now();
    const full = optimize(
      base({ quotes: many.slice(0, MAX_ELIGIBLE), maxSurplusUnits: 10 }),
    );
    expect(full.status).toBe("OPTIMAL");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------------------------------- integration
(url ? describe : describe.skip)(
  "M35 sourcing (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const FUTURE = "2026-10-30T10:00:00.000Z";
    const st = (minor: number) => ({ basis: "STATED", minor });
    const zero = st(0);
    const mission = () =>
      activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: { mode: "ONLY", ids: ["s1", "s2", "s3", "s4"] },
          maxCommitmentMinor: 60_000,
          approvalConditions: { humanApprovalAboveMinor: 30_000 },
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
      ref: string,
      qualified = true,
    ) => {
      const sid = (
        (await (
          await post(owner, `/v1/admin/org/missions/${id}/suppliers`, {
            externalRef: ref,
          })
        ).json()) as { supplierId: string }
      ).supplierId;
      if (qualified) {
        const f = (
          criterion: string,
          evidenceKind: string,
          evidenceRef?: string,
        ) =>
          post(owner, `/v1/admin/org/suppliers/${sid}/facts`, {
            criterion,
            status: "VERIFIED",
            evidenceKind,
            ...(evidenceRef ? { evidenceRef } : {}),
            idempotencyKey: idemKey("f"),
          });
        await f("IDENTITY", "OWNER_ATTESTATION");
        await f("PAYMENT_ACCEPTED", "OWNER_ATTESTATION");
        await f("RETURN_POLICY", "DOCUMENT_REF", "returns.pdf");
      }
      return sid;
    };
    const addQuote = async (
      owner: string,
      id: string,
      supplierId: string,
      lines: { sku?: string; q: number; unit: number }[],
      over: Record<string, unknown> = {},
      shipping: unknown = st(0),
    ) => {
      const r = await post(owner, `/v1/admin/org/missions/${id}/quotes`, {
        supplierId,
        currency: "USD",
        validUntil: FUTURE,
        document: {
          lines: lines.map((l) => ({
            description: l.sku ?? "item",
            ...(l.sku ? { sku: l.sku } : {}),
            quantity: l.q,
            unitPrice: st(l.unit),
          })),
          shipping,
          tax: zero,
          duties: zero,
          fees: zero,
          discount: zero,
        },
        source: { kind: "SUPPLIER_STATED", ref: "email" },
        idempotencyKey: idemKey("q"),
        ...over,
      });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      return ((await r.json()) as { quote: { quoteId: string } }).quote.quoteId;
    };
    type PlanOut = {
      quoteIds: string[];
      totalMinor: number;
      surplusUnits: number;
      requiresHumanApproval: string[];
    };
    type Run = {
      run: {
        runId: string;
        status: string;
        adopted: boolean;
        result: {
          best: PlanOut;
          alternatives: PlanOut[];
          excluded: { quoteId: string; reason: string }[];
          reasons: string[];
          cheapestWithoutBudgetMinor: number | null;
        };
        snapshot: { quoteId: string }[];
        notice: string;
      };
      replayed: boolean;
    };
    const runPath = (id: string, base = "/v1/admin/org/missions") =>
      `${base}/${id}/sourcing/runs`;
    const run = (
      t: string,
      id: string,
      over: Record<string, unknown> = {},
      base = "/v1/admin/org/missions",
    ) =>
      post(t, runPath(id, base), {
        demand: [{ sku: "KB", quantity: 10 }],
        idempotencyKey: idemKey("r"),
        ...over,
      });
    const ledger = async (t: string, id: string) =>
      (await (await get(t, `${MISSIONS}/${id}/ledger`)).json()) as {
        summary: { exposureMinor: number; availableMinor: number };
        items: {
          itemId: string;
          stage: string;
          label: string;
          amountMinor: number;
        }[];
      };
    /** The scenario: a single quote of 10, or two suppliers' 6 + 4 that are cheaper together. */
    const scenario = async () => {
      const m = await mission();
      const [s1, s2, s3, s4] = [
        await supplier(m.owner, m.id, "s1"),
        await supplier(m.owner, m.id, "s2"),
        await supplier(m.owner, m.id, "s3"),
        await supplier(m.owner, m.id, "s4", false),
      ];
      const q1 = await addQuote(
        m.owner,
        m.id,
        s1,
        [{ sku: "KB", q: 10, unit: 5000 }],
        {},
        st(1000),
      ); // 51000
      const q2 = await addQuote(
        m.owner,
        m.id,
        s2,
        [{ sku: "KB", q: 6, unit: 4500 }],
        {},
        st(500),
      ); // 27500
      const q3 = await addQuote(
        m.owner,
        m.id,
        s3,
        [{ sku: "KB", q: 4, unit: 4000 }],
        {},
        st(500),
      ); // 16500
      return { ...m, s1, s2, s3, s4, q1, q2, q3 };
    };

    it("recommends the cheapest covering set of whole quotes, with alternatives, and records it immutably without committing anything", async () => {
      const s = await scenario();
      const r = await run(s.owner, s.id);
      expect(r.status).toBe(201);
      const out = (await r.json()) as Run;
      expect(out.run.status).toBe("OPTIMAL");
      expect(out.run.notice).toContain(
        "Optimal only for the quotes recorded here",
      );
      expect(out.run.result.best).toMatchObject({
        quoteIds: [s.q2, s.q3].sort(),
        totalMinor: 44_000,
        surplusUnits: 0,
      });
      expect(out.run.result.best.requiresHumanApproval).toEqual([]); // 27,500 and 16,500 are under 30,000
      expect(out.run.result.alternatives.map((p) => p.quoteIds)).toEqual([
        [s.q1],
      ]);
      expect(out.run.snapshot.map((x) => x.quoteId).sort()).toEqual(
        [s.q1, s.q2, s.q3].sort(),
      );
      // a run commits nothing
      const led = await ledger(s.owner, s.id);
      expect([led.items.length, led.summary.exposureMinor]).toEqual([0, 0]);
      // reproducible: the same data with a new key gives the same answer and the same inputs digest
      const again = (await (await run(s.owner, s.id)).json()) as Run;
      expect(again.run.result.best).toEqual(out.run.result.best);
      const digests = await h.repo
        .sql`select distinct inputs_digest from mission_sourcing_runs where mission_id = ${s.id}`;
      expect(digests).toHaveLength(1);
      // immutable
      await expect(
        h.repo
          .sql`update mission_sourcing_runs set status = 'INFEASIBLE' where run_id = ${out.run.runId}`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`delete from mission_sourcing_runs where run_id = ${out.run.runId}`,
      ).rejects.toThrow();
      // tolerating up to six surplus units admits more alternatives (a 10-unit quote plus the 4-unit one, with 4 surplus)
      const tol = (await (
        await run(s.owner, s.id, { maxSurplusUnits: 6 })
      ).json()) as Run;
      expect(tol.run.result.alternatives.length).toBe(2);
    });

    it("only usable quotes are considered, and each left out says why: unqualified, superseded, incomplete, other currency, extras, too large, nothing asked for", async () => {
      const s = await scenario();
      const q4 = await addQuote(s.owner, s.id, s.s4, [
        { sku: "KB", q: 10, unit: 100 },
      ]); // cheap but s4 is not qualified
      const old = await addQuote(s.owner, s.id, s.s1, [
        { sku: "KB", q: 10, unit: 10 },
      ]);
      await addQuote(s.owner, s.id, s.s1, [{ sku: "KB", q: 10, unit: 5200 }], {
        supersedes: old,
      });
      const inc = await addQuote(
        s.owner,
        s.id,
        s.s2,
        [{ sku: "KB", q: 10, unit: 10 }],
        {},
        { basis: "UNKNOWN" },
      );
      const eur = await addQuote(
        s.owner,
        s.id,
        s.s2,
        [{ sku: "KB", q: 10, unit: 10 }],
        { currency: "EUR" },
      );
      const extras = await addQuote(s.owner, s.id, s.s3, [
        { sku: "KB", q: 10, unit: 10 },
        { sku: "MOUSE", q: 1, unit: 10 },
      ]);
      const big = await addQuote(s.owner, s.id, s.s3, [
        { sku: "KB", q: 10, unit: 7000 },
      ]); // 70,000 > 60,000
      const other = await addQuote(s.owner, s.id, s.s3, [
        { sku: "MOUSE", q: 3, unit: 10 },
      ]);
      const out = (await (await run(s.owner, s.id)).json()) as Run;
      expect(out.run.result.best.quoteIds).toEqual([s.q2, s.q3].sort());
      const why = Object.fromEntries(
        out.run.result.excluded.map((e) => [e.quoteId, e.reason]),
      );
      expect(why).toMatchObject({
        [q4]: "The supplier is not yet qualified.",
        [old]: "A newer quote replaced it.",
        [inc]: "Not complete: shipping unknown.",
        [eur]: "In EUR; no conversion is done.",
        [extras]: "Also contains items that were not asked for.",
        [big]: "Exceeds the contract's largest single commitment.",
        [other]: "Offers nothing that was asked for.",
      });
      expect(Object.keys(why)).not.toContain(s.q1);
      // a supplier who has FAILED is excluded even when qualification is not required
      await post(s.owner, `/v1/admin/org/suppliers/${s.s4}/facts`, {
        criterion: "IDENTITY",
        status: "FAILED",
        idempotencyKey: idemKey("f"),
      });
      const lax = (await (
        await run(s.owner, s.id, { requireQualified: false })
      ).json()) as Run;
      const why2 = Object.fromEntries(
        lax.run.result.excluded.map((e) => [e.quoteId, e.reason]),
      );
      expect(why2[q4]).toBe(
        "The supplier is not qualified (a failure or the contract bars it).",
      );
    });

    it("the budget and the largest commitment are enforced; an infeasible run says by how much", async () => {
      const s = await scenario();
      // use up most of the budget in the ledger: 150,000 - 60,000 - 49,000 = 41,000 left
      for (const amount of [60_000, 49_000]) {
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
        expect(
          (
            await post(
              s.owner,
              `/v1/admin/org/ledger/items/${c.item.itemId}/transition`,
              { to: "APPROVED", idempotencyKey: idemKey("t") },
            )
          ).status,
        ).toBe(200);
      }
      expect((await ledger(s.owner, s.id)).summary.availableMinor).toBe(41_000);
      const out = (await (await run(s.owner, s.id)).json()) as Run;
      expect(out.run.status).toBe("INFEASIBLE");
      expect(out.run.result.reasons).toEqual(["BUDGET_SHORTFALL:3000"]); // cheapest 44,000 - 41,000
      expect(out.run.result.cheapestWithoutBudgetMinor).toBe(44_000);
      // asking for more than all quotes offer
      const cov = (await (
        await run(s.owner, s.id, { demand: [{ sku: "KB", quantity: 500 }] })
      ).json()) as Run;
      expect(cov.run.result.reasons[0]).toMatch(/^COVERAGE:KB needs 500/u);
      // an infeasible run cannot be adopted
      const adopt = await post(
        s.owner,
        `/v1/admin/org/sourcing/runs/${out.run.runId}/adopt`,
        { idempotencyKey: idemKey("a") },
      );
      expect([
        adopt.status,
        ((await adopt.json()) as { reason: string }).reason,
      ]).toEqual([409, "RUN_NOT_ADOPTABLE"]);
    });

    it("permissions: agents need COMPARE to run and READ to list; people need the plan permission; keys are idempotent; tenants are separate; pause stops agents", async () => {
      const s = await scenario();
      const a = await run(s.a, s.id, {}, "/v1/agent/missions");
      expect(a.status).toBe(201);
      expect((await run(s.b, s.id, {}, "/v1/agent/missions")).status).toBe(403); // READ only
      expect((await run(s.c, s.id, {}, "/v1/agent/missions")).status).toBe(403);
      expect((await get(s.b, runPath(s.id, "/v1/agent/missions"))).status).toBe(
        200,
      );
      expect((await get(s.c, runPath(s.id, "/v1/agent/missions"))).status).toBe(
        403,
      );
      const dev = await h.member("DEVELOPER");
      expect((await run(dev, s.id)).status).toBe(403);
      expect((await get(dev, runPath(s.id))).status).toBe(200);
      expect((await run(s.owner, s.id, { demand: [] })).status).toBe(400);
      expect(
        (
          await run(s.owner, s.id, {
            demand: [
              { sku: "KB", quantity: 1 },
              { sku: "KB", quantity: 2 },
            ],
          })
        ).status,
      ).toBe(400);
      expect((await run(s.owner, s.id, { extra: 1 })).status).toBe(400);
      expect(
        (await run(s.owner, s.id, { quoteIds: [`qte_${"0".repeat(24)}`] }))
          .status,
      ).toBe(404);
      const key = idemKey("same");
      const first = (await (
        await run(s.owner, s.id, { idempotencyKey: key })
      ).json()) as Run;
      const again = (await (
        await run(s.owner, s.id, { idempotencyKey: key })
      ).json()) as Run;
      expect([first.replayed, again.replayed, again.run.runId]).toEqual([
        false,
        true,
        first.run.runId,
      ]);
      expect(
        (await run(s.owner, s.id, { idempotencyKey: key, maxSurplusUnits: 5 }))
          .status,
      ).toBe(409);
      const stranger = await h.ownerOf("org-other");
      expect((await get(stranger, runPath(s.id))).status).toBe(404);
      expect(
        (await get(stranger, `/v1/admin/org/sourcing/runs/${first.run.runId}`))
          .status,
      ).toBe(404);
      expect(
        (
          await post(
            stranger,
            `/v1/admin/org/sourcing/runs/${first.run.runId}/adopt`,
            { idempotencyKey: idemKey("a") },
          )
        ).status,
      ).toBe(404);
      expect(
        (await post(s.owner, "/v1/admin/org/pause", { reason: "t" })).status,
      ).toBe(200);
      expect((await run(s.a, s.id, {}, "/v1/agent/missions")).status).toBe(423);
      await post(s.owner, "/v1/admin/org/resume", {});
      // a subset of quotes can be named
      const sub = (await (
        await run(s.owner, s.id, { quoteIds: [s.q1] })
      ).json()) as Run;
      expect(sub.run.result.best.quoteIds).toEqual([s.q1]);
    });

    it("adopting is a person's idempotent act: the chosen quotes become QUOTED, budget-neutral ledger items; a stale quote stops it without recording an adoption", async () => {
      const s = await scenario();
      const out = (await (await run(s.owner, s.id)).json()) as Run;
      const adopt = (t: string) =>
        post(t, `/v1/admin/org/sourcing/runs/${out.run.runId}/adopt`, {
          idempotencyKey: idemKey("a"),
        });
      expect((await adopt(await h.member("DEVELOPER"))).status).toBe(403);
      expect(
        (
          await post(
            s.a,
            `/v1/admin/org/sourcing/runs/${out.run.runId}/adopt`,
            { idempotencyKey: idemKey("a") },
          )
        ).status,
      ).toBe(401);
      // the other half of the stale case is prepared first: q2 gets superseded after the run was recorded
      await addQuote(
        s.owner,
        s.id,
        s.s2,
        [{ sku: "KB", q: 6, unit: 4600 }],
        { supersedes: s.q2 },
        st(500),
      );
      const stale = await adopt(s.owner);
      const staleBody = (await stale.json()) as {
        reason: string;
        detail: string;
      };
      expect([stale.status, staleBody.reason]).toEqual([
        409,
        "ADOPTION_INCOMPLETE",
      ]);
      expect(staleBody.detail).toContain(`${s.q2}:QUOTE_SUPERSEDED`);
      expect(
        (
          (await (
            await get(s.owner, `/v1/admin/org/sourcing/runs/${out.run.runId}`)
          ).json()) as Run
        ).run.adopted,
      ).toBe(false);
      // a fresh run recommends from what is current, and adopting it works, twice
      const fresh = (await (await run(s.owner, s.id)).json()) as Run;
      expect(fresh.run.result.best.totalMinor).toBe(44_600); // 28,100 (the newer quote) + 16,500
      const go = () =>
        post(s.owner, `/v1/admin/org/sourcing/runs/${fresh.run.runId}/adopt`, {
          idempotencyKey: idemKey("a"),
        });
      const one = (await (await go()).json()) as {
        items: { quoteId: string; itemId: string }[];
        replayed: boolean;
      };
      const two = (await (await go()).json()) as {
        items: { quoteId: string; itemId: string }[];
        replayed: boolean;
      };
      expect([one.replayed, two.replayed]).toEqual([false, true]);
      expect(two.items).toEqual(one.items);
      const led = await ledger(s.owner, s.id);
      const quoted = led.items.filter(
        (i) => i.label.startsWith("Quote from") && i.stage === "QUOTED",
      );
      expect(quoted.map((i) => i.amountMinor).sort((x, y) => x - y)).toEqual([
        16_500, 28_100,
      ]);
      expect(led.summary.exposureMinor).toBe(0); // QUOTED holds no budget
      expect(
        (
          (await (
            await get(s.owner, `/v1/admin/org/sourcing/runs/${fresh.run.runId}`)
          ).json()) as Run
        ).run.adopted,
      ).toBe(true);
      await expect(
        h.repo
          .sql`delete from mission_sourcing_adoptions where run_id = ${fresh.run.runId}`,
      ).rejects.toThrow();
    });
  },
);
