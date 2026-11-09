/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { contract, idemKey, MISSIONS } from "./helpers/mission-fixtures.js";

/**
 * V3 M65 — approval quorum through the real Gateway on PostgreSQL. With no policy nothing changes. With one, a large mission needs approvals
 * from distinct owners other than the person who proposed it, and the mission stays out of force until enough have approved.
 */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M65 approval quorum (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate: TRUNCATE + ",org_quorum_policies,mission_approval_votes",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const second = async () => {
      const r = await post(await h.ownerOf(), "/v1/admin/members", {
        displayName: "second owner",
        role: "OWNER",
      });
      return ((await r.json()) as { token: string }).token;
    };
    const propose = async (t: string, over: Record<string, unknown> = {}) => {
      for (const g of ["a", "b", "c"]) await h.agentToken(g); // enrol the agents the contract names
      const r = await post(t, MISSIONS, {
        contract: contract(over),
        idempotencyKey: idemKey("m"),
      });
      if (r.status !== 201)
        throw new Error(JSON.stringify(await r.clone().json()));
      const id = (await body(r)).mission.missionId as string;
      return id;
    };
    const status = async (t: string, id: string) =>
      (await body(await h.call(t, "GET", `${MISSIONS}/${id}`))).mission
        .status as string;
    const policy = {
      tiers: [{ aboveMinor: 100_000, approvals: 2, roles: ["OWNER"] }],
    };

    it("with no policy one owner approves exactly as before", async () => {
      const a = await h.ownerOf();
      const id = await propose(a);
      expect(
        (await post(a, `${MISSIONS}/${id}/approve`, { version: 1 })).status,
      ).toBe(200);
      expect(await status(a, id)).toBe("ACTIVE");
    });

    it("the policy is set only with member:manage, must be valid, and can be removed", async () => {
      const a = await h.ownerOf();
      const dev = await h.member("DEVELOPER");
      expect(
        (await post(dev, "/v1/admin/org/quorum-policy", { policy })).status,
      ).toBe(403);
      expect(
        (
          await post(a, "/v1/admin/org/quorum-policy", {
            policy: { tiers: [] },
          })
        ).status,
      ).toBe(400);
      expect((await post(a, "/v1/admin/org/quorum-policy", {})).status).toBe(
        400,
      );
      const ok = await post(a, "/v1/admin/org/quorum-policy", { policy });
      expect(ok.status).toBe(200);
      expect(
        (await body(await h.call(a, "GET", "/v1/admin/org/quorum-policy")))
          .policy,
      ).toEqual(policy);
      expect(
        (await post(a, "/v1/admin/org/quorum-policy", { policy: null })).status,
      ).toBe(200);
      expect(
        (await body(await h.call(a, "GET", "/v1/admin/org/quorum-policy")))
          .policy,
      ).toBeNull();
    });

    it("a large mission waits: the proposer's own approval does not count, a repeat does not count twice, a second owner completes it", async () => {
      const a = await h.ownerOf();
      const b = await second();
      await post(a, "/v1/admin/org/quorum-policy", { policy });
      const id = await propose(a); // 150,000 minor: above the 100,000 threshold
      // proposer approves: recorded, but their own request never counts
      const first = await post(a, `${MISSIONS}/${id}/approve`, { version: 1 });
      expect(first.status).toBe(202);
      expect(await body(first)).toMatchObject({
        state: "WAITING_FOR_MORE_APPROVALS",
        required: 2,
        counted: 0,
      });
      expect(await status(a, id)).toBe("DRAFT"); // not in force
      // the other owner approves once, and again: still one
      const one = await post(b, `${MISSIONS}/${id}/approve`, { version: 1 });
      expect(await body(one)).toMatchObject({
        state: "WAITING_FOR_MORE_APPROVALS",
        counted: 1,
      });
      const again = await post(b, `${MISSIONS}/${id}/approve`, { version: 1 });
      expect(again.status).toBe(202);
      expect(await status(a, id)).toBe("DRAFT"); // not in force
      const votes = await h.repo
        .sql`select count(*)::int n from mission_approval_votes`;
      expect(votes[0]!.n).toBe(2); // one per member, however many times they pressed approve
      await expect(
        h.repo.sql`delete from mission_approval_votes`,
      ).rejects.toThrow(/append-only/);
    });

    it("with three owners two other than the proposer put it in force; a small mission is unaffected; a revoked owner's vote stops counting", async () => {
      const a = await h.ownerOf();
      const b = await second();
      const c = await second();
      await post(a, "/v1/admin/org/quorum-policy", { policy });
      const small = await propose(a, {
        totalBudgetMinor: 50_000,
        maxCommitmentMinor: 20_000,
        approvalConditions: { humanApprovalAboveMinor: 10_000 },
      });
      expect(
        (await post(a, `${MISSIONS}/${small}/approve`, { version: 1 })).status,
      ).toBe(200);
      const id = await propose(a);
      expect(
        (await post(b, `${MISSIONS}/${id}/approve`, { version: 1 })).status,
      ).toBe(202);
      // b is revoked after voting: that vote no longer counts
      const votes = await h.repo
        .sql`select member_id from mission_approval_votes`;
      const bId = String(votes[0]!.member_id);
      await h.repo
        .sql`update organization_members set status = 'REVOKED', revoked_at = now() where member_id = ${bId}`;
      const viaC = await post(c, `${MISSIONS}/${id}/approve`, { version: 1 });
      expect(viaC.status).toBe(202);
      expect(await body(viaC)).toMatchObject({ counted: 1 }); // only c: b's vote no longer counts
      expect(await status(a, id)).toBe("DRAFT"); // not in force
    });

    it("a mission is put in force once two distinct non-proposer owners have approved", async () => {
      const a = await h.ownerOf();
      const b = await second();
      const c = await second();
      await post(a, "/v1/admin/org/quorum-policy", { policy });
      const id = await propose(a);
      expect(
        (await post(b, `${MISSIONS}/${id}/approve`, { version: 1 })).status,
      ).toBe(202);
      const done = await post(c, `${MISSIONS}/${id}/approve`, { version: 1 });
      expect(done.status, JSON.stringify(await done.clone().json())).toBe(200);
      expect(await status(a, id)).toBe("ACTIVE");
    });
  },
);
