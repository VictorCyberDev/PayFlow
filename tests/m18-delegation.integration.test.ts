import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  MAX_DELEGATION_DEPTH,
  PostgresDelegationRegistry,
} from "../src/network/delegation.js";

const url = process.env.TEST_DATABASE_URL;
const NOW = "2026-11-06T10:00:00.000Z";
const LATER = "2026-11-06T12:00:00.000Z";
const EXPIRES = "2026-11-07T10:00:00.000Z";
let seq = 0;
const nonce = () => `m18-nonce-${String(++seq).padStart(10, "0")}`;
const scope = (
  parent: string,
  child: string,
  over: Record<string, unknown> = {},
) => ({
  principalId: "principal-1",
  parentAgentId: parent,
  childAgentId: child,
  audience: "payflow-a2a-v1",
  actionKinds: ["PURCHASE", "INVOICE_SETTLEMENT"],
  currencies: ["USD", "EUR"],
  counterpartyIds: ["merchant-a", "merchant-b"],
  maxAmountMinor: 10_000,
  issuedAt: NOW,
  expiresAt: EXPIRES,
  nonce: nonce(),
  ...over,
});
const spend = (agentId: string, over: Record<string, unknown> = {}) => ({
  actionKind: "PURCHASE",
  currency: "USD",
  counterpartyId: "merchant-a",
  amountMinor: 500,
  agentId,
  now: LATER,
  ...over,
});

