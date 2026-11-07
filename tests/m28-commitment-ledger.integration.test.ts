import { describe, expect, it } from "vitest";
import {
  canMove,
  consumes,
  evidenceOk,
  exposureOf,
  STAGES,
  summarize,
  type Stage,
} from "../src/missions/ledger.js";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M28 — the mission commitment ledger. Pure accounting rules first, then the real host (PostgreSQL + HTTP). An INDEPENDENT
 * oracle recomputes exposure from the raw append-only entries, so a bug in the item-state bookkeeping cannot hide itself.
 */
const url = process.env.TEST_DATABASE_URL;

describe("M28 accounting rules (pure)", () => {
  it("only the stages that hold budget count, once, and refunds only reduce settled items", () => {
    const amount = 10_000;
    const expected: Record<Stage, number> = {
      ESTIMATED: 0,
      QUOTED: 0,
      APPROVED: amount,
      COMMITTED: amount,
      RESERVED: amount,
      IN_FLIGHT: amount,
      SETTLED: amount,
      UNKNOWN: amount,
      REFUNDED: 0,
      CANCELLED: 0,
      RELEASED: 0,
      FAILED: 0,
    };
    for (const s of STAGES)
      expect(
        exposureOf({ stage: s, amountMinor: amount, refundedMinor: 0 }),
        s,
      ).toBe(expected[s]);
    expect(
      exposureOf({
        stage: "SETTLED",
        amountMinor: amount,
        refundedMinor: 4_000,
      }),
    ).toBe(6_000);
    expect(
      exposureOf({
        stage: "QUOTED",
        amountMinor: amount,
        refundedMinor: 4_000,
      }),
    ).toBe(0);
    expect(STAGES.filter(consumes)).toEqual([
      "APPROVED",
      "COMMITTED",
      "RESERVED",
      "IN_FLIGHT",
      "SETTLED",
      "UNKNOWN",
    ]);
  });
  it("terminal stages never move; UNKNOWN resolves only to SETTLED or RELEASED; an in-flight payment cannot be cancelled", () => {
    for (const t of ["REFUNDED", "CANCELLED", "RELEASED", "FAILED"] as const)
      for (const to of STAGES)
        expect(canMove(t, to), `${t}->${to}`).toBe(false);
    expect(STAGES.filter((to) => canMove("UNKNOWN", to))).toEqual([
      "SETTLED",
      "RELEASED",
    ]);
    expect(canMove("IN_FLIGHT", "CANCELLED")).toBe(false);
    expect(canMove("QUOTED", "SETTLED")).toBe(false);
  });
  it("the legal moves are exactly this table, so a new path cannot appear by accident", () => {
    const legal: Record<Stage, Stage[]> = {
      ESTIMATED: ["QUOTED", "CANCELLED"],
      QUOTED: ["QUOTED", "APPROVED", "CANCELLED"],
      APPROVED: ["QUOTED", "COMMITTED", "RESERVED", "CANCELLED"],
      COMMITTED: ["RESERVED", "CANCELLED"],
      RESERVED: ["IN_FLIGHT", "CANCELLED"],
      IN_FLIGHT: ["SETTLED", "UNKNOWN", "FAILED"],
      UNKNOWN: ["SETTLED", "RELEASED"],
      SETTLED: ["REFUNDED"],
      REFUNDED: [],
      CANCELLED: [],
      RELEASED: [],
      FAILED: [],
    };
    for (const from of STAGES)
      expect(STAGES.filter((to) => canMove(from, to)).sort(), from).toEqual(
        [...legal[from]].sort(),
      );
  });
  it("evidence: outside facts need Proof or a provider; reservations need an Authority receipt; an agent's word is never enough", () => {
    expect(evidenceOk("SETTLED", "AGENT_REPORTED", "PAYFLOW_ENFORCED")).toBe(
      false,
    );
    expect(evidenceOk("SETTLED", "OWNER_REPORTED", "PAYFLOW_ENFORCED")).toBe(
      false,
    );
    expect(
      evidenceOk("SETTLED", "PROVIDER_CONFIRMATION", "PAYFLOW_ENFORCED"),
    ).toBe(true);
    expect(evidenceOk("SETTLED", "OWNER_REPORTED", "OWNER_REPORTED")).toBe(
      true,
    ); // an obligation recorded from outside PayFlow
    expect(evidenceOk("RESERVED", "NONE", "UNVERIFIED")).toBe(false);
    expect(
      evidenceOk("RESERVED", "PAYFLOW_AUTHORITY_RECEIPT", "UNVERIFIED"),
    ).toBe(true);
    expect(evidenceOk("QUOTED", "NONE", "UNVERIFIED")).toBe(true);
  });
  it("summaries separate unverified and UNKNOWN exposure and never report negative availability", () => {
    const s = summarize("USD", 100, [
      {
        stage: "COMMITTED",
        amountMinor: 60,
        refundedMinor: 0,
        verification: "OWNER_REPORTED",
      },
      {
        stage: "UNKNOWN",
        amountMinor: 30,
        refundedMinor: 0,
        verification: "PAYFLOW_ENFORCED",
      },
      {
        stage: "SETTLED",
        amountMinor: 50,
        refundedMinor: 20,
        verification: "PROVIDER_CONFIRMED",
      },
      {
        stage: "QUOTED",
        amountMinor: 999,
        refundedMinor: 0,
        verification: "UNVERIFIED",
      },
    ]);
    expect(s).toMatchObject({
      exposureMinor: 120,
      availableMinor: 0,
      unverifiedExposureMinor: 60,
      unknownExposureMinor: 30,
      refundedMinor: 20,
    });
  });
});

