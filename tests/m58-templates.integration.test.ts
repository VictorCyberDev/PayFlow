/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import { idemKey, MISSIONS } from "./helpers/mission-fixtures.js";

/**
 * V3 M58 — the five mission templates, each driven to a working mission through the real Gateway.
 *
 * The templates are read out of the SHIPPED `app-ui/app.js` rather than copied here. A copy would be the one thing this
 * test cannot check: that what a customer actually clicks produces a contract the server accepts and a plan that covers
 * the work. The contract is then built field for field as the wizard builds it.
 *
 * This is what found the defect it now guards: for the three templates whose only approved providers are a workspace
 * provider or professional services, the deterministic planner emitted `clarify-requirements` and then
 * `owner-decision` — asking the owner to "review the shortlist and decide" when no task in the plan had been planned to
 * produce a shortlist.
 */
const url = process.env.TEST_DATABASE_URL;

/**
 * The five templates, as the customer app ships them. Kept here as typed data rather than evaluated out of
 * `app-ui/app.js`, because evaluating source at test time is its own hazard. The copy is not trusted: the first test
 * below checks every field of it against the shipped file, so a template that changes in the app and not here fails
 * loudly instead of leaving this suite quietly testing something nobody ships.
 */
const TEMPLATES = [
  {
    key: "workspace",
    pack: "Founder Launch",
    d: {
      objective: "Find a workspace for my team",
      outcome: "Three workspaces compared, with what each could cost me",
      criteria:
        "Fits my team size\nTotal cost and deposit are stated\nCancellation terms are clear",
      budget: "3000",
      maxOne: "1500",
      approveAbove: "500",
      category: "WORKSPACE",
      providers: ["WORKSPACE_PROVIDER"],
    },
  },
  {
    key: "brand",
    pack: "Founder Launch",
    d: {
      objective: "Commission a logo and brand basics",
      outcome: "A design package chosen and ready to approve",
      criteria:
        "Price and delivery time are stated\nRevisions are included\nRefund terms are clear",
      budget: "1500",
      maxOne: "1000",
      approveAbove: "300",
      category: "DESIGN",
      providers: ["PROFESSIONAL_SERVICES"],
    },
  },
  {
    key: "equipment",
    pack: "Founder Launch",
    d: {
      objective: "Buy equipment for the team",
      outcome: "Equipment ordered within budget",
      criteria: "Under budget\nDelivered within two weeks",
      budget: "4000",
      maxOne: "1500",
      approveAbove: "500",
      category: "EQUIPMENT",
      providers: ["COMMERCE_MARKETPLACE"],
    },
  },
  {
    key: "freelancer",
    pack: "Founder Launch",
    d: {
      objective: "Hire a freelancer for a defined task",
      outcome: "A freelancer chosen, with scope and price agreed",
      criteria:
        "Scope and price are written down\nPayment only after I accept the work",
      budget: "2000",
      maxOne: "1500",
      approveAbove: "400",
      category: "CONTRACTOR",
      providers: ["TALENT_MARKETPLACE"],
    },
  },
  {
    key: "bookkeeping",
    pack: "Everyday",
    d: {
      objective: "Find a bookkeeping service",
      outcome: "A monthly bookkeeping package chosen",
      criteria: "Monthly price is stated\nWhat is delivered is stated",
      budget: "1000",
      maxOne: "400",
      approveAbove: "200",
      category: "BOOKKEEPING",
      providers: ["PROFESSIONAL_SERVICES"],
    },
  },
] as const;

