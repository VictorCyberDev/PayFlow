import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  NegotiationDocSchema,
  checkMove,
  problemsWith,
  type Facts,
  type Move,
  type NegotiationDoc,
} from "../src/missions/negotiation.js";

/**
 * V3 M36 — negotiation rulebooks. The pure guard is checked rule by rule, at its boundaries, and against an independent
 * statement of the same rules on random inputs; the integration tests prove nothing is in force until a person approves it,
 * that approval re-checks the world, and that the guard follows the world (supplier, budget, time, revocation).
 */
const url = process.env.TEST_DATABASE_URL;
const NOW = "2026-10-23T10:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";
const doc = (over: Record<string, unknown> = {}): NegotiationDoc =>
  NegotiationDocSchema.parse({
    currency: "USD",
    targetTotalMinor: 40_000,
    walkAwayMinor: 50_000,
    terms: {
      minWarrantyMonths: 12,
      minReturnWindowDays: 14,
      maxDeliveryDays: 10,
      acceptablePaymentTerms: ["NET_30", "NET_45"],
    },
    concessions: { maxQuantityIncreasePercent: 10, mayExtendDeliveryDays: 2 },
    rounds: { maxRounds: 3 },
    negotiatorAgentId: "b",
    disclosure: { competingQuotes: false, deadline: false },
    expiresAt: LATER,
    ...over,
  });
const omit = (t: Move["terms"], k: keyof Move["terms"]) =>
  Object.fromEntries(
    Object.entries(t).filter(([x]) => x !== k),
  ) as Move["terms"];
const move = (over: Partial<Move> = {}): Move => ({
  kind: "COUNTER",
  round: 1,
  currency: "USD",
  totalMinor: 45_000,
  terms: {
    warrantyMonths: 12,
    returnWindowDays: 14,
    deliveryDays: 10,
    paymentTerms: "NET_30",
  },
  quantityIncreasePercent: 0,
  disclosing: [],
  ...over,
});

