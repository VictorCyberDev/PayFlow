import { describe, expect, it } from "vitest";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { hostHarness, DEMO_MERCHANT } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M29 — a Mission Contract compiled into the existing stored Authorities, against the real Gateway. The Trust Kernel remains the
 * only decision-maker: these tests prove that what the compiler produces is never broader than the contract, that agents without
 * PURCHASE hold nothing, and that stopping a mission stops its spending power at once.
 */
const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  "M29 Mission Authority Compiler (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates",
    });
    type Auth = {
      authorityId: string;
      agentId: string;
      category: string;
      missionVersion: number;
      allocationMinor: number;
      maxSingleTransactionMinor: number;
      status: string;
    };
    type Listing = {
      authorities: Auth[];
      notCompiled: { agentId: string | null; reason: string }[];
    };
    const buyContract = (over: Record<string, unknown> = {}) =>
      contract({
        spendingCategories: ["KEYBOARD"],
        agents: [
          { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE"] },
          { agentId: "b", capabilities: ["NEGOTIATE", "COMPARE"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
        ...over,
      });
    const listing = async (token: string, id: string) =>
      (await (
        await h.call(token, "GET", `${MISSIONS}/${id}/authorities`)
      ).json()) as Listing;
    const post = (token: string, path: string, payload: unknown = {}) =>
      h.call(token, "POST", path, payload);
    const buy = (
      token: string,
      authority: string,
      agent = "c",
      nonce = `m29-${Math.random().toString(36).slice(2)}-0123456789`,
    ) =>
      new PayFlowClient({
        baseUrl: h.origin,
        accessToken: token,
      }).actions.execute({
        item: "Quiet keyboard",
        amount: 8_400,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce,
        authority,
        agent,
      });
    const mandateRow = async (id: string) => {
      const [r] = await h.repo.sql<
        { document: Record<string, unknown>; revoked_at: string | null }[]
      >`select document, revoked_at from mandates where id = ${id}`;
      return r!;
    };

    it("approval compiles one Authority for the purchasing agent only, never broader than the contract", async () => {
      const c = buyContract();
      const { owner, id } = await activeMission(h, c);
      const l = await listing(owner, id);
      expect(l.authorities).toHaveLength(1);
      expect(l.authorities[0]).toMatchObject({
        agentId: "c",
        category: "KEYBOARD",
        status: "ACTIVE",
        missionVersion: 1,
        allocationMinor: 150_000,
        maxSingleTransactionMinor: 60_000,
      });
      const m = (await mandateRow(l.authorities[0]!.authorityId)).document;
      expect(m).toMatchObject({
        authorizedAgentId: "c",
        currency: "USD",
        category: "KEYBOARD",
        maxSingleTransactionMinor: 60_000,
        cumulativeLimitMinor: 150_000,
        autonomousPurchaseThresholdMinor: 30_000,
        humanApprovalThresholdMinor: 60_000,
        merchantScope: { mode: "ONLY", ids: [DEMO_MERCHANT] },
        allowedConditions: ["NEW"],
        expiresAt: "2026-11-23T10:00:00.000Z",
      });
      // Research and negotiation agents hold NO Authority.
      expect(l.authorities.map((a) => a.agentId)).toEqual(["c"]);
      const own = await h.repo
        .sql`select count(*)::int n from authority_ownership where mandate_id = ${l.authorities[0]!.authorityId}`;
      expect(own[0]!.n).toBe(1);
      // Compiling again is a no-op.
      await post(owner, `${MISSIONS}/${id}/approve`, { version: 1 }); // already decided: refused, and nothing duplicates
      expect((await listing(owner, id)).authorities).toHaveLength(1);
    });

    it("the purchasing agent pays through the real Gateway inside its Authority; research and negotiation agents cannot, even with its Authority id", async () => {
      const { owner, id, a, b, c } = await activeMission(h, buyContract());
      const auth = (await listing(owner, id)).authorities[0]!.authorityId;
      const paid = await buy(c, auth);
      expect(paid).toMatchObject({ status: "COMPLETED", effectCount: 1 });
      expect(h.provider.captureCalls).toBe(1);
      for (const [token, agent] of [
        [a, "a"],
        [b, "b"],
      ] as const) {
        const r = await buy(token, auth, agent);
        expect(r).toMatchObject({
          decision: "DENY",
          effectCount: 0,
          reason: "ACCESS_AGENT_MISMATCH",
        });
      }
      // The purchasing agent cannot present an agent id that is not its own either.
      expect(await buy(c, auth, "a")).toMatchObject({
        decision: "DENY",
        effectCount: 0,
      });
      expect(h.provider.captureCalls).toBe(1);
    });

    it("a smaller maximum commitment compiles into the Authority, and the Gateway refuses what the contract does not allow", async () => {
      const { owner, id, c } = await activeMission(
        h,
        buyContract({
          maxCommitmentMinor: 5_000,
          approvalConditions: { humanApprovalAboveMinor: 4_000 },
        }),
      );
      const l = await listing(owner, id);
      expect(l.authorities[0]!.maxSingleTransactionMinor).toBe(5_000);
      const r = await buy(c, l.authorities[0]!.authorityId);
      expect(r).toMatchObject({
        decision: "DENY",
        status: "DENIED",
        effectCount: 0,
        reason: "NO_OFFER_INSIDE_AUTHORITY",
      });
      expect(h.provider.createCalls + h.provider.captureCalls).toBe(0);
    });

    it("pausing, revoking, cancelling, completing or expiring a mission revokes its Authority at once; resuming compiles a fresh one that remembers what was spent", async () => {
      const { owner, id, c } = await activeMission(h, buyContract());
      const security = await h.member("SECURITY_ADMIN");
      const first = (await listing(owner, id)).authorities[0]!.authorityId;
      expect(await buy(c, first)).toMatchObject({ status: "COMPLETED" });
      expect(
        (await post(security, `${MISSIONS}/${id}/pause`, { reason: "review" }))
          .status,
      ).toBe(200);
      const paused = await listing(owner, id);
      expect(paused.authorities[0]).toMatchObject({
        authorityId: first,
        status: "REVOKED",
      });
      expect((await mandateRow(first)).revoked_at).not.toBeNull();
      expect(await buy(c, first)).toMatchObject({
        decision: "DENY",
        effectCount: 0,
        reason: "AUTHORITY_REVOKED",
      });
      expect(h.provider.captureCalls).toBe(1);
      // Resume: a NEW Authority, and the allocation is reduced by what the old one already used (no laundering by pausing).
      expect((await post(owner, `${MISSIONS}/${id}/resume`)).status).toBe(200);
      const resumed = await listing(owner, id);
      const fresh = resumed.authorities.find((a) => a.status === "ACTIVE")!;
      expect(fresh.authorityId).not.toBe(first);
      expect(fresh.allocationMinor).toBe(150_000 - 8_400);
      expect(
        resumed.authorities.filter((a) => a.status === "ACTIVE"),
      ).toHaveLength(1);
      // The Trust Kernel accepts the fresh Authority (ALLOW). The provider double can complete only one capture per instance, so the
      // outcome after ALLOW is the double's limit and is not asserted here; the first purchase above proved real completion.
      const again = await buy(c, fresh.authorityId);
      expect(again.decision).toBe("ALLOW");
      // Each ending revokes.
      for (const [op, body] of [
        ["cancel", {}],
        ["revoke", { reason: "stop" }],
      ] as const) {
        const m = await activeMission(h, buyContract());
        const a1 = (await listing(m.owner, m.id)).authorities[0]!.authorityId;
        expect(
          (await post(m.owner, `${MISSIONS}/${m.id}/${op}`, body)).status,
        ).toBe(200);
        expect((await mandateRow(a1)).revoked_at, op).not.toBeNull();
      }
      const done = await activeMission(h, buyContract());
      const a2 = (await listing(done.owner, done.id)).authorities[0]!
        .authorityId;
      expect(
        (await post(done.owner, `${MISSIONS}/${done.id}/complete`)).status,
      ).toBe(200);
      expect((await mandateRow(a2)).revoked_at).not.toBeNull();
    });

    it("a deadline revokes the Authority, and the Authority itself carries the same deadline", async () => {
      const { owner, id } = await activeMission(
        h,
        buyContract({ expiresAt: "2026-10-25T10:00:00.000Z" }),
      );
      const auth = (await listing(owner, id)).authorities[0]!.authorityId;
      expect(
        ((await mandateRow(auth)).document as { expiresAt: string }).expiresAt,
      ).toBe("2026-10-25T10:00:00.000Z");
      h.advance(3 * 24 * 3600 * 1000);
      await h.call(owner, "GET", `${MISSIONS}/${id}/plans`); // a read that applies the recorded expiry
      const l = await listing(owner, id);
      expect(l.authorities[0]).toMatchObject({ status: "REVOKED" });
      expect((await mandateRow(auth)).revoked_at).not.toBeNull();
    });

    it("a narrowing revision supersedes the Authority (old revoked, new tighter); a widening proposal changes nothing until an owner approves it", async () => {
      const { owner, id } = await activeMission(h, buyContract());
      const finance = await h.member("FINANCE_ADMIN");
      const before = (await listing(owner, id)).authorities[0]!.authorityId;
      const narrower = buyContract({
        totalBudgetMinor: 100_000,
        maxCommitmentMinor: 40_000,
      });
      expect(
        (
          await post(finance, `${MISSIONS}/${id}/revisions`, {
            baseVersion: 1,
            contract: narrower,
            idempotencyKey: idemKey("rv"),
          })
        ).status,
      ).toBe(201);
      let l = await listing(owner, id);
      expect(l.authorities.find((a) => a.authorityId === before)).toMatchObject(
        { status: "REVOKED" },
      );
      const now = l.authorities.find((a) => a.status === "ACTIVE")!;
      expect(now).toMatchObject({
        missionVersion: 2,
        allocationMinor: 100_000,
        maxSingleTransactionMinor: 40_000,
      });
      // Widening: stored as a proposal; the Authority in force is untouched.
      const wider = buyContract({
        totalBudgetMinor: 400_000,
        maxCommitmentMinor: 100_000,
      });
      expect(
        (
          await post(finance, `${MISSIONS}/${id}/revisions`, {
            baseVersion: 2,
            contract: wider,
            idempotencyKey: idemKey("rv"),
          })
        ).status,
      ).toBe(201);
      l = await listing(owner, id);
      expect(l.authorities.filter((a) => a.status === "ACTIVE")).toHaveLength(
        1,
      );
      expect(
        l.authorities.find((a) => a.status === "ACTIVE")!.authorityId,
      ).toBe(now.authorityId);
      expect(
        (await post(owner, `${MISSIONS}/${id}/approve`, { version: 3 })).status,
      ).toBe(200);
      l = await listing(owner, id);
      expect(l.authorities.find((a) => a.status === "ACTIVE")).toMatchObject({
        missionVersion: 3,
        allocationMinor: 400_000,
        maxSingleTransactionMinor: 100_000,
      });
    });

    it("what cannot be compiled is said plainly, and nothing is invented", async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        [
          "ANY merchant",
          { merchantRestrictions: { mode: "ANY" } },
          "MERCHANTS_NOT_ENUMERABLE",
        ],
        [
          "no merchants",
          { merchantRestrictions: { mode: "NONE_ALLOWED" } },
          "MERCHANTS_NOT_ENUMERABLE",
        ],
        ["no category", { spendingCategories: [] }, "NO_SPENDING_CATEGORY"],
        [
          "no buyer",
          { agents: [{ agentId: "a", capabilities: ["SEARCH"] }] },
          "NO_PURCHASING_AGENT",
        ],
      ];
      for (const [label, over, reason] of cases) {
        const { owner, id } = await activeMission(h, buyContract(over));
        const l = await listing(owner, id);
        expect(l.authorities, label).toEqual([]);
        expect(
          l.notCompiled.map((n) => n.reason),
          label,
        ).toContain(reason);
      }
      expect(
        (
          await h.repo
            .sql`select count(*)::int n from mandates where id like 'mission-authority-%'`
        )[0]!.n,
      ).toBe(0);
    });

    it("attenuation holds for many contracts: every compiled Authority is within its contract, and allocations sum to at most the budget", async () => {
      let seed = 7;
      const rnd = (n: number) =>
        (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
      await h.ownerOf();
      await h.agentToken("a");
      for (let i = 0; i < 8; i++) {
        const total = 50_000 + rnd(500_000);
        const maxCommit = 1_000 + rnd(total - 1_000);
        const cats = ["KEYBOARD", "MOUSE", "MONITOR"].slice(0, 1 + rnd(3));
        const buyers = rnd(2) ? ["a", "c"] : ["c"];
        const c = buyContract({
          totalBudgetMinor: total,
          maxCommitmentMinor: maxCommit,
          spendingCategories: cats,
          agents: buyers.map((agentId) => ({
            agentId,
            capabilities: ["PURCHASE"],
          })),
          approvalConditions: rnd(2)
            ? { humanApprovalAboveMinor: 1 + rnd(maxCommit) }
            : {},
        });
        const { owner, id } = await activeMission(h, c);
        const l = await listing(owner, id);
        expect(l.authorities).toHaveLength(buyers.length * cats.length);
        let sum = 0;
        for (const a of l.authorities) {
          const m = (await mandateRow(a.authorityId)).document as {
            maxSingleTransactionMinor: number;
            cumulativeLimitMinor: number;
            autonomousPurchaseThresholdMinor: number;
            humanApprovalThresholdMinor: number;
            expiresAt: string;
            merchantScope: { ids: string[] };
          };
          expect(m.maxSingleTransactionMinor).toBeLessThanOrEqual(maxCommit);
          expect(m.maxSingleTransactionMinor).toBeLessThanOrEqual(
            m.cumulativeLimitMinor,
          );
          expect(m.cumulativeLimitMinor).toBeLessThanOrEqual(total);
          expect(m.autonomousPurchaseThresholdMinor).toBeLessThanOrEqual(
            m.humanApprovalThresholdMinor,
          );
          expect(m.humanApprovalThresholdMinor).toBeLessThanOrEqual(
            m.maxSingleTransactionMinor,
          );
          expect(m.expiresAt).toBe(c.expiresAt);
          expect(m.merchantScope.ids).toEqual([DEMO_MERCHANT]);
          sum += m.cumulativeLimitMinor;
        }
        expect(sum).toBeLessThanOrEqual(total);
      }
    });

    it("revocation is atomic with the state change: if the Authority cannot be revoked, the mission is not paused", async () => {
      const { owner, id } = await activeMission(h, buyContract());
      const auth = (await listing(owner, id)).authorities[0]!.authorityId;
      await h.repo.sql.unsafe(
        `create function m29_block() returns trigger language plpgsql as $$ begin raise exception 'blocked'; end $$`,
      );
      await h.repo.sql.unsafe(
        `create trigger m29_block before update on mandates for each row execute function m29_block()`,
      );
      try {
        const r = await post(
          await h.member("SECURITY_ADMIN"),
          `${MISSIONS}/${id}/pause`,
        );
        expect(r.status).toBeGreaterThanOrEqual(500);
      } finally {
        await h.repo.sql.unsafe(`drop trigger m29_block on mandates`);
        await h.repo.sql.unsafe(`drop function m29_block()`);
      }
      // The mission is still ACTIVE and the Authority still ACTIVE: consistent, never "paused with spending power left".
      const m = (await (
        await h.call(owner, "GET", `${MISSIONS}/${id}`)
      ).json()) as { mission: { status: string } };
      expect(m.mission.status).toBe("ACTIVE");
      expect((await listing(owner, id)).authorities[0]).toMatchObject({
        authorityId: auth,
        status: "ACTIVE",
      });
      // And once the fault is gone the pause works and revokes.
      expect(
        (
          await post(
            await h.member("SECURITY_ADMIN"),
            `${MISSIONS}/${id}/pause`,
          )
        ).status,
      ).toBe(200);
      expect((await mandateRow(auth)).revoked_at).not.toBeNull();
    });

    it("is tenant isolated and read-only for non-owners", async () => {
      const { owner, id } = await activeMission(h, buyContract());
      expect(
        (
          await h.call(
            await h.ownerOf("org-other"),
            "GET",
            `${MISSIONS}/${id}/authorities`,
          )
        ).status,
      ).toBe(404);
      expect(
        (await h.call(null, "GET", `${MISSIONS}/${id}/authorities`)).status,
      ).toBe(401);
      for (const role of ["AUDITOR", "VIEWER", "DEVELOPER"])
        expect(
          (
            await h.call(
              await h.member(role),
              "GET",
              `${MISSIONS}/${id}/authorities`,
            )
          ).status,
          role,
        ).toBe(200);
      expect(
        (await post(owner, `${MISSIONS}/${id}/authorities`, {})).status,
      ).toBe(404); // there is no way to ask for an Authority directly
    });
  },
);