(url ? describe : describe.skip)(
  "M58 mission templates (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate: TRUNCATE + ",plan_run_actions,plan_runs,automation_jobs",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const worker = () => post(ADMIN_TOKEN, "/v1/admin/ops/automation/run");
    const templates = TEMPLATES;
    const shipped = readFileSync("app-ui/app.js", "utf8");

    /** Exactly the mapping the wizard applies in app-ui/app.js when it submits the form. */
    const contractFor = (d: Record<string, any>, agents: unknown[]) => ({
      objective: String(d.objective).trim(),
      intendedOutcome: String(d.outcome).trim(),
      successCriteria: String(d.criteria)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      currency: "USD",
      totalBudgetMinor: Math.round(Number(d.budget) * 100),
      maxCommitmentMinor: Math.round(Number(d.maxOne) * 100),
      spendingCategories: [String(d.category)],
      approvedProviderTypes: d.providers as string[],
      merchantRestrictions: { mode: "ONLY", ids: ["payflow.demo.merchant"] },
      agents,
      approvalConditions: {
        humanApprovalAboveMinor: Math.round(Number(d.approveAbove) * 100),
      },
      expiresAt: "2026-11-23T10:00:00.000Z",
    });

    const missionFrom = async (
      d: Record<string, any>,
      agents: unknown[] = [],
    ) => {
      const owner = await h.ownerOf();
      const r = await post(owner, MISSIONS, {
        contract: contractFor(d, agents),
        idempotencyKey: idemKey("m58"),
      });
      expect(r.status, await r.clone().text()).toBe(201);
      const id = (await body(r)).mission.missionId as string;
      expect(
        (await post(owner, `${MISSIONS}/${id}/approve`, { version: 1 })).status,
      ).toBe(200);
      return { owner, id };
    };
    const planOf = async (owner: string, id: string) => {
      const r = await post(owner, `${MISSIONS}/${id}/plans`, {
        source: "TEMPLATE",
        idempotencyKey: idemKey("tpl"),
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await body(
        await h.call(owner, "GET", `${MISSIONS}/${id}/plans`),
      )) as any;
    };

    it("the copy in this test is what app-ui actually ships, field for field", () => {
      expect(templates.map((t) => t.key).sort()).toEqual([
        "bookkeeping",
        "brand",
        "equipment",
        "freelancer",
        "workspace",
      ]);
      expect([...new Set(templates.map((t) => t.pack))].sort()).toEqual([
        "Everyday",
        "Founder Launch",
      ]);
      // Exactly five, so a sixth added to the app cannot slip past this suite untested.
      expect(
        (shipped.match(/^\s{4}key: "/gmu) ?? []).length,
        "app-ui/app.js ships a different number of templates than this test covers",
      ).toBe(5);
      for (const t of templates) {
        for (const value of [
          `key: "${t.key}"`,
          `pack: "${t.pack}"`,
          `objective: "${t.d.objective}"`,
          `outcome: "${t.d.outcome}"`,
          `budget: "${t.d.budget}"`,
          `maxOne: "${t.d.maxOne}"`,
          `approveAbove: "${t.d.approveAbove}"`,
          `category: "${t.d.category}"`,
        ])
          expect(
            shipped,
            `app-ui/app.js no longer contains ${value}`,
          ).toContain(value);
        for (const p of t.d.providers) expect(shipped).toContain(`"${p}"`);
        // The criteria carry real newlines in the source, so compare the escaped form the file holds.
        expect(shipped).toContain(
          `criteria:\n        ${JSON.stringify(t.d.criteria)}`.length > 0
            ? JSON.stringify(t.d.criteria).slice(1, -1)
            : "",
        );
      }
    });

    for (const t of templates) {
      it(`template "${t.key}" produces a mission the server accepts and a plan that covers the work`, async () => {
        const { owner, id } = await missionFrom(t.d);
        const cur = await planOf(owner, id);
        expect(cur.activePlanVersion).toBe(1);
        const keys = cur.tasks.map((x: any) => x.key).sort();

        // Every template must plan some discovery, not just "write requirements, then decide".
        const discovery = keys.filter((k: string) =>
          [
            "source-offers",
            "source-talent",
            "find-workspaces",
            "find-services",
          ].includes(k),
        );
        expect(
          discovery.length,
          `template ${t.key} planned no discovery at all: ${keys.join(",")}`,
        ).toBeGreaterThanOrEqual(1);

        // And the owner's decision must wait for work that was actually planned to produce a shortlist.
        const decision = cur.tasks.find((x: any) => x.key === "owner-decision");
        expect(decision).toBeTruthy();
        expect(decision.requiresOwnerApproval).toBe(true);
        const waitsFor = decision.dependsOn.map((dd: any) => dd.key);
        expect(
          waitsFor,
          `owner-decision in ${t.key} waits only on ${waitsFor.join(",")}`,
        ).not.toEqual(["clarify-requirements"]);
        for (const w of waitsFor) expect(keys).toContain(w);
      });
    }

    it("a templated mission runs: the plan run advances it and says who acts next, buying nothing", async () => {
      // One template end to end with an agent that actually holds the capabilities, so tasks are assigned rather
      // than left for a member. The workspace template is the one that used to plan no discovery at all.
      const workspace = templates.find((t) => t.key === "workspace")!;
      // The organization has to exist before an agent can be enrolled into it.
      await h.ownerOf();
      await h.agentToken("a");
      const { owner, id } = await missionFrom(workspace.d, [
        {
          agentId: "a",
          capabilities: [
            "SEARCH",
            "READ",
            "COMPARE",
            "DRAFT",
            "REQUEST_APPROVAL",
          ],
        },
      ]);
      const cur = await planOf(owner, id);
      expect(cur.tasks.map((x: any) => x.key).sort()).toEqual([
        "clarify-requirements",
        "compare-workspaces",
        "find-workspaces",
        "owner-decision",
      ]);
      // The discovery step is honest about needing a provider: none is commissioned.
      const find = cur.tasks.find((x: any) => x.key === "find-workspaces");
      expect(find.readiness).toBe("PREPARED_HANDOFF");
      expect(find.readinessReason).toMatch(/NO_CONNECTOR_COMMISSIONED/u);

      const before = (
        await h.repo
          .sql`select (select count(*)::int c from mission_ledger_items) c`
      )[0]!.c;
      expect((await post(owner, `${MISSIONS}/${id}/plan-runs`)).status).toBe(
        201,
      );
      await worker();
      const run = (
        (await body(
          await h.call(owner, "GET", `${MISSIONS}/${id}/plan-runs`),
        )) as any
      ).runs[0];
      expect(run.state).toBe("WAITING_ON_PEOPLE");
      // It advanced the one task it could and left a worklist naming the rest.
      expect(run.actions.map((x: any) => [x.taskKey, x.action])).toContainEqual(
        ["clarify-requirements", "HANDED_OFF"],
      );
      expect(run.worklist.length).toBeGreaterThanOrEqual(1);
      expect(
        (
          await h.repo
            .sql`select (select count(*)::int c from mission_ledger_items) c`
        )[0]!.c,
      ).toBe(before);
    });
  },
);