describe("M36 negotiation guard (pure)", () => {
  it("the schema refuses a document that could leak the budget or aim above its own ceiling", () => {
    expect(() => doc({ targetTotalMinor: 60_000 })).toThrow();
    expect(() => doc({ disclosure: { budget: true } })).toThrow();
    expect(() =>
      doc({ disclosure: { otherSuppliersIdentity: true } }),
    ).toThrow();
    expect(() => doc({ rounds: { maxRounds: 0 } })).toThrow();
    expect(() => doc({ rounds: { maxRounds: 11 } })).toThrow();
    expect(() => doc({ extra: 1 })).toThrow();
    expect(() => doc({ walkAwayMinor: 0 })).toThrow();
    expect(() => doc({ expiresAt: "tomorrow" })).toThrow();
    expect(() =>
      doc({ terms: { acceptablePaymentTerms: ["BARTER"] } }),
    ).toThrow();
    expect(doc().disclosure).toEqual({
      budget: false,
      otherSuppliersIdentity: false,
      competingQuotes: false,
      deadline: false,
    });
    expect(doc().acceptanceRule).toBe("PERSON_ALWAYS");
  });

  it("each rule refuses on its own, exactly at its boundary, and reasons accumulate", () => {
    const d = doc();
    const v = (m: Partial<Move>, dd = d) => checkMove(dd, move(m), NOW);
    expect(v({})).toEqual({ verdict: "ALLOW" });
    expect(v({ totalMinor: 50_000 }).verdict).toBe("ALLOW"); // exactly the walk-away
    expect(v({ totalMinor: 50_001 })).toEqual({
      verdict: "REFUSE",
      reasons: ["ABOVE_WALK_AWAY"],
    });
    expect(v({ totalMinor: 0 })).toMatchObject({
      verdict: "REFUSE",
      reasons: ["TOTAL_INVALID"],
    });
    expect(v({ round: 3 }).verdict).toBe("ALLOW");
    expect(v({ round: 4 })).toEqual({
      verdict: "REFUSE",
      reasons: ["ROUND_LIMIT"],
    });
    expect(v({ round: 0 })).toEqual({
      verdict: "REFUSE",
      reasons: ["ROUND_LIMIT"],
    });
    expect(v({ currency: "EUR" })).toEqual({
      verdict: "REFUSE",
      reasons: ["CURRENCY_MISMATCH"],
    });
    expect(checkMove(d, move(), LATER)).toEqual({
      verdict: "REFUSE",
      reasons: ["EXPIRED"],
    }); // the instant it expires
    expect(checkMove(d, move(), "2026-10-30T09:59:59.999Z").verdict).toBe(
      "ALLOW",
    );
    // term floors: at the floor is fine, below is not, and silence is not meeting a floor
    expect(
      v({
        terms: {
          warrantyMonths: 11,
          returnWindowDays: 14,
          deliveryDays: 10,
          paymentTerms: "NET_30",
        },
      }),
    ).toEqual({ verdict: "REFUSE", reasons: ["WARRANTY_BELOW_FLOOR"] });
    expect(
      v({
        terms: {
          returnWindowDays: 14,
          deliveryDays: 10,
          paymentTerms: "NET_30",
        },
      }),
    ).toEqual({ verdict: "REFUSE", reasons: ["WARRANTY_BELOW_FLOOR"] });
    expect(
      v({
        terms: {
          warrantyMonths: 12,
          returnWindowDays: 13,
          deliveryDays: 10,
          paymentTerms: "NET_30",
        },
      }).verdict,
    ).toBe("REFUSE");
    expect(
      v({
        terms: {
          warrantyMonths: 12,
          returnWindowDays: 14,
          deliveryDays: 12,
          paymentTerms: "NET_30",
        },
      }).verdict,
    ).toBe("ALLOW"); // 10 + 2 concession
    expect(
      v({
        terms: {
          warrantyMonths: 12,
          returnWindowDays: 14,
          deliveryDays: 13,
          paymentTerms: "NET_30",
        },
      }),
    ).toEqual({ verdict: "REFUSE", reasons: ["DELIVERY_TOO_LATE"] });
    expect(
      v({
        terms: {
          warrantyMonths: 12,
          returnWindowDays: 14,
          deliveryDays: 10,
          paymentTerms: "PREPAY",
        },
      }),
    ).toEqual({ verdict: "REFUSE", reasons: ["PAYMENT_TERMS_NOT_ACCEPTABLE"] });
    expect(
      v({
        terms: { warrantyMonths: 12, returnWindowDays: 14, deliveryDays: 10 },
      }).verdict,
    ).toBe("REFUSE");
    // quantity concession
    expect(v({ quantityIncreasePercent: 10 }).verdict).toBe("ALLOW");
    expect(v({ quantityIncreasePercent: 11 })).toEqual({
      verdict: "REFUSE",
      reasons: ["QUANTITY_INCREASE_NOT_ALLOWED"],
    });
    // disclosure: the budget and other suppliers' identities never; the rest only if the document allows
    expect(v({ disclosing: ["BUDGET"] })).toEqual({
      verdict: "REFUSE",
      reasons: ["DISCLOSURE_FORBIDDEN:BUDGET"],
    });
    expect(v({ disclosing: ["OTHER_SUPPLIERS_IDENTITY"] })).toEqual({
      verdict: "REFUSE",
      reasons: ["DISCLOSURE_FORBIDDEN:OTHER_SUPPLIERS_IDENTITY"],
    });
    expect(v({ disclosing: ["COMPETING_QUOTES"] })).toEqual({
      verdict: "REFUSE",
      reasons: ["DISCLOSURE_NOT_ALLOWED:COMPETING_QUOTES"],
    });
    expect(v({ disclosing: ["DEADLINE"] }).verdict).toBe("REFUSE");
    const open = doc({ disclosure: { competingQuotes: true, deadline: true } });
    expect(
      v({ disclosing: ["COMPETING_QUOTES", "DEADLINE"] }, open).verdict,
    ).toBe("ALLOW");
    expect(v({ disclosing: ["COMPETING_QUOTES", "BUDGET"] }, open)).toEqual({
      verdict: "REFUSE",
      reasons: ["DISCLOSURE_FORBIDDEN:BUDGET"],
    }); // allowed one does not launder the forbidden one
    // several broken rules are all reported
    const bad = v({
      totalMinor: 99_999,
      round: 9,
      quantityIncreasePercent: 50,
    });
    expect(bad.verdict === "REFUSE" && bad.reasons.sort()).toEqual([
      "ABOVE_WALK_AWAY",
      "QUANTITY_INCREASE_NOT_ALLOWED",
      "ROUND_LIMIT",
    ]);
  });

  it("accepting is a person's decision unless the approved rules say otherwise; the limits still apply either way", () => {
    expect(checkMove(doc(), move({ kind: "ACCEPT" }), NOW)).toEqual({
      verdict: "REQUIRES_PERSON",
      reasons: ["ACCEPTANCE_IS_A_PERSONS_DECISION"],
    });
    expect(
      checkMove(
        doc({ acceptanceRule: "AGENT_WITHIN_LIMITS" }),
        move({ kind: "ACCEPT" }),
        NOW,
      ),
    ).toEqual({ verdict: "ALLOW" });
    expect(
      checkMove(
        doc({ acceptanceRule: "AGENT_WITHIN_LIMITS" }),
        move({ kind: "ACCEPT", totalMinor: 50_001 }),
        NOW,
      ).verdict,
    ).toBe("REFUSE");
    // a refusal is never softened into "requires a person"
    expect(
      checkMove(doc(), move({ kind: "ACCEPT", totalMinor: 50_001 }), NOW)
        .verdict,
    ).toBe("REFUSE");
  });

  it("property: ALLOW and REQUIRES_PERSON happen exactly when an independent statement of the rules holds", () => {
    let seed = 31;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const pay = [
      "PREPAY",
      "ON_DELIVERY",
      "NET_15",
      "NET_30",
      "NET_45",
      "NET_60",
    ] as const;
    let allowed = 0;
    for (let i = 0; i < 1500; i++) {
      const d = doc({
        walkAwayMinor: 1000 + rnd(1000),
        targetTotalMinor: 500 + rnd(400),
        terms: {
          ...(rnd(2) ? { minWarrantyMonths: rnd(24) } : {}),
          ...(rnd(2) ? { minReturnWindowDays: rnd(30) } : {}),
          ...(rnd(2) ? { maxDeliveryDays: rnd(30) } : {}),
          acceptablePaymentTerms: rnd(2) ? [] : [pay[rnd(6)]!, pay[rnd(6)]!],
        },
        concessions: {
          maxQuantityIncreasePercent: rnd(20),
          mayExtendDeliveryDays: rnd(5),
        },
        rounds: { maxRounds: 1 + rnd(5) },
        acceptanceRule: rnd(2) ? "PERSON_ALWAYS" : "AGENT_WITHIN_LIMITS",
        disclosure: { competingQuotes: !!rnd(2), deadline: !!rnd(2) },
        expiresAt: rnd(15) === 0 ? "2026-10-23T09:00:00.000Z" : LATER,
      });
      const near = (x: number, spread: number) =>
        Math.max(0, x + rnd(2 * spread + 1) - spread);
      // Start from a move the document permits, then break about half of them in one or two random ways.
      const t0 = d.terms;
      const m: { -readonly [K in keyof Move]: Move[K] } = {
        kind: rnd(2) ? "COUNTER" : "ACCEPT",
        round: 1 + rnd(d.rounds.maxRounds),
        currency: "USD",
        totalMinor: 1 + rnd(d.walkAwayMinor),
        terms: {
          warrantyMonths: (t0.minWarrantyMonths ?? 0) + rnd(3),
          returnWindowDays: (t0.minReturnWindowDays ?? 0) + rnd(3),
          deliveryDays: Math.max(
            0,
            (t0.maxDeliveryDays ?? 20) +
              d.concessions.mayExtendDeliveryDays -
              rnd(3),
          ),
          paymentTerms: t0.acceptablePaymentTerms.length
            ? t0.acceptablePaymentTerms[rnd(t0.acceptablePaymentTerms.length)]!
            : pay[rnd(6)]!,
        },
        quantityIncreasePercent: rnd(
          d.concessions.maxQuantityIncreasePercent + 1,
        ),
        disclosing: [],
      };
      const breaks = rnd(2) ? 0 : 1 + rnd(2);
      for (let k = 0; k < breaks; k++) {
        const w = rnd(9);
        if (w === 0) m.totalMinor = near(d.walkAwayMinor, 3) + 1;
        else if (w === 1) m.round = rnd(8);
        else if (w === 2) m.currency = "EUR";
        else if (w === 3)
          m.terms = rnd(2)
            ? omit(m.terms, "warrantyMonths")
            : {
                ...m.terms,
                warrantyMonths: near(t0.minWarrantyMonths ?? 12, 2),
              };
        else if (w === 4)
          m.terms = {
            ...m.terms,
            deliveryDays: near(
              (t0.maxDeliveryDays ?? 10) + d.concessions.mayExtendDeliveryDays,
              2,
            ),
          };
        else if (w === 5) m.terms = { ...m.terms, paymentTerms: pay[rnd(6)]! };
        else if (w === 6)
          m.quantityIncreasePercent = near(
            d.concessions.maxQuantityIncreasePercent,
            2,
          );
        else if (w === 7)
          m.disclosing = [
            (
              [
                "BUDGET",
                "OTHER_SUPPLIERS_IDENTITY",
                "COMPETING_QUOTES",
                "DEADLINE",
              ] as const
            )[rnd(4)]!,
          ];
        else
          m.terms = rnd(2)
            ? omit(m.terms, "returnWindowDays")
            : {
                ...m.terms,
                returnWindowDays: near(t0.minReturnWindowDays ?? 14, 2),
              };
      }
      // the same rules, written differently
      const t = d.terms;
      const okTerms =
        (t.minWarrantyMonths === undefined ||
          (m.terms.warrantyMonths ?? -1) >= t.minWarrantyMonths) &&
        (t.minReturnWindowDays === undefined ||
          (m.terms.returnWindowDays ?? -1) >= t.minReturnWindowDays) &&
        (t.maxDeliveryDays === undefined ||
          (m.terms.deliveryDays ?? 1e9) <=
            t.maxDeliveryDays + d.concessions.mayExtendDeliveryDays) &&
        (t.acceptablePaymentTerms.length === 0 ||
          (m.terms.paymentTerms !== undefined &&
            t.acceptablePaymentTerms.includes(m.terms.paymentTerms)));
      const okDisclosure = m.disclosing.every((x) =>
        x === "COMPETING_QUOTES"
          ? d.disclosure.competingQuotes
          : x === "DEADLINE"
            ? d.disclosure.deadline
            : false,
      );
      const permitted =
        Date.parse(d.expiresAt) > Date.parse(NOW) &&
        m.currency === d.currency &&
        m.round >= 1 &&
        m.round <= d.rounds.maxRounds &&
        m.totalMinor >= 1 &&
        m.totalMinor <= d.walkAwayMinor &&
        okTerms &&
        m.quantityIncreasePercent <= d.concessions.maxQuantityIncreasePercent &&
        okDisclosure;
      const got = checkMove(d, m, NOW);
      expect(got.verdict !== "REFUSE", JSON.stringify({ d, m })).toBe(
        permitted,
      );
      if (permitted) {
        allowed++;
        expect(got.verdict).toBe(
          m.kind === "ACCEPT" && d.acceptanceRule === "PERSON_ALWAYS"
            ? "REQUIRES_PERSON"
            : "ALLOW",
        );
      }
    }
    expect(allowed).toBeGreaterThan(100);
  });

  it("a document is judged against the world: every problem has its own code", () => {
    const facts = (over: Partial<Facts> = {}): Facts => ({
      missionCurrency: "USD",
      maxCommitmentMinor: 60_000,
      availableMinor: 150_000,
      missionExpiresAt: "2026-11-23T10:00:00.000Z",
      agentMayNegotiate: (id) => id === "b",
      requireApprovalToContract: true,
      humanApprovalAboveMinor: 30_000,
      supplierQualified: true,
      baseline: null,
      ...over,
    });
    const p = (d: NegotiationDoc, f: Facts = facts()) =>
      problemsWith(d, f, NOW);
    expect(p(doc())).toEqual([]);
    expect(p(doc({ currency: "EUR" }))).toEqual(["CURRENCY_NOT_THE_MISSIONS"]);
    expect(p(doc({ walkAwayMinor: 60_001 }))).toEqual([
      "WALK_AWAY_ABOVE_LARGEST_COMMITMENT",
    ]);
    expect(p(doc(), facts({ availableMinor: 49_999 }))).toEqual([
      "WALK_AWAY_ABOVE_AVAILABLE_BUDGET",
    ]);
    expect(p(doc(), facts({ availableMinor: null }))).toEqual([]);
    expect(p(doc({ expiresAt: NOW }))).toEqual(["ALREADY_EXPIRED"]);
    expect(p(doc({ expiresAt: "2026-12-01T00:00:00.000Z" }))).toEqual([
      "OUTLIVES_THE_MISSION",
    ]);
    expect(p(doc({ negotiatorAgentId: "a" }))).toEqual([
      "NEGOTIATOR_LACKS_THE_NEGOTIATE_GRANT",
    ]);
    expect(p(doc(), facts({ supplierQualified: false }))).toEqual([
      "SUPPLIER_NOT_QUALIFIED",
    ]);
    expect(p(doc({ acceptanceRule: "AGENT_WITHIN_LIMITS" }))).toEqual([
      "MISSION_REQUIRES_A_PERSON_TO_CONTRACT",
      "WALK_AWAY_ABOVE_THE_HUMAN_APPROVAL_THRESHOLD",
    ]);
    expect(
      p(
        doc({ acceptanceRule: "AGENT_WITHIN_LIMITS" }),
        facts({ requireApprovalToContract: false }),
      ),
    ).toEqual(["WALK_AWAY_ABOVE_THE_HUMAN_APPROVAL_THRESHOLD"]);
    expect(
      p(
        doc({
          acceptanceRule: "AGENT_WITHIN_LIMITS",
          walkAwayMinor: 30_000,
          targetTotalMinor: 20_000,
        }),
        facts({ requireApprovalToContract: false }),
      ),
    ).toEqual([]);
    const q = "qte_" + "a".repeat(24);
    expect(
      p(
        doc({ baselineQuoteId: q }),
        facts({
          baseline: { exists: false, supplierMatches: false, current: false },
        }),
      ),
    ).toEqual(["BASELINE_QUOTE_NOT_FOUND"]);
    expect(
      p(
        doc({ baselineQuoteId: q }),
        facts({
          baseline: { exists: true, supplierMatches: false, current: false },
        }),
      ),
    ).toEqual([
      "BASELINE_QUOTE_IS_ANOTHER_SUPPLIERS",
      "BASELINE_QUOTE_NOT_CURRENT",
    ]);
  });
});