(url ? describe : describe.skip)(
  "M28 commitment ledger (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events",
    });
    type Item = {
      itemId: string;
      stage: Stage;
      amountMinor: number;
      refundedMinor: number;
      exposureMinor: number;
      verification: string;
      rowVersion: number;
      replayed?: boolean;
    };
    type Overview = {
      summary: {
        ceilingMinor: number;
        exposureMinor: number;
        availableMinor: number;
        overCommittedMinor: number;
        unverifiedExposureMinor: number;
        unknownExposureMinor: number;
        byStage: Record<string, { count: number; amountMinor: number }>;
      };
      items: Item[];
    };
    const post = (token: string, path: string, payload: unknown) =>
      h.call(token, "POST", path, payload);
    const create = (
      token: string,
      id: string,
      over: Record<string, unknown> = {},
      path = `${MISSIONS}/${id}/ledger/items`,
    ) =>
      post(token, path, {
        kind: "GOODS",
        label: "Quiet keyboard",
        amountMinor: 10_000,
        currency: "USD",
        idempotencyKey: idemKey("c"),
        ...over,
      });
    const item = async (r: Response) =>
      ((await r.json()) as { item: Item }).item;
    const move = (
      token: string,
      itemId: string,
      to: Stage,
      over: Record<string, unknown> = {},
    ) =>
      post(token, `/v1/admin/org/ledger/items/${itemId}/transition`, {
        to,
        idempotencyKey: idemKey("t"),
        ...over,
      });
    const overview = async (token: string, id: string) =>
      (await (
        await h.call(token, "GET", `${MISSIONS}/${id}/ledger`)
      ).json()) as Overview;
    const RECEIPT = {
      evidenceKind: "PAYFLOW_AUTHORITY_RECEIPT",
      evidence: { receipt: "rcpt-1" },
    };
    const PROVIDER = {
      evidenceKind: "PROVIDER_CONFIRMATION",
      evidence: { provider: "paypal-sandbox", id: "cap-1" },
    };
    /** Walk an item to a stage through the legal path with the evidence each move needs. */
    async function walk(token: string, itemId: string, path: Stage[]) {
      for (const to of path) {
        const ev = ["RESERVED", "IN_FLIGHT", "UNKNOWN"].includes(to)
          ? RECEIPT
          : ["SETTLED", "FAILED", "RELEASED", "REFUNDED"].includes(to)
            ? PROVIDER
            : {};
        const r = await move(token, itemId, to, ev);
        expect(r.status, `${to}: ${await r.clone().text()}`).toBe(200);
      }
    }
    /** The independent oracle: exposure recomputed from the append-only entries alone. */
    async function oracle(missionId: string) {
      const rows = await h.repo.sql`
      select distinct on (e.item_id) e.item_id, e.to_stage, e.amount_minor, e.refunded_minor
      from mission_ledger_entries e join mission_ledger_items i on i.item_id = e.item_id
      where i.mission_id = ${missionId} order by e.item_id, e.seq desc`;
      let total = 0;
      for (const r of rows) {
        const stage = String(r.to_stage);
        if (
          [
            "APPROVED",
            "COMMITTED",
            "RESERVED",
            "IN_FLIGHT",
            "UNKNOWN",
          ].includes(stage)
        )
          total += Number(r.amount_minor);
        else if (stage === "SETTLED")
          total += Number(r.amount_minor) - Number(r.refunded_minor);
      }
      return total;
    }

    it("an obligation is counted once as it moves estimate → quote → approval → commitment → reservation → payment → settlement", async () => {
      const { owner, id } = await activeMission(h);
      const created = await item(
        await create(owner, id, { amountMinor: 20_000 }),
      );
      expect((await overview(owner, id)).summary).toMatchObject({
        exposureMinor: 0,
        availableMinor: 150_000,
      });
      const seen: number[] = [];
      for (const [to, ev] of [
        ["QUOTED", {}],
        ["APPROVED", {}],
        ["COMMITTED", {}],
        ["RESERVED", RECEIPT],
        ["IN_FLIGHT", RECEIPT],
        ["SETTLED", PROVIDER],
      ] as [Stage, Record<string, unknown>][]) {
        expect((await move(owner, created.itemId, to, ev)).status, to).toBe(
          200,
        );
        const o = await overview(owner, id);
        seen.push(o.summary.exposureMinor);
        expect(o.summary.exposureMinor, to).toBe(await oracle(id));
      }
      expect(seen).toEqual([0, 20_000, 20_000, 20_000, 20_000, 20_000]);
      const o = await overview(owner, id);
      expect(o.items[0]).toMatchObject({
        stage: "SETTLED",
        verification: "PROVIDER_CONFIRMED",
      });
      const hist = (await (
        await h.call(
          owner,
          "GET",
          `/v1/admin/org/ledger/items/${created.itemId}/history`,
        )
      ).json()) as { entries: { to: string }[] };
      expect(hist.entries.map((e) => e.to)).toEqual([
        "ESTIMATED",
        "QUOTED",
        "APPROVED",
        "COMMITTED",
        "RESERVED",
        "IN_FLIGHT",
        "SETTLED",
      ]);
      await expect(
        h.repo
          .sql`update mission_ledger_entries set amount_minor = 1 where item_id = ${created.itemId}`,
      ).rejects.toThrow(/append-only/u);
    });

    it("capacity is exact: the ceiling can be filled to the last minor unit and not one over; cancelling frees it", async () => {
      const { owner, id } = await activeMission(h);
      const approve = async (amount: number) => {
        const it = await item(
          await create(owner, id, { amountMinor: amount, stage: "QUOTED" }),
        );
        return { it, r: await move(owner, it.itemId, "APPROVED") };
      };
      expect((await approve(60_001)).r.status).toBe(409); // above the maximum commitment
      expect(
        ((await (await approve(60_001)).r.json()) as { reason: string }).reason,
      ).toBe("ABOVE_MAX_COMMITMENT");
      const a = await approve(60_000);
      const b = await approve(60_000);
      expect([a.r.status, b.r.status]).toEqual([200, 200]);
      const c = await approve(40_000);
      expect(c.r.status).toBe(409);
      expect(((await c.r.json()) as { reason: string }).reason).toBe(
        "CAPACITY_EXCEEDED",
      );
      const d = await approve(30_000);
      expect(d.r.status).toBe(200);
      expect((await overview(owner, id)).summary).toMatchObject({
        exposureMinor: 150_000,
        availableMinor: 0,
      });
      const e = await approve(1);
      expect(e.r.status).toBe(409);
      // Cancel one commitment: capacity returns and the refused one can now proceed.
      expect((await move(owner, a.it.itemId, "CANCELLED")).status).toBe(200);
      expect((await overview(owner, id)).summary).toMatchObject({
        exposureMinor: 90_000,
        availableMinor: 60_000,
      });
      expect((await move(owner, c.it.itemId, "APPROVED")).status).toBe(200);
      expect((await overview(owner, id)).summary.exposureMinor).toBe(
        await oracle(id),
      );
    });

    it("concurrent approvals cannot overspend the shared ceiling, and the independent oracle agrees with the service", async () => {
      const { owner, id } = await activeMission(h);
      const ids: string[] = [];
      for (let i = 0; i < 12; i++)
        ids.push(
          (
            await item(
              await create(owner, id, {
                amountMinor: 20_000,
                stage: "QUOTED",
                label: `q${i}`,
              }),
            )
          ).itemId,
        );
      const results = await Promise.all(
        ids.map((itemId) => move(owner, itemId, "APPROVED")),
      );
      const ok = results.filter((r) => r.status === 200).length;
      expect(ok).toBe(7); // 7 x 20,000 = 140,000 <= 150,000 < 8 x 20,000
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const o = await overview(owner, id);
      expect(o.summary.exposureMinor).toBe(140_000);
      expect(await oracle(id)).toBe(140_000);
      expect(o.summary.exposureMinor).toBeLessThanOrEqual(
        o.summary.ceilingMinor,
      );
    });

    it("randomised concurrent operations never break conservation, and the oracle always matches", async () => {
      const { owner, id } = await activeMission(h);
      let seed = 20261107;
      const rnd = () =>
        (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const ids: string[] = [];
      for (let i = 0; i < 14; i++)
        ids.push(
          (
            await item(
              await create(owner, id, {
                amountMinor: 5_000 + Math.floor(rnd() * 5) * 5_000,
                stage: "QUOTED",
                label: `f${i}`,
              }),
            )
          ).itemId,
        );
      const plan: [Stage, Record<string, unknown>][] = [
        ["APPROVED", {}],
        ["COMMITTED", {}],
        ["RESERVED", RECEIPT],
        ["IN_FLIGHT", RECEIPT],
      ];
      for (let round = 0; round < 4; round++) {
        h.advance(61_000); // a fresh rate-limit window each round (the test clock is fixed)
        await Promise.all(
          ids.map(async (itemId) => {
            const [to, ev] = plan[Math.min(round, plan.length - 1)]!;
            if (rnd() < 0.2) return move(owner, itemId, "CANCELLED"); // some are cancelled mid-way
            return move(owner, itemId, to, ev);
          }),
        );
        const o = await overview(owner, id);
        expect(o.summary.exposureMinor).toBeLessThanOrEqual(150_000);
        expect(o.summary.exposureMinor).toBe(await oracle(id));
      }
      // Resolve everything still in flight, some as settled and some as unknown, concurrently.
      const o = await overview(owner, id);
      await Promise.all(
        o.items
          .filter((i) => i.stage === "IN_FLIGHT")
          .map((i, n) =>
            move(
              owner,
              i.itemId,
              n % 2 ? "SETTLED" : "UNKNOWN",
              n % 2 ? PROVIDER : RECEIPT,
            ),
          ),
      );
      const end = await overview(owner, id);
      expect(end.summary.exposureMinor).toBeLessThanOrEqual(150_000);
      expect(end.summary.exposureMinor).toBe(await oracle(id));
      expect(end.items.reduce((n, i) => n + i.exposureMinor, 0)).toBe(
        end.summary.exposureMinor,
      );
    });

    it("agents share the ceiling but can only estimate and quote; approval, commitment and money are not theirs", async () => {
      const { owner, id, a, b, c } = await activeMission(h);
      const agentPath = `/v1/agent/missions/${id}/ledger/items`;
      // a (SEARCH), b (NEGOTIATE) may quote; c holds neither SEARCH, COMPARE nor NEGOTIATE.
      const qa = await item(
        await create(
          a,
          id,
          { stage: "QUOTED", amountMinor: 55_000 },
          agentPath,
        ),
      );
      const qb = await item(
        await create(
          b,
          id,
          { stage: "QUOTED", amountMinor: 55_000 },
          agentPath,
        ),
      );
      expect(
        (await create(c, id, { stage: "ESTIMATED" }, agentPath)).status,
      ).toBe(403);
      // Not approval, commitment, or an item born past a quote.
      expect(
        (await create(a, id, { stage: "APPROVED" }, agentPath)).status,
      ).toBe(403);
      expect(
        (await create(a, id, { stage: "COMMITTED" }, agentPath)).status,
      ).toBe(403);
      const agentMove = (
        token: string,
        itemId: string,
        to: Stage,
        ev: Record<string, unknown> = {},
      ) =>
        post(token, `/v1/agent/ledger/items/${itemId}/transition`, {
          to,
          idempotencyKey: idemKey("t"),
          ...ev,
        });
      expect((await agentMove(a, qa.itemId, "APPROVED")).status).toBe(403);
      expect((await agentMove(a, qa.itemId, "SETTLED", PROVIDER)).status).toBe(
        403,
      );
      expect((await agentMove(b, qa.itemId, "QUOTED")).status).toBe(403); // not b's item
      expect(
        (await agentMove(a, qa.itemId, "QUOTED", { amountMinor: 50_000 }))
          .status,
      ).toBe(200); // its own re-quote
      expect(
        (
          await agentMove(a, qa.itemId, "QUOTED", {
            amountMinor: 52_000,
            evidenceKind: "PROVIDER_CONFIRMATION",
          })
        ).status,
      ).toBe(422); // an agent cannot present authoritative evidence
      // Agents see the capacity picture and only their own items.
      const view = (await (
        await h.call(a, "GET", `/v1/agent/missions/${id}/ledger`)
      ).json()) as {
        summary: { availableMinor: number };
        items: { itemId: string }[];
      };
      expect(view.items.map((i) => i.itemId)).toEqual([qa.itemId]);
      expect(view.summary.availableMinor).toBe(150_000);
      // The owner approves both quotes concurrently: together they fit (50,000 + 55,000), neither agent could take more than the ceiling.
      const both = await Promise.all([
        move(owner, qa.itemId, "APPROVED"),
        move(owner, qb.itemId, "APPROVED"),
      ]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect((await overview(owner, id)).summary.exposureMinor).toBe(105_000);
    });

    it("evidence and honesty: an agent's word never settles; an externally recorded obligation consumes budget but stays labelled", async () => {
      const { owner, id } = await activeMission(h);
      const it = await item(
        await create(owner, id, { amountMinor: 20_000, stage: "QUOTED" }),
      );
      await walk(owner, it.itemId, [
        "APPROVED",
        "COMMITTED",
        "RESERVED",
        "IN_FLIGHT",
      ]);
      // Owner-reported evidence cannot settle an item PayFlow itself enforced.
      for (const ev of [
        { evidenceKind: "OWNER_REPORTED" },
        { evidenceKind: "AGENT_REPORTED" },
        { evidenceKind: "NONE" },
      ])
        expect(
          (await move(owner, it.itemId, "SETTLED", ev)).status,
          JSON.stringify(ev),
        ).toBe(422);
      expect((await move(owner, it.itemId, "RESERVED", RECEIPT)).status).toBe(
        409,
      ); // cannot go backwards
      // A commitment recorded from OUTSIDE PayFlow (owner-reported) consumes budget, and is shown as unverified.
      const ext = await item(
        await create(owner, id, {
          amountMinor: 30_000,
          stage: "COMMITTED",
          verification: "OWNER_REPORTED",
          kind: "DEPOSIT",
          label: "Studio deposit",
        }),
      );
      expect(ext).toMatchObject({
        stage: "COMMITTED",
        verification: "OWNER_REPORTED",
        exposureMinor: 30_000,
      });
      let o = await overview(owner, id);
      expect(o.summary).toMatchObject({
        exposureMinor: 50_000,
        unverifiedExposureMinor: 30_000,
      });
      expect(
        (
          await move(owner, ext.itemId, "SETTLED", {
            evidenceKind: "OWNER_REPORTED",
          })
        ).status,
      ).toBe(200); // allowed for an external obligation
      o = await overview(owner, id);
      expect(o.items.find((i) => i.itemId === ext.itemId)).toMatchObject({
        verification: "OWNER_REPORTED",
      }); // never upgraded by the owner's own word
      // A provider confirmation upgrades it.
      const ext2 = await item(
        await create(owner, id, {
          amountMinor: 10_000,
          stage: "COMMITTED",
          verification: "OWNER_REPORTED",
          label: "x",
        }),
      );
      await move(owner, ext2.itemId, "RESERVED", RECEIPT);
      await move(owner, ext2.itemId, "IN_FLIGHT", RECEIPT);
      await move(owner, ext2.itemId, "SETTLED", PROVIDER);
      expect(
        (await overview(owner, id)).items.find((i) => i.itemId === ext2.itemId),
      ).toMatchObject({ verification: "PROVIDER_CONFIRMED" });
      // Items cannot be born in a money-moving stage by declaration.
      for (const stage of [
        "SETTLED",
        "RESERVED",
        "IN_FLIGHT",
        "UNKNOWN",
        "REFUNDED",
      ])
        expect((await create(owner, id, { stage })).status, stage).toBe(409);
    });

    it("UNKNOWN keeps consuming budget until evidence resolves it; it is never silently freed", async () => {
      const { owner, id } = await activeMission(h);
      const it = await item(
        await create(owner, id, { amountMinor: 40_000, stage: "QUOTED" }),
      );
      await walk(owner, it.itemId, [
        "APPROVED",
        "RESERVED",
        "IN_FLIGHT",
        "UNKNOWN",
      ]);
      let o = await overview(owner, id);
      expect(o.summary).toMatchObject({
        exposureMinor: 40_000,
        unknownExposureMinor: 40_000,
        availableMinor: 110_000,
      });
      expect((await move(owner, it.itemId, "FAILED", PROVIDER)).status).toBe(
        409,
      ); // UNKNOWN does not become FAILED directly
      expect((await move(owner, it.itemId, "CANCELLED")).status).toBe(409);
      expect(
        (
          await move(owner, it.itemId, "RELEASED", {
            evidenceKind: "OWNER_REPORTED",
          })
        ).status,
      ).toBe(422); // releasing needs provider or Proof evidence
      expect((await move(owner, it.itemId, "RELEASED", PROVIDER)).status).toBe(
        200,
      );
      o = await overview(owner, id);
      expect(o.summary).toMatchObject({
        exposureMinor: 0,
        unknownExposureMinor: 0,
      });
      expect(await oracle(id)).toBe(0);
      // The other resolution: UNKNOWN turned out to be settled.
      const it2 = await item(
        await create(owner, id, { amountMinor: 25_000, stage: "QUOTED" }),
      );
      await walk(owner, it2.itemId, [
        "APPROVED",
        "RESERVED",
        "IN_FLIGHT",
        "UNKNOWN",
        "SETTLED",
      ]);
      expect((await overview(owner, id)).summary).toMatchObject({
        exposureMinor: 25_000,
        unknownExposureMinor: 0,
      });
    });

    it("refunds are exact and idempotent: partial refunds free capacity, over-refund is refused, a repeated request is not a second refund", async () => {
      const { owner, id } = await activeMission(h);
      const it = await item(
        await create(owner, id, { amountMinor: 30_000, stage: "QUOTED" }),
      );
      await walk(owner, it.itemId, [
        "APPROVED",
        "RESERVED",
        "IN_FLIGHT",
        "SETTLED",
      ]);
      const refund = (amount: number, key: string) =>
        move(owner, it.itemId, "SETTLED", {
          refundMinor: amount,
          idempotencyKey: key,
          ...PROVIDER,
        });
      const k1 = idemKey("r");
      expect((await refund(10_000, k1)).status).toBe(200);
      expect((await refund(10_000, k1)).status).toBe(200); // replay
      expect((await overview(owner, id)).summary).toMatchObject({
        exposureMinor: 20_000,
        refundedMinor: 10_000,
      });
      expect((await refund(25_000, idemKey("r"))).status).toBe(409); // more than what remains
      expect(
        (
          await move(owner, it.itemId, "SETTLED", {
            refundMinor: 5_000,
            evidenceKind: "OWNER_REPORTED",
            idempotencyKey: idemKey("r"),
          })
        ).status,
      ).toBe(422);
      expect((await refund(20_000, idemKey("r"))).status).toBe(200);
      const done = (await overview(owner, id)).items[0]!;
      expect(done).toMatchObject({
        stage: "REFUNDED",
        exposureMinor: 0,
        refundedMinor: 30_000,
      });
      expect((await refund(1, idemKey("r"))).status).toBe(409);
      const hist = (await (
        await h.call(
          owner,
          "GET",
          `/v1/admin/org/ledger/items/${it.itemId}/history`,
        )
      ).json()) as { entries: unknown[] };
      expect(hist.entries).toHaveLength(7); // ESTIMATED..SETTLED (6) wait: QUOTED start + 4 moves + 2 refunds
      expect(await oracle(id)).toBe(0);
    });

    it("amounts are frozen once approved; a re-quote withdraws the approval, frees the capacity, and needs a new approval", async () => {
      const { owner, id } = await activeMission(h);
      const it = await item(
        await create(owner, id, { amountMinor: 30_000, stage: "QUOTED" }),
      );
      await move(owner, it.itemId, "APPROVED");
      expect(
        (await move(owner, it.itemId, "COMMITTED", { amountMinor: 31_000 }))
          .status,
      ).toBe(409);
      expect(
        (
          (await (
            await move(owner, it.itemId, "COMMITTED", { amountMinor: 31_000 })
          ).json()) as { reason: string }
        ).reason,
      ).toBe("AMOUNT_FROZEN");
      const requote = await move(owner, it.itemId, "QUOTED", {
        amountMinor: 35_000,
      });
      expect(requote.status).toBe(200);
      expect((await overview(owner, id)).summary.exposureMinor).toBe(0);
      expect((await move(owner, it.itemId, "APPROVED")).status).toBe(200);
      expect((await overview(owner, id)).summary.exposureMinor).toBe(35_000);
    });

    it("currency and mission state: no conversion ever happens; a paused mission cannot take on new commitments but can still settle and cancel", async () => {
      const { owner, id } = await activeMission(h);
      expect((await create(owner, id, { currency: "EUR" })).status).toBe(422);
      expect(
        (
          (await (await create(owner, id, { currency: "EUR" })).json()) as {
            reason: string;
          }
        ).reason,
      ).toBe("CURRENCY_MISMATCH");
      const live = await item(
        await create(owner, id, { amountMinor: 10_000, stage: "QUOTED" }),
      );
      await walk(owner, live.itemId, ["APPROVED", "RESERVED", "IN_FLIGHT"]);
      const waiting = await item(
        await create(owner, id, {
          amountMinor: 10_000,
          stage: "QUOTED",
          label: "w",
        }),
      );
      const security = await h.member("SECURITY_ADMIN");
      expect((await post(security, `${MISSIONS}/${id}/pause`, {})).status).toBe(
        200,
      );
      expect((await move(owner, waiting.itemId, "APPROVED")).status).toBe(409);
      expect(
        (
          (await (await move(owner, waiting.itemId, "APPROVED")).json()) as {
            reason: string;
          }
        ).reason,
      ).toBe("MISSION_NOT_ACTIVE");
      expect((await create(owner, id, { stage: "APPROVED" })).status).toBe(409);
      expect((await move(owner, live.itemId, "SETTLED", PROVIDER)).status).toBe(
        200,
      ); // the money truth continues while paused
      expect((await move(owner, waiting.itemId, "CANCELLED")).status).toBe(200);
    });

    it("narrowing the ceiling below existing exposure is visible as over-commitment and blocks new commitments, without erasing existing ones", async () => {
      const { owner, id } = await activeMission(h);
      const it = await item(
        await create(owner, id, { amountMinor: 50_000, stage: "QUOTED" }),
      );
      await move(owner, it.itemId, "APPROVED");
      const more = await item(
        await create(owner, id, {
          amountMinor: 40_000,
          stage: "QUOTED",
          label: "more",
        }),
      );
      await move(owner, more.itemId, "APPROVED");
      const narrower = contract({
        totalBudgetMinor: 70_000,
        maxCommitmentMinor: 50_000,
      });
      expect(
        (
          await post(owner, `${MISSIONS}/${id}/revisions`, {
            baseVersion: 1,
            contract: narrower,
            idempotencyKey: idemKey("rv"),
          })
        ).status,
      ).toBe(201);
      const o = await overview(owner, id);
      expect(o.summary).toMatchObject({
        ceilingMinor: 70_000,
        exposureMinor: 90_000,
        availableMinor: 0,
        overCommittedMinor: 20_000,
      });
      const third = await item(
        await create(owner, id, {
          amountMinor: 1_000,
          stage: "QUOTED",
          label: "t",
        }),
      );
      expect((await move(owner, third.itemId, "APPROVED")).status).toBe(409);
    });

    it("idempotency, tenant isolation, roles and restart", async () => {
      const { owner, id } = await activeMission(h);
      const key = idemKey("c");
      const first = await create(owner, id, { idempotencyKey: key });
      expect(first.status).toBe(201);
      const replay = await create(owner, id, { idempotencyKey: key });
      expect(replay.status).toBe(200);
      const firstItem = await item(first);
      expect((await item(replay)).itemId).toBe(firstItem.itemId);
      expect(
        (await create(owner, id, { idempotencyKey: key, amountMinor: 10_001 }))
          .status,
      ).toBe(409);
      expect((await overview(owner, id)).items).toHaveLength(1);
      const it = firstItem;
      const k = idemKey("t");
      expect(
        (await move(owner, it.itemId, "QUOTED", { idempotencyKey: k })).status,
      ).toBe(200);
      expect(
        (await move(owner, it.itemId, "QUOTED", { idempotencyKey: k })).status,
      ).toBe(200);
      expect(
        (await move(owner, it.itemId, "CANCELLED", { idempotencyKey: k }))
          .status,
      ).toBe(409); // same key, different request
      const [{ n }] = (await h.repo
        .sql`select count(*)::int n from mission_ledger_entries where item_id = ${it.itemId}`) as unknown as [
        { n: number },
      ];
      expect(n).toBe(2);
      // Tenant isolation.
      const theirs = await h.ownerOf("org-other");
      expect(
        (await h.call(theirs, "GET", `${MISSIONS}/${id}/ledger`)).status,
      ).toBe(404);
      expect((await move(theirs, it.itemId, "CANCELLED")).status).toBe(404);
      expect((await create(theirs, id)).status).toBe(404);
      // Roles.
      expect((await create(await h.member("FINANCE_ADMIN"), id)).status).toBe(
        201,
      );
      for (const role of [
        "AUDITOR",
        "VIEWER",
        "DEVELOPER",
        "SECURITY_ADMIN",
        "APPROVER",
      ]) {
        const t = await h.member(role);
        expect(
          (await h.call(t, "GET", `${MISSIONS}/${id}/ledger`)).status,
          `${role} read`,
        ).toBe(200);
        expect((await create(t, id)).status, `${role} write`).toBe(403);
      }
      expect(
        (await h.call(null, "GET", `${MISSIONS}/${id}/ledger`)).status,
      ).toBe(401);
      // Restart: everything is durable and the totals are unchanged.
      const before = await overview(owner, id);
      await h.restart();
      const after = await overview(await h.ownerOf(), id);
      expect(after.summary).toEqual(before.summary);
    });
  },
);