(url ? describe : describe.skip)(
  "M18 delegation chains (PostgreSQL): multi-hop attenuation, shared-budget conservation, revocation",
  () => {
    let repo: PostgresTrustRepository;
    let registry: PostgresDelegationRegistry;

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
      registry = new PostgresDelegationRegistry(repo.sql);
    });
    beforeEach(async () => {
      await repo.sql`delete from delegations`;
    });
    afterAll(async () => {
      await repo.close();
    });

    async function root(over: Record<string, unknown> = {}) {
      const r = await registry.issueRoot(scope("principal", "a1", over), NOW);
      if (!r.ok) throw new Error(r.reason);
      return r.delegationId;
    }
    async function hop(
      parent: string,
      from: string,
      to: string,
      over: Record<string, unknown> = {},
    ) {
      const r = await registry.delegate(parent, scope(from, to, over), NOW);
      if (!r.ok) throw new Error(r.reason);
      return r.delegationId;
    }

    it("a three-hop chain can only narrow: every widening is refused at the hop that tries it", async () => {
      const r = await root({ maxAmountMinor: 9_000 });
      const h1 = await hop(r, "a1", "a2", {
        maxAmountMinor: 6_000,
        currencies: ["USD"],
      });
      const refusals: Record<string, Record<string, unknown>> = {
        AMOUNT_WIDENED: { maxAmountMinor: 6_001 },
        CURRENCY_WIDENED: { currencies: ["USD", "EUR"] },
        COUNTERPARTY_WIDENED: { counterpartyIds: ["merchant-c"] },
        ACTION_KIND_WIDENED: { actionKinds: ["PAYOUT"] },
        EXPIRY_WIDENED: { expiresAt: "2026-11-08T10:00:00.000Z" },
        PRINCIPAL_CHANGED: { principalId: "someone-else" },
      };
      for (const [reason, over] of Object.entries(refusals))
        expect(
          await registry.delegate(
            h1,
            scope("a2", "a3", {
              maxAmountMinor: 6_000,
              currencies: ["USD"],
              ...over,
            }),
            NOW,
          ),
        ).toEqual({ ok: false, reason });
      // A hop that does not start at the previous hop's child is a broken chain, not a widening.
      expect(
        await registry.delegate(
          h1,
          scope("a1", "a3", { currencies: ["USD"] }),
          NOW,
        ),
      ).toEqual({ ok: false, reason: "PARENT_CHAIN_BROKEN" });
      const h2 = await hop(h1, "a2", "a3", {
        maxAmountMinor: 2_000,
        currencies: ["USD"],
      });
      expect(await registry.remaining(h2)).toBe(2_000);
    });

    it("the same delegation nonce cannot be used twice", async () => {
      const r = await root();
      const dup = scope("a1", "a2");
      expect((await registry.delegate(r, dup, NOW)).ok).toBe(true);
      expect(await registry.delegate(r, dup, NOW)).toEqual({
        ok: false,
        reason: "DUPLICATE_NONCE",
      });
    });

    it("depth is capped", async () => {
      let parent = await root();
      for (let i = 1; i <= MAX_DELEGATION_DEPTH; i++)
        parent = await hop(parent, `a${i}`, `a${i + 1}`);
      expect(
        await registry.delegate(
          parent,
          scope(`a${MAX_DELEGATION_DEPTH + 1}`, "x"),
          NOW,
        ),
      ).toEqual({ ok: false, reason: "DEPTH_EXCEEDED" });
    });

    it("spend is checked against kind, currency, counterparty, agent, cap and time on every hop", async () => {
      const r = await root();
      const leaf = await hop(r, "a1", "a2", {
        currencies: ["USD"],
        counterpartyIds: ["merchant-a"],
        actionKinds: ["PURCHASE"],
        maxAmountMinor: 3_000,
      });
      const cases: [Record<string, unknown>, string][] = [
        [{ actionKind: "PAYOUT" }, "ACTION_KIND_NOT_ALLOWED"],
        [{ currency: "EUR" }, "CURRENCY_NOT_ALLOWED"],
        [{ counterpartyId: "merchant-b" }, "COUNTERPARTY_NOT_ALLOWED"],
        [{ amountMinor: 3_001 }, "AMOUNT_EXCEEDS_CAP"],
        [{ agentId: "a1" }, "AGENT_MISMATCH"],
        [{ now: "2026-11-08T10:00:00.000Z" }, "EXPIRED"],
        [{ now: "2026-11-06T09:00:00.000Z" }, "NOT_YET_VALID"],
      ];
      for (const [over, reason] of cases)
        expect(await registry.reserve(leaf, spend("a2", over))).toEqual({
          ok: false,
          reason,
        });
      expect(
        await registry.reserve("dlg_000000000000000000000000", spend("a2")),
      ).toEqual({
        ok: false,
        reason: "NOT_FOUND",
      });
      expect(await registry.remaining(leaf)).toBe(3_000); // refusals charged nothing
      expect(await registry.reserve(leaf, spend("a2"))).toEqual({ ok: true });
    });

    it("conserves the shared budget under concurrent spending across a branching tree", async () => {
      // root cap 10_000; two branches and four leaves, each allowed the full 10_000 by attenuation.
      const r = await root();
      const b1 = await hop(r, "a1", "b1");
      const b2 = await hop(r, "a1", "b2");
      const leaves = [
        { id: await hop(b1, "b1", "c1"), agent: "c1" },
        { id: await hop(b1, "b1", "c2"), agent: "c2" },
        { id: await hop(b2, "b2", "c3"), agent: "c3" },
        { id: await hop(b2, "b2", "c4"), agent: "c4" },
      ];
      const attempts = Array.from({ length: 60 }, (_, i) => {
        const leaf = leaves[i % leaves.length]!;
        return registry
          .reserve(leaf.id, spend(leaf.agent))
          .then((x) => ({ ...x, leaf: leaf.id }));
      });
      const results = await Promise.all(attempts);
      const accepted = results.filter((x) => x.ok);
      // 10_000 / 500 = exactly 20 can ever be accepted, however the 60 requests interleave.
      expect(accepted).toHaveLength(20);
      expect(await registry.remaining(r)).toBe(0);
      const [row] = await repo.sql<
        { spent: string }[]
      >`select spent_minor::text spent from delegations where delegation_id = ${r}`;
      expect(Number(row!.spent)).toBe(20 * 500);
      // Every ancestor's spend equals the sum of its children's: nothing is created or lost.
      const sums = await repo.sql<
        { delegation_id: string; spent: string; children: string }[]
      >`
        select p.delegation_id, p.spent_minor::text spent,
               coalesce((select sum(c.spent_minor) from delegations c where c.parent_id = p.delegation_id),0)::text children
        from delegations p where exists (select 1 from delegations c where c.parent_id = p.delegation_id)`;
      for (const s of sums) expect(s.spent).toBe(s.children);
      expect(
        results
          .filter((x) => !x.ok)
          .every((x) => "reason" in x && x.reason === "BUDGET_EXHAUSTED"),
      ).toBe(true);
    });

    it("a tighter ancestor binds its descendants even when their own cap is larger", async () => {
      const r = await root({ maxAmountMinor: 1_000 });
      const leaf = await hop(r, "a1", "a2", { maxAmountMinor: 1_000 });
      expect(
        (await registry.reserve(leaf, spend("a2", { amountMinor: 600 }))).ok,
      ).toBe(true);
      expect(
        await registry.reserve(leaf, spend("a2", { amountMinor: 600 })),
      ).toEqual({
        ok: false,
        reason: "BUDGET_EXHAUSTED",
      });
    });

    it("revoking a middle hop stops it and everything beneath it, but not its siblings or its parent", async () => {
      const r = await root();
      const mid = await hop(r, "a1", "a2");
      const sibling = await hop(r, "a1", "a3");
      const below = await hop(mid, "a2", "a4");
      expect(await registry.revoke(mid, "compromised", NOW)).toBe(true);
      expect(await registry.revoke(mid, "again", NOW)).toBe(false);
      expect(await registry.reserve(mid, spend("a2"))).toEqual({
        ok: false,
        reason: "REVOKED",
      });
      expect(await registry.reserve(below, spend("a4"))).toEqual({
        ok: false,
        reason: "REVOKED",
      });
      expect(await registry.delegate(mid, scope("a2", "a9"), NOW)).toEqual({
        ok: false,
        reason: "PARENT_REVOKED",
      });
      expect(await registry.delegate(below, scope("a4", "a9"), NOW)).toEqual({
        ok: false,
        reason: "PARENT_REVOKED",
      });
      expect(await registry.reserve(sibling, spend("a3"))).toEqual({
        ok: true,
      });
      expect(await registry.reserve(r, spend("a1"))).toEqual({ ok: true });
    });

    it("release returns budget only to the chain it was charged to, and never below zero", async () => {
      const r = await root();
      const leaf = await hop(r, "a1", "a2");
      await registry.reserve(leaf, spend("a2", { amountMinor: 700 }));
      expect(await registry.remaining(r)).toBe(9_300);
      await registry.release(leaf, 700);
      expect(await registry.remaining(r)).toBe(10_000);
      await registry.release(leaf, 700); // a double release cannot mint budget
      expect(await registry.remaining(r)).toBe(10_000);
    });
  },
);