(url ? describe : describe.skip)(
  "M36 negotiation (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_sourcing_runs,mission_sourcing_adoptions,mission_negotiations,mission_negotiation_versions",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const mission = () =>
      activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          merchantRestrictions: { mode: "ONLY", ids: ["s1", "s2"] },
          maxCommitmentMinor: 60_000,
          expiresAt: "2026-11-23T10:00:00.000Z",
          agents: [
            {
              agentId: "a",
              capabilities: ["SEARCH", "READ", "COMPARE", "NEGOTIATE"],
            },
            { agentId: "b", capabilities: ["READ", "NEGOTIATE"] },
            { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
          ],
        }),
      );
    const supplier = async (
      owner: string,
      id: string,
      ref = "s1",
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
    const body = (
      supplierId: string,
      over: Record<string, unknown> = {},
      docOver: Record<string, unknown> = {},
    ) => ({
      supplierId,
      document: doc(docOver),
      idempotencyKey: idemKey("n"),
      ...over,
    });
    const propose = (
      t: string,
      id: string,
      b: unknown,
      base = "/v1/admin/org/missions",
    ) => post(t, `${base}/${id}/negotiations`, b);
    type Neg = {
      negotiationId: string;
      status: string;
      inForce: { version: number; document: NegotiationDoc } | null;
      pending: { version: number } | null;
      versions: { version: number; decision: string }[];
    };
    const list = async (t: string, id: string) =>
      (
        (await (
          await get(t, `/v1/admin/org/missions/${id}/negotiations`)
        ).json()) as { negotiations: Neg[]; notice: string }
      ).negotiations;
    const decide = (
      t: string,
      nid: string,
      v: number,
      what: "approve" | "reject",
      reason = "",
    ) =>
      post(t, `/v1/admin/org/negotiations/${nid}/versions/${v}/${what}`, {
        reason,
      });
    const check = (
      t: string,
      nid: string,
      m: Partial<Move> = {},
      base = "/v1/agent/negotiations",
    ) => post(t, `${base}/${nid}/check`, move(m));
    const verdictOf = async (r: Response) =>
      (await r.json()) as {
        verdict: { verdict: string; reasons?: string[] };
        version: number | null;
        negotiationStatus: string;
      };
    const reason = async (r: Response) =>
      (await r.json()) as { reason: string; detail?: string };
    const approvedNegotiation = async () => {
      const m = await mission();
      const sid = await supplier(m.owner, m.id);
      const p = (await (
        await propose(m.b, m.id, body(sid), "/v1/agent/missions")
      ).json()) as { negotiationId: string };
      expect(
        (await decide(m.owner, p.negotiationId, 1, "approve")).status,
      ).toBe(200);
      return { ...m, sid, nid: p.negotiationId };
    };

    it("nothing is in force until the owner approves; approval is the owner's alone; proposals are checked against the world", async () => {
      const { owner, a, b, c, id } = await mission();
      const sid = await supplier(owner, id);
      // an agent proposes rules for itself (needs the NEGOTIATE grant) and they wait
      const first = await propose(b, id, body(sid), "/v1/agent/missions");
      expect(first.status).toBe(201);
      const p = (await first.json()) as {
        negotiationId: string;
        version: number;
        warnings: string[];
      };
      expect([p.version, p.warnings]).toEqual([1, []]);
      let n = (await list(owner, id))[0]!;
      expect([n.status, n.inForce, n.pending?.version]).toEqual([
        "WAITING_FOR_A_PERSON",
        null,
        1,
      ]);
      expect(await list(owner, id)).toHaveLength(1);
      // a proposal for someone else, by an agent without the grant, or invalid, is refused
      expect(
        (
          await propose(
            a,
            id,
            body(sid, {}, { negotiatorAgentId: "b" }),
            "/v1/agent/missions",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await propose(
            c,
            id,
            body(sid, {}, { negotiatorAgentId: "c" }),
            "/v1/agent/missions",
          )
        ).status,
      ).toBe(403);
      const invalid = async (docOver: Record<string, unknown>) =>
        (await reason(await propose(owner, id, body(sid, {}, docOver)))).detail;
      expect(await invalid({ walkAwayMinor: 60_001 })).toBe(
        "WALK_AWAY_ABOVE_LARGEST_COMMITMENT",
      );
      expect(await invalid({ currency: "EUR" })).toBe(
        "CURRENCY_NOT_THE_MISSIONS",
      );
      expect(await invalid({ expiresAt: "2026-12-30T00:00:00.000Z" })).toBe(
        "OUTLIVES_THE_MISSION",
      );
      expect(await invalid({ expiresAt: "2026-10-22T00:00:00.000Z" })).toBe(
        "ALREADY_EXPIRED",
      );
      expect(await invalid({ negotiatorAgentId: "c" })).toBe(
        "NEGOTIATOR_LACKS_THE_NEGOTIATE_GRANT",
      );
      expect(
        await invalid({ acceptanceRule: "AGENT_WITHIN_LIMITS" }),
      ).toContain("MISSION_REQUIRES_A_PERSON_TO_CONTRACT");
      expect(await invalid({ baselineQuoteId: `qte_${"0".repeat(24)}` })).toBe(
        "BASELINE_QUOTE_NOT_FOUND",
      );
      expect(
        (
          await propose(owner, id, {
            ...body(sid),
            supplierId: `sup_${"0".repeat(24)}`,
          })
        ).status,
      ).toBe(404);
      expect(
        (await propose(owner, id, { ...body(sid), extra: 1 })).status,
      ).toBe(400);
      // approval: not the agent, not a finance admin, not a developer
      const fin = await h.member("FINANCE_ADMIN");
      const dev = await h.member("DEVELOPER");
      for (const who of [fin, dev])
        expect((await decide(who, p.negotiationId, 1, "approve")).status).toBe(
          403,
        );
      expect(
        (
          await post(
            b,
            `/v1/admin/org/negotiations/${p.negotiationId}/versions/1/approve`,
            {},
          )
        ).status,
      ).toBe(401);
      expect(
        (await decide(owner, p.negotiationId, 1, "approve", "looks right"))
          .status,
      ).toBe(200);
      n = (await list(owner, id))[0]!;
      expect([n.status, n.inForce?.version]).toEqual(["IN_FORCE", 1]);
      expect((await list(owner, id)).length).toBe(1);
      expect((await decide(owner, p.negotiationId, 1, "approve")).status).toBe(
        409,
      ); // already decided
      expect((await decide(owner, p.negotiationId, 9, "approve")).status).toBe(
        404,
      );
      const stranger = await h.ownerOf("org-other");
      expect(
        (await get(stranger, `/v1/admin/org/missions/${id}/negotiations`))
          .status,
      ).toBe(404);
      expect(
        (await decide(stranger, p.negotiationId, 1, "reject")).status,
      ).toBe(404);
    });

    it("an unqualified supplier can have rules prepared, with a warning, but the rules cannot take effect; approval re-checks the world", async () => {
      const { owner, b, id } = await mission();
      const sid = await supplier(owner, id, "s1", false);
      const r = await propose(b, id, body(sid), "/v1/agent/missions");
      const p = (await r.json()) as {
        negotiationId: string;
        warnings: string[];
      };
      expect([r.status, p.warnings]).toEqual([201, ["SUPPLIER_NOT_QUALIFIED"]]);
      const refused = await decide(owner, p.negotiationId, 1, "approve");
      expect([refused.status, (await reason(refused)).detail]).toEqual([
        422,
        "SUPPLIER_NOT_QUALIFIED",
      ]);
      // qualify, then approval works
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
      expect((await decide(owner, p.negotiationId, 1, "approve")).status).toBe(
        200,
      );
      // a revision proposed later is checked on approval against the budget as it is THEN
      const second = (await (
        await propose(
          b,
          id,
          body(sid, {}, { walkAwayMinor: 55_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number };
      for (const amount of [60_000, 40_000]) {
        const c = (await (
          await post(owner, `${MISSIONS}/${id}/ledger/items`, {
            kind: "GOODS",
            label: "held",
            amountMinor: amount,
            currency: "USD",
            stage: "QUOTED",
            idempotencyKey: idemKey("i"),
          })
        ).json()) as { item: { itemId: string } };
        await post(
          owner,
          `/v1/admin/org/ledger/items/${c.item.itemId}/transition`,
          { to: "APPROVED", idempotencyKey: idemKey("t") },
        );
      }
      // 150,000 - 100,000 = 50,000 available < 55,000
      const late = await decide(
        owner,
        p.negotiationId,
        second.version,
        "approve",
      );
      expect([late.status, (await reason(late)).detail]).toEqual([
        422,
        "WALK_AWAY_ABOVE_AVAILABLE_BUDGET",
      ]);
      expect(
        (
          await decide(
            owner,
            p.negotiationId,
            second.version,
            "reject",
            "too high now",
          )
        ).status,
      ).toBe(200);
    });

    it("a revision waits for a person while the approved version stays in force; then the new rules apply", async () => {
      const s = await approvedNegotiation();
      const stricter = (await (
        await propose(
          s.b,
          s.id,
          body(s.sid, {}, { walkAwayMinor: 46_000, targetTotalMinor: 40_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number; negotiationId: string };
      expect([stricter.version, stricter.negotiationId]).toEqual([2, s.nid]);
      const during = await verdictOf(
        await check(s.b, s.nid, { totalMinor: 48_000 }),
      );
      expect([during.verdict.verdict, during.version]).toEqual(["ALLOW", 1]); // still the approved v1
      expect((await decide(s.owner, s.nid, 2, "approve")).status).toBe(200);
      const after = await verdictOf(
        await check(s.b, s.nid, { totalMinor: 48_000 }),
      );
      expect([
        after.verdict.verdict,
        after.verdict.reasons,
        after.version,
      ]).toEqual(["REFUSE", ["ABOVE_WALK_AWAY"], 2]);
      // a rejected revision changes nothing
      const v3 = (await (
        await propose(
          s.b,
          s.id,
          body(s.sid, {}, { walkAwayMinor: 59_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number };
      expect((await decide(s.owner, s.nid, v3.version, "reject")).status).toBe(
        200,
      );
      expect(
        (await verdictOf(await check(s.b, s.nid, { totalMinor: 46_000 })))
          .version,
      ).toBe(2);
      const n = (await list(s.owner, s.id))[0]!;
      expect(n.versions.map((v) => v.decision)).toEqual([
        "APPROVED",
        "APPROVED",
        "REJECTED",
      ]);
      // idempotent proposals; a key reused for different rules is refused
      const key = idemKey("same");
      const one = (await (
        await propose(
          s.b,
          s.id,
          body(s.sid, { idempotencyKey: key }, { walkAwayMinor: 47_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number; replayed: boolean };
      const two = (await (
        await propose(
          s.b,
          s.id,
          body(s.sid, { idempotencyKey: key }, { walkAwayMinor: 47_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number; replayed: boolean };
      expect([one.replayed, two.replayed, two.version]).toEqual([
        false,
        true,
        one.version,
      ]);
      expect(
        (
          await propose(
            s.b,
            s.id,
            body(s.sid, { idempotencyKey: key }, { walkAwayMinor: 48_000 }),
            "/v1/agent/missions",
          )
        ).status,
      ).toBe(409);
    });

    it("the guard follows the world: only the named negotiator, no rules or revoked or expired rules refuse everything, and so do a lost qualification, a stopped mission and a budget that shrank", async () => {
      const s = await approvedNegotiation();
      const ok = await verdictOf(await check(s.b, s.nid));
      expect([ok.verdict, ok.negotiationStatus]).toEqual([
        { verdict: "ALLOW" },
        "IN_FORCE",
      ]);
      expect(
        (await verdictOf(await check(s.b, s.nid, { totalMinor: 50_001 })))
          .verdict,
      ).toEqual({ verdict: "REFUSE", reasons: ["ABOVE_WALK_AWAY"] });
      expect(
        (await verdictOf(await check(s.b, s.nid, { kind: "ACCEPT" }))).verdict
          .verdict,
      ).toBe("REQUIRES_PERSON");
      // the named negotiator only: a for-hire agent that also holds NEGOTIATE is not it; one without the grant is refused outright
      const other = await check(s.a, s.nid);
      expect([other.status, (await reason(other)).reason]).toEqual([
        403,
        "NOT_THE_NEGOTIATOR",
      ]);
      expect((await check(s.c, s.nid)).status).toBe(403);
      expect(
        (await check(s.owner, s.nid, {}, "/v1/admin/org/negotiations")).status,
      ).toBe(200); // a person may dry-run
      expect((await check(s.b, s.nid, { totalMinor: -1 })).status).toBe(400);
      // the budget moves under it: 150,000 - 120,000 = 30,000 available < 45,000
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
      expect(
        (await verdictOf(await check(s.b, s.nid, { totalMinor: 45_000 })))
          .verdict,
      ).toEqual({ verdict: "REFUSE", reasons: ["ABOVE_AVAILABLE_BUDGET"] });
      expect(
        (await verdictOf(await check(s.b, s.nid, { totalMinor: 25_000 })))
          .verdict.verdict,
      ).toBe("ALLOW");
      // the supplier loses its standing
      await post(s.owner, `/v1/admin/org/suppliers/${s.sid}/facts`, {
        criterion: "IDENTITY",
        status: "FAILED",
        idempotencyKey: idemKey("f"),
      });
      expect(
        (await verdictOf(await check(s.b, s.nid, { totalMinor: 25_000 })))
          .verdict,
      ).toEqual({
        verdict: "REFUSE",
        reasons: ["SUPPLIER_NO_LONGER_QUALIFIED"],
      });
    });

    it("revoking, pausing the mission and the clock each stop the rules at once; revocation is one-way and contained to the right roles", async () => {
      const s = await approvedNegotiation();
      const sec = await h.member("SECURITY_ADMIN");
      const dev = await h.member("DEVELOPER");
      // a stopped mission: nothing is in force
      expect(
        (await post(s.owner, `${MISSIONS}/${s.id}/pause`, { reason: "t" }))
          .status,
      ).toBe(200);
      const paused = await check(s.b, s.nid);
      expect([paused.status, (await reason(paused)).detail]).toEqual([
        403,
        "MISSION_PAUSED",
      ]);
      expect(
        (
          await verdictOf(
            await check(s.owner, s.nid, {}, "/v1/admin/org/negotiations"),
          )
        ).verdict,
      ).toEqual({
        verdict: "REFUSE",
        reasons: ["NO_RULES_IN_FORCE:MISSION_NOT_ACTIVE"],
      });
      await post(s.owner, `${MISSIONS}/${s.id}/resume`, {});
      expect((await verdictOf(await check(s.b, s.nid))).verdict.verdict).toBe(
        "ALLOW",
      );
      // revocation: security can contain it, a developer cannot, it is idempotent and final
      expect(
        (
          await post(dev, `/v1/admin/org/negotiations/${s.nid}/revoke`, {
            reason: "x",
          })
        ).status,
      ).toBe(403);
      const rev = (await (
        await post(sec, `/v1/admin/org/negotiations/${s.nid}/revoke`, {
          reason: "supplier complaint",
        })
      ).json()) as { revoked: boolean; replayed: boolean };
      const again = (await (
        await post(sec, `/v1/admin/org/negotiations/${s.nid}/revoke`, {})
      ).json()) as { replayed: boolean };
      expect([rev.revoked, rev.replayed, again.replayed]).toEqual([
        true,
        false,
        true,
      ]);
      expect((await verdictOf(await check(s.b, s.nid))).verdict).toEqual({
        verdict: "REFUSE",
        reasons: ["NO_RULES_IN_FORCE:REVOKED"],
      });
      const blocked = await propose(
        s.b,
        s.id,
        body(s.sid, {}, { walkAwayMinor: 41_000 }),
        "/v1/agent/missions",
      );
      expect([blocked.status, (await reason(blocked)).reason]).toEqual([
        409,
        "NEGOTIATION_REVOKED",
      ]);
      expect((await decide(s.owner, s.nid, 1, "approve")).status).toBe(409);
      await expect(
        h.repo
          .sql`update mission_negotiations set revoked_at = null, revoked_by = null where negotiation_id = ${s.nid}`,
      ).rejects.toThrow();
      // the clock: a fresh approved negotiation expires on its own
      const t = await approvedNegotiation();
      h.advance(8 * 86_400_000);
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
      expect((await list(later, t.id))[0]!.status).toBe("EXPIRED");
    });

    it("versions are immutable at the database: documents cannot be edited, decisions are final, nothing is deleted", async () => {
      const s = await approvedNegotiation();
      await expect(
        h.repo
          .sql`update mission_negotiation_versions set document = '{}'::jsonb where negotiation_id = ${s.nid} and version = 1`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`update mission_negotiation_versions set decision = 'REJECTED' where negotiation_id = ${s.nid} and version = 1`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`delete from mission_negotiation_versions where negotiation_id = ${s.nid}`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`delete from mission_negotiations where negotiation_id = ${s.nid}`,
      ).rejects.toThrow();
      const pend = (await (
        await propose(
          s.b,
          s.id,
          body(s.sid, {}, { walkAwayMinor: 41_000 }),
          "/v1/agent/missions",
        )
      ).json()) as { version: number };
      await expect(
        h.repo
          .sql`update mission_negotiation_versions set document_digest = ${"0".repeat(64)} where negotiation_id = ${s.nid} and version = ${pend.version}`,
      ).rejects.toThrow();
    });
  },
);
