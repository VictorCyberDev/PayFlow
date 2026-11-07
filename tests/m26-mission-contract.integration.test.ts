import { describe, expect, it } from "vitest";
import { MissionService } from "../src/missions/service.js";
import {
  PayFlowAgentMissionClient,
  PayFlowMemberClient,
  type MissionContractInput,
} from "../packages/sdk-typescript/src/member.js";
import { hostHarness } from "./helpers/host-harness.js";

/**
 * V3 M26 — Mission Contract v1 against the real host: PostgreSQL, real HTTP, real member roles and real agent credentials.
 */
const url = process.env.TEST_DATABASE_URL;
const MISSIONS = "/v1/admin/org/missions";

(url ? describe : describe.skip)(
  "M26 Mission Contract (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,operational_alerts",
    });
    let n = 0;
    const key = () => `m26-idem-key-${String(++n).padStart(10, "0")}`;
    /** Direct service handle for the in-process permission gate later milestones call. */
    const gate = () =>
      new MissionService({
        sql: h.repo.sql,
        audit: { append: () => Promise.resolve() } as never,
        now: () => h.iso(),
      });

    const contract = (over: Record<string, unknown> = {}) => ({
      objective: "Find and buy equipment for the studio",
      intendedOutcome: "Equipment delivered within budget",
      successCriteria: ["Three comparable quotes", "Purchase under budget"],
      currency: "USD",
      totalBudgetMinor: 150_000,
      maxCommitmentMinor: 60_000,
      spendingCategories: ["EQUIPMENT"],
      approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      merchantRestrictions: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
      agents: [
        { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE"] },
        { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
      ],
      approvalConditions: { humanApprovalAboveMinor: 30_000 },
      expiresAt: "2026-11-23T10:00:00.000Z",
      ...over,
    });
    const enroll = async () => {
      await h.ownerOf();
      for (const id of ["a", "b", "c"]) await h.agentToken(id);
    };
    const create = async (
      token: string,
      c: unknown = contract(),
      idem = key(),
    ) => h.call(token, "POST", MISSIONS, { contract: c, idempotencyKey: idem });
    type M = {
      missionId: string;
      status: string;
      latestVersion: number;
      activeVersion: number | null;
      pendingVersion: number | null;
      rowVersion: number;
      pendingReasons: string[];
    };
    const body = async (r: Response) =>
      ((await r.json()) as { mission: M }).mission;
    const made = async (token?: string, c: unknown = contract()) => {
      const r = await create(token ?? (await h.ownerOf()), c);
      expect(r.status).toBe(201);
      return body(r);
    };
    const act = (
      token: string,
      id: string,
      op: string,
      payload: unknown = {},
    ) => h.call(token, "POST", `${MISSIONS}/${id}/${op}`, payload);
    const active = async () => {
      await enroll();
      const owner = await h.ownerOf();
      const m = await made(owner);
      expect(
        (await act(owner, m.missionId, "approve", { version: 1 })).status,
      ).toBe(200);
      return { owner, id: m.missionId };
    };
    const activeWith = async (c: unknown) => {
      await enroll();
      const owner = await h.ownerOf();
      const m = await made(owner, c);
      expect(
        (await act(owner, m.missionId, "approve", { version: 1 })).status,
      ).toBe(200);
      return { owner, id: m.missionId };
    };
    const revise = (
      token: string,
      id: string,
      base: number,
      c: unknown,
      idem = key(),
    ) =>
      act(token, id, "revisions", {
        baseVersion: base,
        contract: c,
        idempotencyKey: idem,
      });

    it("an authenticated owner creates a mission that persists as DRAFT, and the same request replays instead of duplicating", async () => {
      await enroll();
      const owner = await h.ownerOf();
      const idem = key();
      const first = await create(owner, contract(), idem);
      expect(first.status).toBe(201);
      const m = await body(first);
      expect(m).toMatchObject({
        status: "DRAFT",
        latestVersion: 1,
        activeVersion: null,
        pendingVersion: null,
      });
      expect(m.missionId).toMatch(/^msn_[a-f0-9]{24}$/u);
      const replay = await create(owner, contract(), idem);
      expect(replay.status).toBe(200);
      expect((await body(replay)).missionId).toBe(m.missionId);
      expect(
        (await create(owner, contract({ totalBudgetMinor: 150_001 }), idem))
          .status,
      ).toBe(409);
      const [{ n: count }] = (await h.repo
        .sql`select count(*)::int n from missions`) as unknown as [
        { n: number },
      ];
      expect(count).toBe(1);
      // It survives a restart of the host.
      await h.restart();
      const got = await h.call(
        await h.ownerOf(),
        "GET",
        `${MISSIONS}/${m.missionId}`,
      );
      expect(got.status).toBe(200);
    });

    it("only an owner approval puts a mission in force, and every step is an audited, append-only transition", async () => {
      await enroll();
      const owner = await h.ownerOf();
      const m = await made(owner);
      const finance = await h.member("FINANCE_ADMIN");
      expect(
        (await act(finance, m.missionId, "approve", { version: 1 })).status,
      ).toBe(403);
      expect(
        (await act(owner, m.missionId, "approve", { version: 2 })).status,
      ).toBe(409); // wrong version
      const ok = await act(owner, m.missionId, "approve", { version: 1 });
      expect(ok.status).toBe(200);
      expect(await body(ok)).toMatchObject({
        status: "ACTIVE",
        activeVersion: 1,
        pendingVersion: null,
      });
      const hist = (await (
        await h.call(owner, "GET", `${MISSIONS}/${m.missionId}/history`)
      ).json()) as {
        transitions: { event: string; to: string; actorKind: string }[];
        versions: { decision: string }[];
      };
      expect(hist.transitions.map((t) => t.event)).toEqual([
        "CREATED",
        "VERSION_APPROVED",
      ]);
      expect(hist.versions[0]).toMatchObject({ decision: "APPROVED" });
      const audit = await h.repo
        .sql`select action from organization_audit_events where subject_kind = 'MISSION' order by sequence`;
      expect(audit.map((a) => String(a.action))).toEqual([
        "MISSION_CREATED",
        "MISSION_VERSION_APPROVED",
        // The purchasing agent in this contract gets a compiled Authority on approval (M29).
        "MISSION_AUTHORITY_COMPILED",
      ]);
      // Immutable at the database: neither a contract nor a transition can be rewritten or removed.
      await expect(
        h.repo
          .sql`update mission_versions set contract = '{}'::jsonb where mission_id = ${m.missionId}`,
      ).rejects.toThrow(/immutable/u);
      await expect(
        h.repo
          .sql`delete from mission_transitions where mission_id = ${m.missionId}`,
      ).rejects.toThrow(/append-only/u);
      await expect(
        h.repo
          .sql`delete from mission_versions where mission_id = ${m.missionId}`,
      ).rejects.toThrow(/cannot be deleted/u);
    });

    it("an agent sees only the part of a mission it is assigned, and a research-only agent cannot spend", async () => {
      const { id } = await active();
      const research = await h.agentToken("a");
      const buyer = await h.agentToken("c");
      const stranger = await h.agentToken("b");
      const seenByResearch = (await (
        await h.call(research, "GET", "/v1/agent/missions")
      ).json()) as {
        missions: { missionId: string; myCapabilities: string[] }[];
      };
      expect(seenByResearch.missions).toHaveLength(1);
      expect(seenByResearch.missions[0]).toMatchObject({
        missionId: id,
        myCapabilities: ["COMPARE", "READ", "SEARCH"],
      });
      const raw = JSON.stringify(seenByResearch);
      expect(raw).not.toContain("PURCHASE"); // another agent's grants are not shown
      expect(raw).not.toContain("totalBudgetMinor");
      expect(
        (
          (await (
            await h.call(stranger, "GET", "/v1/agent/missions")
          ).json()) as { missions: unknown[] }
        ).missions,
      ).toEqual([]);
      expect(
        (await h.call(stranger, "GET", `/v1/agent/missions/${id}`)).status,
      ).toBe(404);
      const svc = gate();
      const tenant = {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX" as const,
      };
      expect(
        await svc.authorizeCapability(tenant, id, "a", "SEARCH"),
      ).toMatchObject({ allowed: true, version: 1 });
      expect(
        await svc.authorizeCapability(tenant, id, "a", "PURCHASE"),
      ).toEqual({ allowed: false, reason: "CAPABILITY_NOT_GRANTED" });
      expect(
        await svc.authorizeCapability(tenant, id, "c", "PURCHASE"),
      ).toMatchObject({ allowed: true });
      expect(await svc.authorizeCapability(tenant, id, "b", "SEARCH")).toEqual({
        allowed: false,
        reason: "AGENT_NOT_ASSIGNED",
      });
      expect(
        await svc.authorizeCapability(
          { ...tenant, organizationId: "other-org" },
          id,
          "a",
          "SEARCH",
        ),
      ).toEqual({ allowed: false, reason: "MISSION_NOT_FOUND" });
      void buyer;
    });

    it("a revision that only narrows takes effect; anything wider waits for an owner while the old version stays in force", async () => {
      const { owner, id } = await active();
      const finance = await h.member("FINANCE_ADMIN");
      const svc = gate();
      const tenant = {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX" as const,
      };
      // Narrowing: lower budget, fewer capabilities.
      const narrower = contract({
        totalBudgetMinor: 100_000,
        agents: [
          { agentId: "a", capabilities: ["SEARCH"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
      });
      const r2 = await revise(finance, id, 1, narrower);
      expect(r2.status).toBe(201);
      expect(await body(r2)).toMatchObject({
        activeVersion: 2,
        pendingVersion: null,
        latestVersion: 2,
      });
      expect(await svc.authorizeCapability(tenant, id, "a", "READ")).toEqual({
        allowed: false,
        reason: "CAPABILITY_NOT_GRANTED",
      });
      // Widening: budget up and a new capability for agent a.
      const wider = contract({
        totalBudgetMinor: 200_000,
        agents: [
          { agentId: "a", capabilities: ["SEARCH", "NEGOTIATE"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
      });
      const r3 = await revise(finance, id, 2, wider);
      expect(r3.status).toBe(201);
      const pending = await body(r3);
      expect(pending).toMatchObject({ activeVersion: 2, pendingVersion: 3 });
      expect(pending.pendingReasons).toEqual(
        expect.arrayContaining([
          "BUDGET_INCREASED",
          "CAPABILITY_ADDED:a:NEGOTIATE",
        ]),
      );
      // The pending proposal grants nothing yet.
      expect(
        await svc.authorizeCapability(tenant, id, "a", "NEGOTIATE"),
      ).toEqual({ allowed: false, reason: "CAPABILITY_NOT_GRANTED" });
      expect((await act(finance, id, "approve", { version: 3 })).status).toBe(
        403,
      );
      expect((await act(owner, id, "approve", { version: 2 })).status).toBe(
        409,
      );
      expect(
        await body(await act(owner, id, "approve", { version: 3 })),
      ).toMatchObject({ activeVersion: 3, pendingVersion: null });
      expect(
        await svc.authorizeCapability(tenant, id, "a", "NEGOTIATE"),
      ).toMatchObject({ allowed: true, version: 3 });
      // A rejected proposal never takes effect.
      const r4 = await revise(
        finance,
        id,
        3,
        contract({ totalBudgetMinor: 500_000, maxCommitmentMinor: 100_000 }),
      );
      expect((await body(r4)).pendingVersion).toBe(4);
      expect(
        await body(
          await act(owner, id, "reject", { version: 4, reason: "too high" }),
        ),
      ).toMatchObject({ activeVersion: 3, pendingVersion: null });
    });

    it("hidden widening is found: relaxed approval gates, extra merchants, longer deadlines, new providers and a different currency all need an owner", async () => {
      const { id } = await active();
      const finance = await h.member("FINANCE_ADMIN");
      let base = 1;
      const widenings: [string, Record<string, unknown>, string][] = [
        [
          "merchant",
          {
            merchantRestrictions: {
              mode: "ONLY",
              ids: ["payflow.demo.merchant", "evil.example"],
            },
          },
          "MERCHANT_ADDED:evil.example",
        ],
        [
          "unrestricted merchants",
          { merchantRestrictions: { mode: "ANY" } },
          "MERCHANTS_UNRESTRICTED",
        ],
        [
          "deadline",
          { expiresAt: "2026-12-23T10:00:00.000Z" },
          "EXPIRY_EXTENDED",
        ],
        [
          "provider",
          {
            approvedProviderTypes: [
              "COMMERCE_MARKETPLACE",
              "TALENT_MARKETPLACE",
            ],
          },
          "PROVIDER_TYPE_ADDED:TALENT_MARKETPLACE",
        ],
        [
          "category",
          { spendingCategories: ["EQUIPMENT", "TRAVEL"] },
          "CATEGORY_ADDED:TRAVEL",
        ],
        [
          "category restriction removed",
          { spendingCategories: [] },
          "CATEGORY_RESTRICTION_REMOVED",
        ],
        [
          "negotiation gate",
          {
            approvalConditions: {
              humanApprovalAboveMinor: 30_000,
              requireApprovalToNegotiate: false,
            },
          },
          "NEGOTIATION_APPROVAL_RELAXED",
        ],
        [
          "human threshold",
          { approvalConditions: { humanApprovalAboveMinor: 55_000 } },
          "HUMAN_APPROVAL_THRESHOLD_RAISED",
        ],
        ["currency", { currency: "EUR" }, "CURRENCY_CHANGED"],
        [
          "new agent",
          {
            agents: [
              { agentId: "a", capabilities: ["SEARCH", "READ", "COMPARE"] },
              { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
              { agentId: "b", capabilities: ["SEARCH"] },
            ],
          },
          "AGENT_ADDED:b",
        ],
        ["risk tier", { riskTier: "HIGH" }, "RISK_TIER_RAISED"],
      ];
      for (const [label, over, reason] of widenings) {
        const r = await revise(finance, id, base, contract(over));
        expect(r.status, label).toBe(201);
        const m = await body(r);
        expect(m.pendingReasons, label).toContain(reason);
        expect(m.activeVersion, label).toBe(1);
        base = m.latestVersion;
      }
    });

    it("stale writers lose: a revision must be based on the newest version, and concurrent editors cannot both win", async () => {
      const { id } = await active();
      const finance = await h.member("FINANCE_ADMIN");
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          revise(
            finance,
            id,
            1,
            contract({ totalBudgetMinor: 140_000 - i * 1_000 }),
          ),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(5);
      const [{ n: versions }] = (await h.repo
        .sql`select count(*)::int n from mission_versions where mission_id = ${id}`) as unknown as [
        { n: number },
      ];
      expect(versions).toBe(2);
      const stale = await revise(
        finance,
        id,
        1,
        contract({ totalBudgetMinor: 90_000 }),
      );
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { reason: string }).reason).toBe(
        "STALE_VERSION",
      );
      // The row version guards control operations too.
      const m = await body(
        await h.call(await h.ownerOf(), "GET", `${MISSIONS}/${id}`),
      );
      const staleControl = await act(await h.ownerOf(), id, "pause", {
        expectedRowVersion: m.rowVersion - 1,
      });
      expect(staleControl.status).toBe(409);
    });

    it("a model cannot approve itself or widen its own Authority: agents can only propose, and only where granted", async () => {
      const { owner, id } = await active();
      const buyer = await h.agentToken("c");
      const research = await h.agentToken("a");
      // The agent holding REQUEST_APPROVAL may propose; the proposal waits and changes nothing.
      const wider = contract({
        totalBudgetMinor: 900_000,
        maxCommitmentMinor: 800_000,
      });
      const proposed = await h.call(
        buyer,
        "POST",
        `/v1/agent/missions/${id}/revisions`,
        { baseVersion: 1, contract: wider, idempotencyKey: key() },
      );
      expect(proposed.status).toBe(202);
      const pm = (await proposed.json()) as { mission: M; applied: boolean };
      expect(pm.applied).toBe(false);
      expect(pm.mission).toMatchObject({ activeVersion: 1, pendingVersion: 2 });
      // A narrowing proposal from an agent ALSO waits: models never change Authority on their own.
      const narrowing = await h.call(
        buyer,
        "POST",
        `/v1/agent/missions/${id}/revisions`,
        {
          baseVersion: 2,
          contract: contract({ totalBudgetMinor: 100_000 }),
          idempotencyKey: key(),
        },
      );
      expect(
        ((await narrowing.json()) as { mission: M }).mission.activeVersion,
      ).toBe(1);
      // An agent without REQUEST_APPROVAL cannot even propose.
      expect(
        (
          await h.call(research, "POST", `/v1/agent/missions/${id}/revisions`, {
            baseVersion: 3,
            contract: wider,
            idempotencyKey: key(),
          })
        ).status,
      ).toBe(403);
      // An agent credential is not a member: it cannot approve, reject, pause or create through the member API.
      for (const op of ["approve", "reject", "pause", "revoke"])
        expect([401, 403]).toContain(
          (await act(buyer, id, op, { version: 3 })).status,
        );
      expect([401, 403]).toContain((await create(buyer)).status);
      // Defence in depth: even called in-process, the service itself refuses a decision from anything but a member.
      const svc = gate();
      const agentCaller = {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX" as const,
        id: "c",
        kind: "AGENT" as const,
      };
      expect(
        await svc.decide(agentCaller, id, { version: 2 }, "APPROVE"),
      ).toMatchObject({ ok: false, refusal: "NOT_ASSIGNED" });
      expect(await svc.control(agentCaller, id, {}, "revoke")).toMatchObject({
        ok: false,
      });
      // Smuggling authority through the body is refused by the strict schema, at the top level and nested.
      for (const smuggled of [
        { ...contract(), status: "ACTIVE" },
        { ...contract(), approved: true },
        {
          ...contract(),
          agents: [{ agentId: "a", capabilities: ["SEARCH"], approved: true }],
        },
        {
          ...contract(),
          approvalConditions: { humanApprovalAboveMinor: 1_000, owner: "me" },
        },
        { ...contract(), merchantRestrictions: { mode: "ANY", ids: ["x"] } },
      ])
        expect((await create(owner, smuggled)).status).toBe(422);
    });

    it("validation: bad money, bad shape, bad references and a past deadline are refused and store nothing", async () => {
      await enroll();
      const owner = await h.ownerOf();
      const bad: [string, Record<string, unknown>][] = [
        ["zero budget", { totalBudgetMinor: 0 }],
        ["negative budget", { totalBudgetMinor: -5 }],
        ["fractional budget", { totalBudgetMinor: 1000.5 }],
        ["overflow", { totalBudgetMinor: 1e15, maxCommitmentMinor: 1 }],
        ["unsafe integer", { totalBudgetMinor: 2 ** 60 }],
        ["lowercase currency", { currency: "usd" }],
        ["long currency", { currency: "USDX" }],
        ["commitment above budget", { maxCommitmentMinor: 200_000 }],
        [
          "threshold above commitment",
          { approvalConditions: { humanApprovalAboveMinor: 70_000 } },
        ],
        ["no success criteria", { successCriteria: [] }],
        [
          "unknown capability",
          { agents: [{ agentId: "a", capabilities: ["TELEPORT"] }] },
        ],
        [
          "duplicate agent",
          {
            agents: [
              { agentId: "a", capabilities: ["SEARCH"] },
              { agentId: "a", capabilities: ["READ"] },
            ],
          },
        ],
        [
          "empty capability list",
          { agents: [{ agentId: "a", capabilities: [] }] },
        ],
        ["bad country", { country: "usa" }],
        ["not a date", { expiresAt: "tomorrow" }],
        ["objective too long", { objective: "x".repeat(501) }],
      ];
      for (const [label, over] of bad)
        expect((await create(owner, contract(over))).status, label).toBe(422);
      expect(
        (
          await create(
            owner,
            contract({ expiresAt: "2026-10-01T00:00:00.000Z" }),
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await create(
            owner,
            contract({
              agents: [{ agentId: "ghost", capabilities: ["SEARCH"] }],
            }),
          )
        ).status,
      ).toBe(422);
      expect(
        (await h.call(owner, "POST", MISSIONS, { contract: contract() }))
          .status,
      ).toBe(400); // no idempotency key
      expect(
        (
          await h.call(owner, "POST", MISSIONS, {
            contract: contract(),
            idempotencyKey: key(),
            tenant: "other",
          })
        ).status,
      ).toBe(400);
      const [{ n: count }] = (await h.repo
        .sql`select count(*)::int n from missions`) as unknown as [
        { n: number },
      ];
      expect(count).toBe(0);
    });

    it("pause, resume, cancel, revoke and complete follow the state machine; containment fails closed for agents immediately", async () => {
      const { owner, id } = await active();
      const security = await h.member("SECURITY_ADMIN");
      const svc = gate();
      const tenant = {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX" as const,
      };
      expect((await act(owner, id, "resume")).status).toBe(409); // not paused
      expect(
        (await act(security, id, "pause", { reason: "suspicious" })).status,
      ).toBe(200);
      expect(
        await svc.authorizeCapability(tenant, id, "c", "PURCHASE"),
      ).toEqual({ allowed: false, reason: "MISSION_PAUSED" });
      expect(
        (
          (await (
            await h.call(await h.agentToken("a"), "GET", "/v1/agent/missions")
          ).json()) as { missions: unknown[] }
        ).missions,
      ).toEqual([]);
      expect((await act(security, id, "resume")).status).toBe(403); // containment is not release
      expect((await act(owner, id, "resume")).status).toBe(200);
      expect(
        await svc.authorizeCapability(tenant, id, "c", "PURCHASE"),
      ).toMatchObject({ allowed: true });
      expect((await act(owner, id, "complete")).status).toBe(200);
      for (const op of ["pause", "resume", "cancel", "revoke", "complete"])
        expect((await act(owner, id, op)).status, op).toBe(409);
      expect(
        await svc.authorizeCapability(tenant, id, "c", "PURCHASE"),
      ).toEqual({ allowed: false, reason: "MISSION_COMPLETED" });
      // Revoke is final and kills a mission that never became active too.
      const draft = await made(owner);
      expect(
        await body(
          await act(security, draft.missionId, "revoke", {
            reason: "compromised",
          }),
        ),
      ).toMatchObject({ status: "REVOKED" });
      expect(
        (await act(owner, draft.missionId, "approve", { version: 1 })).status,
      ).toBe(409);
      // Cancel from DRAFT; complete is illegal from DRAFT.
      const d2 = await made(owner);
      expect((await act(owner, d2.missionId, "complete")).status).toBe(409);
      expect(
        await body(await act(owner, d2.missionId, "cancel")),
      ).toMatchObject({ status: "CANCELLED" });
    });

    it("a mission past its deadline expires (recorded by the system), grants nothing, and cannot be resumed", async () => {
      const { owner, id } = await activeWith(
        contract({ expiresAt: "2026-10-25T10:00:00.000Z" }),
      );
      h.advance(3 * 24 * 3600 * 1000); // past the 2026-10-25 deadline, inside the member token life
      const svc = gate();
      const tenant = {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX" as const,
      };
      expect(
        await svc.authorizeCapability(tenant, id, "c", "PURCHASE"),
      ).toEqual({ allowed: false, reason: "MISSION_EXPIRED" });
      const m = await body(await h.call(owner, "GET", `${MISSIONS}/${id}`));
      expect(m.status).toBe("EXPIRED");
      const hist = (await (
        await h.call(owner, "GET", `${MISSIONS}/${id}/history`)
      ).json()) as { transitions: { event: string; actorKind: string }[] };
      expect(hist.transitions.at(-1)).toMatchObject({
        event: "DEADLINE_PASSED",
        actorKind: "SYSTEM",
      });
      expect((await act(owner, id, "resume")).status).toBe(409);
      expect(await svc.expireDue()).toBe(0); // idempotent
    });

    it("is tenant and environment isolated, and enforces roles on the server", async () => {
      await enroll();
      const owner = await h.ownerOf();
      const m = await made(owner);
      const theirs = await h.ownerOf("org-other");
      for (const [method, path] of [
        ["GET", `${MISSIONS}/${m.missionId}`],
        ["GET", `${MISSIONS}/${m.missionId}/history`],
      ] as const)
        expect((await h.call(theirs, method, path)).status).toBe(404);
      for (const op of ["approve", "pause", "cancel", "revoke", "submit"])
        expect(
          (
            await act(
              theirs,
              m.missionId,
              op,
              op === "approve" ? { version: 1 } : {},
            )
          ).status,
          op,
        ).toBe(404);
      expect((await revise(theirs, m.missionId, 1, contract())).status).toBe(
        404,
      );
      expect(
        (
          (await (await h.call(theirs, "GET", MISSIONS)).json()) as {
            missions: unknown[];
          }
        ).missions,
      ).toEqual([]);
      // Same organization, other environment.
      const r = await h.call(
        "harness-gateway-admin-secret-".repeat(3),
        "POST",
        "/v1/admin/members",
        {
          organizationId: "payflow-sandbox",
          environment: "PRODUCTION",
          displayName: "prod owner",
          role: "OWNER",
        },
      );
      const prod = ((await r.json()) as { token: string }).token;
      expect(
        (await h.call(prod, "GET", `${MISSIONS}/${m.missionId}`)).status,
      ).toBe(404);
      // Role matrix.
      const roles: Record<string, { create: number; view: number }> = {
        FINANCE_ADMIN: { create: 201, view: 200 },
        SECURITY_ADMIN: { create: 403, view: 200 },
        DEVELOPER: { create: 403, view: 200 },
        APPROVER: { create: 403, view: 200 },
        AUDITOR: { create: 403, view: 200 },
        VIEWER: { create: 403, view: 200 },
      };
      for (const [role, want] of Object.entries(roles)) {
        const t = await h.member(role);
        expect((await create(t)).status, `${role} create`).toBe(want.create);
        expect((await h.call(t, "GET", MISSIONS)).status, `${role} view`).toBe(
          want.view,
        );
      }
      expect((await h.call(null, "GET", MISSIONS)).status).toBe(401);
      expect(
        (
          await create(
            await (async () =>
              "pf_act_pfm_" + "0".repeat(24) + ".bogus".repeat(8))(),
          )
        ).status,
      ).toBe(401);
    });

    it("lists with pagination and a status filter", async () => {
      await enroll();
      const owner = await h.ownerOf();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await made(owner)).missionId);
      await act(owner, ids[0]!, "cancel");
      const page1 = (await (
        await h.call(owner, "GET", `${MISSIONS}?limit=2`)
      ).json()) as { missions: { missionId: string }[]; next: string | null };
      expect(page1.missions).toHaveLength(2);
      expect(page1.next).toBe(page1.missions[1]!.missionId);
      const page2 = (await (
        await h.call(owner, "GET", `${MISSIONS}?limit=2&after=${page1.next}`)
      ).json()) as { missions: { missionId: string }[]; next: string | null };
      const page3 = (await (
        await h.call(owner, "GET", `${MISSIONS}?limit=2&after=${page2.next}`)
      ).json()) as { missions: { missionId: string }[]; next: string | null };
      expect(
        [...page1.missions, ...page2.missions, ...page3.missions]
          .map((x) => x.missionId)
          .sort(),
      ).toEqual([...ids].sort());
      expect(page3.next).toBeNull();
      const cancelled = (await (
        await h.call(owner, "GET", `${MISSIONS}?status=CANCELLED`)
      ).json()) as { missions: { missionId: string }[] };
      expect(cancelled.missions.map((x) => x.missionId)).toEqual([ids[0]]);
    });

    it("the SDK clients complete the real workflow: owner creates, approves, revises; an agent reads its slice and proposes; the owner decides", async () => {
      await enroll();
      const owner = new PayFlowMemberClient({
        baseUrl: h.origin,
        memberToken: await h.ownerOf(),
      });
      const agent = new PayFlowAgentMissionClient({
        baseUrl: h.origin,
        agentToken: await h.agentToken("c"),
      });
      const c = contract() as unknown as MissionContractInput;
      const created = await owner.missions.create(c, key());
      if (!created.ok) throw new Error(created.reason);
      const id = created.mission.missionId;
      expect(await agent.list()).toEqual([]); // not in force yet: an agent sees nothing
      expect((await owner.missions.approve(id, 1)).ok).toBe(true);
      const mine = await agent.list();
      expect(mine).toHaveLength(1);
      expect(mine[0]!.myCapabilities).toEqual(["PURCHASE", "REQUEST_APPROVAL"]);
      expect((await agent.get(id))?.objective).toBe(c.objective);
      const proposal = await agent.propose(id, {
        baseVersion: 1,
        contract: {
          ...c,
          totalBudgetMinor: 400_000,
          maxCommitmentMinor: 100_000,
        },
        idempotencyKey: key(),
      });
      if (!proposal.ok) throw new Error(proposal.reason);
      expect(proposal.mission).toMatchObject({
        activeVersion: 1,
        pendingVersion: 2,
      });
      expect(proposal.mission.pendingReasons).toContain("BUDGET_INCREASED");
      const stale = await owner.missions.revise(id, {
        baseVersion: 1,
        contract: c,
        idempotencyKey: key(),
      });
      expect(stale).toMatchObject({
        ok: false,
        httpStatus: 409,
        reason: "STALE_VERSION",
      });
      expect((await owner.missions.reject(id, 2, "not now")).ok).toBe(true);
      expect(
        (await owner.missions.control(id, "pause", { reason: "review" })).ok,
      ).toBe(true);
      expect(await agent.list()).toEqual([]);
      expect(
        (await owner.missions.list({ status: "PAUSED" })).missions,
      ).toHaveLength(1);
      const hist = (await owner.missions.history(id)).transitions as {
        event: string;
      }[];
      expect(hist.map((t) => t.event)).toEqual([
        "CREATED",
        "VERSION_APPROVED",
        "REVISION_PROPOSED",
        "VERSION_REJECTED",
        "PAUSED",
      ]);
    });
  },
);
