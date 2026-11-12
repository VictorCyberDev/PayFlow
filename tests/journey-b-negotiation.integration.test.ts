/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";

/**
 * Journey B — negotiation, end to end, with both actors who really take part.
 *
 * ADR-018 section 16: Supplier -> Communication -> Counteroffer -> Approval -> Commitment.
 * The point of this journey is the boundary between them: an agent may PROPOSE the rules it would
 * negotiate under, and may ask whether a move is inside them, but it is a PERSON who puts those
 * rules in force and a person who takes them away. The agent is refused in both directions around
 * that approval, which is what makes "an agent cannot widen its own authority" a fact rather than a
 * claim.
 *
 * As in Journey A, the person holds only a session cookie and a CSRF token, and the agent holds only
 * the credential the app issued it. Nothing here uses an operator-minted token.
 */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "journey-b-customer-password";
const MERCHANT = "payflow.demo.merchant";

(url ? describe : describe.skip)(
  "Journey B: negotiation under rules a person put in force (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "rate_limit_windows,email_outbox,user_tokens,user_sessions,user_memberships,user_accounts," +
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities," +
        "mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps," +
        "mission_task_events,mandates,mission_suppliers,mission_supplier_facts," +
        "mission_qualification_policy,mission_quotes,mission_quote_ledger,mission_negotiations," +
        "mission_negotiation_versions,mission_supplier_contacts,mission_messages,mission_message_events",
    });
    let n = 0;
    const idem = (p: string) =>
      `${p}-journey-b-key-${String(++n).padStart(10, "0")}`;

    const customer = async () => {
      h.advance(61_000);
      const email = `journey-b-${++n}@example.com`;
      const up = await fetch(h.origin + "/v1/app/signup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({
          email,
          password: PASSWORD,
          displayName: "Bo",
          organizationName: "Bo Ltd",
        }),
      });
      expect(up.status, await up.clone().text()).toBe(201);
      const li = await fetch(h.origin + "/v1/app/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(li.status).toBe(200);
      const cookie = li.headers.get("set-cookie")!.split(";")[0]!;
      const me: any = await (
        await fetch(h.origin + "/v1/app/me", {
          headers: { cookie, origin: h.origin },
        })
      ).json();
      return { cookie, csrf: me.csrfToken as string };
    };
    /** The person, through the app. */
    const person = (
      c: { cookie: string; csrf: string },
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          origin: h.origin,
          cookie: c.cookie,
          "x-pf-csrf": c.csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    /** The agent, with the credential the app issued it. */
    const robot = (
      token: string,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) =>
      fetch(h.origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ok = async (
      r: Response,
      expected: number,
    ): Promise<Record<string, any>> => {
      expect(r.status, await r.clone().text()).toBe(expected);
      return (await r.json()) as Record<string, any>;
    };
    /** A counteroffer the agent would like to make. */
    const move = (totalMinor: number) => ({
      kind: "COUNTER",
      round: 1,
      currency: "USD",
      totalMinor,
      terms: {
        warrantyMonths: 12,
        returnWindowDays: 14,
        deliveryDays: 10,
        paymentTerms: "NET_30",
      },
      quantityIncreasePercent: 0,
      disclosing: [],
    });

    /** A qualified supplier, a contact for it, and proposed-but-not-approved negotiation rules. */
    const proposed = async () => {
      const c = await customer();
      const { agentId } = await ok(
        await person(c, "POST", "/v1/app/agents", {
          displayName: "Negotiator",
        }),
        201,
      );
      const { token } = await ok(
        await person(c, "POST", `/v1/app/agents/${agentId}/credentials`, {}),
        201,
      );
      const mission = await ok(
        await person(c, "POST", "/v1/admin/org/missions", {
          contract: {
            objective: "Equip the studio",
            intendedOutcome: "Delivered within budget",
            successCriteria: ["negotiated against a stated target"],
            currency: "USD",
            totalBudgetMinor: 150_000,
            maxCommitmentMinor: 60_000,
            spendingCategories: ["KEYBOARD"],
            approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
            merchantRestrictions: { mode: "ONLY", ids: [MERCHANT] },
            agents: [
              {
                agentId,
                capabilities: ["READ", "COMPARE", "NEGOTIATE", "COMMUNICATE"],
              },
            ],
            approvalConditions: { humanApprovalAboveMinor: 30_000 },
            expiresAt: "2026-11-23T10:00:00.000Z",
          },
          idempotencyKey: idem("m"),
        }),
        201,
      );
      const mid = mission.mission.missionId as string;
      await ok(
        await person(c, "POST", `/v1/admin/org/missions/${mid}/approve`, {
          version: 1,
        }),
        200,
      );
      const { supplierId } = await ok(
        await person(c, "POST", `/v1/admin/org/missions/${mid}/suppliers`, {
          externalRef: MERCHANT,
          displayName: "Demo Merchant",
        }),
        201,
      );
      for (const [criterion, evidenceKind, ref] of [
        ["IDENTITY", "OWNER_ATTESTATION"],
        ["PAYMENT_ACCEPTED", "OWNER_ATTESTATION"],
        ["RETURN_POLICY", "DOCUMENT_REF", "returns.pdf"],
      ] as const)
        await ok(
          await person(
            c,
            "POST",
            `/v1/admin/org/suppliers/${supplierId}/facts`,
            {
              criterion,
              status: "VERIFIED",
              evidenceKind,
              ...(ref ? { evidenceRef: ref } : {}),
              idempotencyKey: idem("f"),
            },
          ),
          201,
        );
      // Communication: the person records WHERE the supplier may be reached, and why they believe it.
      const contact = await ok(
        await person(
          c,
          "POST",
          `/v1/admin/org/suppliers/${supplierId}/contacts`,
          {
            address: "sales@demo.example",
            basis:
              "Listed on the supplier's website footer; confirmed by phone",
          },
        ),
        201,
      );
      expect(contact.contactId).toMatch(/^cnt_/u);
      // The AGENT proposes the rules it would negotiate under. Proposing is not permission.
      const prop = await ok(
        await robot(token, "POST", `/v1/agent/missions/${mid}/negotiations`, {
          supplierId,
          idempotencyKey: idem("n"),
          document: {
            currency: "USD",
            targetTotalMinor: 40_000,
            walkAwayMinor: 50_000,
            terms: { acceptablePaymentTerms: [] },
            concessions: {},
            rounds: { maxRounds: 3 },
            negotiatorAgentId: agentId,
            expiresAt: "2026-11-20T10:00:00.000Z",
          },
        }),
        201,
      );
      expect(prop.version).toBe(1);
      return { c, token, agentId, mid, supplierId, nid: prop.negotiationId };
    };
    const check = async (token: string, nid: string, totalMinor: number) =>
      ok(
        await robot(
          token,
          "POST",
          `/v1/agent/negotiations/${nid}/check`,
          move(totalMinor),
        ),
        200,
      );

    it("the agent cannot negotiate on rules it proposed until a person puts them in force", async () => {
      const s = await proposed();
      // Proposed, not approved: the answer is not "no such negotiation", it is "waiting for a person".
      const before = await check(s.token, s.nid, 45_000);
      expect(before.verdict).toMatchObject({ verdict: "REFUSE" });
      expect(before.verdict.reasons).toContain(
        "NO_RULES_IN_FORCE:WAITING_FOR_A_PERSON",
      );

      const approved = await ok(
        await person(
          s.c,
          "POST",
          `/v1/admin/org/negotiations/${s.nid}/versions/1/approve`,
          {},
        ),
        200,
      );
      expect(approved).toMatchObject({ version: 1, decision: "APPROVED" });

      const after = await check(s.token, s.nid, 45_000);
      expect(after).toMatchObject({
        verdict: { verdict: "ALLOW" },
        version: 1,
        negotiationStatus: "IN_FORCE",
      });
    });

    it("a move above the walk-away the person approved is refused, by name", async () => {
      const s = await proposed();
      await ok(
        await person(
          s.c,
          "POST",
          `/v1/admin/org/negotiations/${s.nid}/versions/1/approve`,
          {},
        ),
        200,
      );
      // 45_000 is inside the 50_000 walk-away; 55_000 is not, and the refusal says which rule.
      expect((await check(s.token, s.nid, 45_000)).verdict.verdict).toBe(
        "ALLOW",
      );
      const over = await check(s.token, s.nid, 55_000);
      expect(over.verdict).toMatchObject({ verdict: "REFUSE" });
      expect(over.verdict.reasons).toContain("ABOVE_WALK_AWAY");
    });

    it("the person can take the rules away again, and the agent stops immediately", async () => {
      const s = await proposed();
      await ok(
        await person(
          s.c,
          "POST",
          `/v1/admin/org/negotiations/${s.nid}/versions/1/approve`,
          {},
        ),
        200,
      );
      expect((await check(s.token, s.nid, 45_000)).verdict.verdict).toBe(
        "ALLOW",
      );
      const revoked = await ok(
        await person(
          s.c,
          "POST",
          `/v1/admin/org/negotiations/${s.nid}/revoke`,
          {},
        ),
        200,
      );
      expect(revoked.revoked).toBe(true);
      // The very same move that was allowed a moment ago is now refused, and says why.
      const after = await check(s.token, s.nid, 45_000);
      expect(after.verdict).toMatchObject({ verdict: "REFUSE" });
      expect(after.verdict.reasons).toContain("NO_RULES_IN_FORCE:REVOKED");
    });

    it("another organization's agent cannot read or act on these rules", async () => {
      const s = await proposed();
      await ok(
        await person(
          s.c,
          "POST",
          `/v1/admin/org/negotiations/${s.nid}/versions/1/approve`,
          {},
        ),
        200,
      );
      const stranger = await customer();
      const theirs = await ok(
        await person(stranger, "POST", "/v1/app/agents", {
          displayName: "Outsider",
        }),
        201,
      );
      const { token: theirToken } = await ok(
        await person(
          stranger,
          "POST",
          `/v1/app/agents/${theirs.agentId}/credentials`,
          {},
        ),
        201,
      );
      const r = await robot(
        theirToken,
        "POST",
        `/v1/agent/negotiations/${s.nid}/check`,
        move(45_000),
      );
      expect([401, 403, 404]).toContain(r.status);
      // And the person of another organization cannot approve or revoke them either.
      const approve = await person(
        stranger,
        "POST",
        `/v1/admin/org/negotiations/${s.nid}/versions/1/approve`,
        {},
      );
      expect([403, 404]).toContain(approve.status);
    });
  },
);
