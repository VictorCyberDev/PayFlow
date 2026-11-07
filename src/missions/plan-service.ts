import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import {
  MissionContractSchema,
  type Capability,
  type MissionContract,
} from "./contract.js";
import {
  NO_CONNECTORS,
  PlanDraftSchema,
  templatePlan,
  validatePlan,
  type ConnectorCatalog,
  type PlanProblem,
} from "./plan.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * Plan and task lifecycle for a mission.
 *
 *  - A plan written by a member is ACTIVE at once. A plan PROPOSED by an agent (or a model acting through one) is stored as
 *    PROPOSED and does nothing until a member activates it.
 *  - Activating a plan supersedes the previous active plan; its unfinished tasks become INVALIDATED. Finished work stays recorded
 *    under the old plan version and is never silently carried over, so no step runs twice by accident.
 *  - Tasks are claimed, completed, failed or handed off by the ASSIGNED agent, and only while the mission is ACTIVE and the
 *    agent still holds every required capability on the version in force (`MissionService.authorizeCapability`).
 *  - Everything that changes a mission's tasks runs under that mission's row lock, so two agents cannot claim the same task
 *    and a reconciliation cannot race a completion.
 *  - A task result is labelled by who reported it. An agent saying "done" is AGENT_REPORTED; it is not provider-confirmed.
 */
export type TaskState =
  | "BLOCKED"
  | "READY"
  | "AWAITING_APPROVAL"
  | "IN_PROGRESS"
  | "HANDED_OFF"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "INVALIDATED";
const DONE: readonly TaskState[] = [
  "COMPLETED",
  "FAILED",
  "SKIPPED",
  "INVALIDATED",
];

export type PlanRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "MISSION_TERMINAL"
  | "MISSION_NOT_ACTIVE"
  | "PLAN_INVALID"
  | "STALE_MISSION_VERSION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NOT_PROPOSED"
  | "WRONG_STATE"
  | "NOT_ASSIGNED"
  | "CAPABILITY_REFUSED"
  | "RUN_KEY_MISMATCH"
  | "MISSING_EVIDENCE"
  | "NOT_A_HANDOFF"
  | "AGENT_CANNOT_PROPOSE";
export type PResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      refusal: PlanRefusal;
      detail?: string;
      problems?: PlanProblem[];
    };

const Idem = z.string().min(16).max(128);
export const ProposePlanSchema = z
  .object({
    source: z.enum(["HUMAN", "TEMPLATE", "MODEL"]),
    sourceLabel: z.string().trim().max(120).optional(),
    draft: z.unknown().optional(),
    idempotencyKey: Idem,
  })
  .strict();
const Evidence = z
  .object({
    kind: z.string().trim().min(1).max(80),
    ref: z.string().trim().min(1).max(500),
  })
  .strict();
export const CompleteSchema = z
  .object({
    runKey: Idem,
    summary: z.string().trim().max(1000).default(""),
    evidence: z.array(Evidence).max(20).default([]),
  })
  .strict();
export const ClaimSchema = z.object({ runKey: Idem }).strict();
export const FailSchema = z
  .object({ runKey: Idem, reason: z.string().trim().min(1).max(500) })
  .strict();
export const HandoffSchema = z
  .object({ runKey: Idem, note: z.string().trim().min(1).max(1000) })
  .strict();
export const MemberTaskSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    summary: z.string().trim().max(1000).optional(),
    evidence: z.array(Evidence).max(20).optional(),
  })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : x,
  );
const sha = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");

type Row = Record<string, unknown>;
export interface TaskView {
  readonly taskId: string;
  readonly key: string;
  readonly planVersion: number;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly taskType: string;
  readonly requiredCapabilities: readonly string[];
  readonly providerTypes: readonly string[];
  readonly estimatedCostMinor: number | null;
  /** AI_ESTIMATE / HUMAN_ESTIMATE / NONE. Never a quote. */
  readonly estimateSource: string;
  readonly expectedDurationMinutes: number | null;
  readonly requiredEvidence: readonly string[];
  readonly assignedAgentId: string | null;
  readonly priority: string;
  readonly deadline: string | null;
  readonly state: TaskState;
  readonly blockReason: string | null;
  readonly readiness: "EXECUTABLE" | "PREPARED_HANDOFF" | "UNAVAILABLE";
  readonly readinessReason: string | null;
  readonly requiresOwnerApproval: boolean;
  readonly approvedBy: string | null;
  readonly dependsOn: readonly { key: string; kind: string }[];
  readonly explanation: string;
  readonly result: unknown;
  readonly failure: unknown;
  readonly rowVersion: number;
}
const toTask = (r: Row, deps: { key: string; kind: string }[]): TaskView => ({
  taskId: String(r.task_id),
  key: String(r.task_key),
  planVersion: Number(r.plan_version),
  title: String(r.title),
  intendedOutcome: String(r.intended_outcome),
  taskType: String(r.task_type),
  requiredCapabilities: r.required_capabilities as string[],
  providerTypes: r.provider_types as string[],
  estimatedCostMinor:
    r.estimated_cost_minor === null ? null : Number(r.estimated_cost_minor),
  estimateSource: String(r.estimate_source),
  expectedDurationMinutes:
    r.expected_duration_minutes === null
      ? null
      : Number(r.expected_duration_minutes),
  requiredEvidence: r.required_evidence as string[],
  assignedAgentId: (r.assigned_agent_id as string | null) ?? null,
  priority: String(r.priority),
  deadline: r.deadline ? iso(r.deadline) : null,
  state: r.state as TaskState,
  blockReason: (r.block_reason as string | null) ?? null,
  readiness: r.readiness as TaskView["readiness"],
  readinessReason: (r.readiness_reason as string | null) ?? null,
  requiresOwnerApproval: Boolean(r.requires_owner_approval),
  approvedBy: (r.approved_by as string | null) ?? null,
  dependsOn: deps,
  explanation: String(r.explanation),
  result: r.result ?? null,
  failure: r.failure ?? null,
  rowVersion: Number(r.row_version),
});

export class PlanService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      now: () => string;
      connectors?: ConnectorCatalog;
    },
  ) {}

  // ----------------------------------------------------------------------------------------------- helpers
  private async lockMission(
    tx: TransactionSql,
    t: { organizationId: string; environment: Environment },
    missionId: string,
  ) {
    const [m] =
      await tx`select * from missions where mission_id = ${missionId} and organization_id = ${t.organizationId}
      and environment = ${t.environment} for update`;
    return m ?? null;
  }
  private async contractInForce(
    tx: TransactionSql | Sql,
    m: Row,
  ): Promise<MissionContract> {
    const v =
      m.active_version === null
        ? Number(m.latest_version)
        : Number(m.active_version);
    const [row] =
      await tx`select contract from mission_versions where mission_id = ${String(m.mission_id)} and version = ${v}`;
    return MissionContractSchema.parse(row!.contract);
  }
  private async event(
    tx: TransactionSql,
    taskId: string,
    from: TaskState | null,
    to: TaskState,
    event: string,
    actor: { kind: "MEMBER" | "AGENT" | "SYSTEM"; id: string },
    detail: string | undefined,
    now: string,
  ) {
    const [n] =
      await tx`select coalesce(max(seq),0)::int n from mission_task_events where task_id = ${taskId}`;
    await tx`insert into mission_task_events (task_id, seq, from_state, to_state, event, actor_kind, actor_id, detail, occurred_at)
      values (${taskId}, ${Number(n!.n) + 1}, ${from}, ${to}, ${event}, ${actor.kind}, ${actor.id}, ${detail?.slice(0, 500) ?? null}, ${now})`;
  }
  private async setState(
    tx: TransactionSql,
    row: Row,
    to: TaskState,
    event: string,
    actor: { kind: "MEMBER" | "AGENT" | "SYSTEM"; id: string },
    now: string,
    extra: { block?: string | null; detail?: string | undefined } = {},
  ) {
    await tx`update mission_tasks set state = ${to}, block_reason = ${extra.block ?? null}, row_version = row_version + 1, updated_at = ${now}
      where task_id = ${String(row.task_id)}`;
    await this.event(
      tx,
      String(row.task_id),
      row.state as TaskState,
      to,
      event,
      actor,
      extra.detail,
      now,
    );
  }
  private audit(
    c: {
      organizationId: string;
      environment: Environment;
      kind: "MEMBER" | "AGENT" | "SYSTEM";
      id: string;
    },
    action: string,
    subjectId: string,
    detail: Record<string, string | number>,
    now: string,
  ) {
    return this.deps.audit.append({
      organizationId: c.organizationId,
      environment: c.environment,
      actorKind:
        c.kind === "MEMBER"
          ? "MEMBER"
          : c.kind === "AGENT"
            ? "AGENT_CREDENTIAL"
            : "SYSTEM",
      actorId: c.id,
      action,
      subjectKind: "MISSION_PLAN",
      subjectId,
      detail,
      occurredAt: now,
    });
  }

  /**
   * Re-derives BLOCKED / READY / AWAITING_APPROVAL for the active plan, and invalidates tasks the mission no longer permits.
   * Idempotent. Must be called under the mission lock.
   */
  private async reconcile(tx: TransactionSql, m: Row, now: string) {
    const missionId = String(m.mission_id);
    const [plan] =
      await tx`select plan_version from mission_plans where mission_id = ${missionId} and status = 'ACTIVE'`;
    if (!plan) return;
    const pv = Number(plan.plan_version);
    const terminal = ["COMPLETED", "FAILED", "SKIPPED", "INVALIDATED"];
    const contract =
      m.status === "PAUSED" ||
      m.status === "ACTIVE" ||
      m.active_version !== null
        ? await this.contractInForce(tx, m)
        : null;
    const tasks =
      await tx`select * from mission_tasks where mission_id = ${missionId} and plan_version = ${pv} order by task_key`;
    const deps =
      await tx`select task_key, depends_on_key, kind from mission_task_deps where mission_id = ${missionId} and plan_version = ${pv}`;
    const byKey = new Map(tasks.map((t) => [String(t.task_key), t]));
    // 1. Assumptions that no longer hold (capability revoked, agent removed, provider type no longer approved) invalidate the task.
    if (contract && m.active_version !== null) {
      const grants = new Map(
        contract.agents.map((a) => [
          a.agentId,
          new Set<string>(a.capabilities),
        ]),
      );
      for (const t of tasks) {
        if (terminal.includes(String(t.state))) continue;
        let why: string | null = null;
        const agent = t.assigned_agent_id as string | null;
        if (agent) {
          const g = grants.get(agent);
          if (!g) why = `AGENT_REMOVED_FROM_MISSION:${agent}`;
          else
            for (const c of t.required_capabilities as string[])
              if (!g.has(c)) why = `CAPABILITY_REVOKED:${agent}:${c}`;
        }
        for (const p of t.provider_types as string[])
          if (!contract.approvedProviderTypes.includes(p as never))
            why = `PROVIDER_TYPE_NOT_APPROVED:${p}`;
        if (why) {
          await this.setState(
            tx,
            t,
            "INVALIDATED",
            "ASSUMPTION_CHANGED",
            { kind: "SYSTEM", id: "reconcile" },
            now,
            { detail: why },
          );
          t.state = "INVALIDATED";
        }
      }
    }
    // 2. Dependency readiness.
    for (const t of tasks) {
      if (!["BLOCKED", "READY", "AWAITING_APPROVAL"].includes(String(t.state)))
        continue;
      const mine = deps.filter((d) => d.task_key === t.task_key);
      const unmet: string[] = [];
      let broken = false;
      for (const d of mine) {
        const dep = byKey.get(String(d.depends_on_key))!;
        const s = String(dep.state);
        if (s === "COMPLETED" || (d.kind === "CONDITIONAL" && s === "SKIPPED"))
          continue;
        if (
          s === "FAILED" ||
          s === "INVALIDATED" ||
          (s === "SKIPPED" && d.kind === "HARD")
        )
          broken = true;
        unmet.push(`${String(d.depends_on_key)}:${s}`);
      }
      let to: TaskState;
      let block: string | null = null;
      if (unmet.length) {
        to = "BLOCKED";
        block =
          (broken ? "DEPENDENCY_BROKEN:" : "WAITING_FOR:") + unmet.join(",");
      } else if (t.requires_owner_approval && !t.approved_at)
        to = "AWAITING_APPROVAL";
      else to = "READY";
      if (to !== t.state || (t.block_reason ?? null) !== block) {
        await this.setState(
          tx,
          t,
          to,
          "RECOMPUTED",
          { kind: "SYSTEM", id: "reconcile" },
          now,
          { block },
        );
        t.state = to;
        t.block_reason = block;
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ propose
  async propose(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    PResult<{
      planVersion: number;
      status: string;
      replayed: boolean;
      estimatedTotalMinor: number;
      overBudget: boolean;
    }>
  > {
    const body = ProposePlanSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const now = this.deps.now();
    if (caller.kind === "AGENT") {
      // A model/agent proposes a plan only if the mission granted it DRAFT; the plan is inert until a member activates it.
      const gate = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "DRAFT",
      );
      if (!gate.allowed)
        return {
          ok: false,
          refusal: "AGENT_CANNOT_PROPOSE",
          detail: gate.reason,
        };
      if (body.data.source !== "MODEL")
        return {
          ok: false,
          refusal: "AGENT_CANNOT_PROPOSE",
          detail: "AGENT_PLANS_ARE_LABELLED_MODEL",
        };
    } else if (body.data.source === "MODEL")
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: "MODEL_PLANS_COME_FROM_AN_AGENT_AND_ARE_PROPOSED",
      };
    const requestDigest = sha({
      missionId,
      ...body.data,
      draft: body.data.draft ?? null,
    });
    const out = await this.deps.sql.begin(
      async (
        tx,
      ): Promise<
        PResult<{
          planVersion: number;
          status: string;
          replayed: boolean;
          estimatedTotalMinor: number;
          overBudget: boolean;
        }>
      > => {
        const m = await this.lockMission(tx, caller, missionId);
        if (!m) return { ok: false, refusal: "NOT_FOUND" };
        if (
          ["COMPLETED", "CANCELLED", "EXPIRED", "REVOKED", "FAILED"].includes(
            String(m.status),
          )
        )
          return { ok: false, refusal: "MISSION_TERMINAL" };
        const [prior] =
          await tx`select plan_version, status, request_digest from mission_plans where mission_id = ${missionId} and idempotency_key = ${body.data.idempotencyKey}`;
        if (prior)
          return prior.request_digest === requestDigest
            ? {
                ok: true,
                value: {
                  planVersion: Number(prior.plan_version),
                  status: String(prior.status),
                  replayed: true,
                  estimatedTotalMinor: 0,
                  overBudget: false,
                },
              }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        const contract = await this.contractInForce(tx, m);
        let draftRaw: unknown;
        if (body.data.source === "TEMPLATE") draftRaw = templatePlan(contract);
        else draftRaw = body.data.draft;
        const parsed = PlanDraftSchema.safeParse(draftRaw);
        if (!parsed.success)
          return {
            ok: false,
            refusal: "MALFORMED",
            detail: parsed.error.issues
              .slice(0, 4)
              .map((i) => `${i.path.join(".")}:${i.message}`)
              .join(" | "),
          };
        const checked = validatePlan(
          contract,
          parsed.data,
          this.deps.connectors ?? NO_CONNECTORS,
        );
        if (!checked.ok)
          return {
            ok: false,
            refusal: "PLAN_INVALID",
            problems: checked.problems,
          };
        const [last] =
          await tx`select coalesce(max(plan_version),0)::int n from mission_plans where mission_id = ${missionId}`;
        const planVersion = Number(last!.n) + 1;
        const activeNow = caller.kind === "MEMBER";
        await tx`insert into mission_plans (mission_id, plan_version, based_on_mission_version, status, source, source_label, rationale,
          created_by_kind, created_by, idempotency_key, request_digest, created_at)
        values (${missionId}, ${planVersion}, ${m.active_version === null ? Number(m.latest_version) : Number(m.active_version)}, 'PROPOSED',
          ${body.data.source === "TEMPLATE" ? "DETERMINISTIC_TEMPLATE" : body.data.source}, ${body.data.sourceLabel ?? null}, ${parsed.data.rationale},
          ${caller.kind}, ${caller.id}, ${body.data.idempotencyKey}, ${requestDigest}, ${now})`;
        for (const t of checked.tasks) {
          await tx`insert into mission_tasks (task_id, mission_id, plan_version, task_key, title, intended_outcome, task_type, required_capabilities,
            provider_types, estimated_cost_minor, estimate_source, expected_duration_minutes, required_evidence, assigned_agent_id, priority,
            deadline, state, readiness, readiness_reason, requires_owner_approval, explanation, created_at, updated_at)
          values (${`tsk_${randomBytes(12).toString("hex")}`}, ${missionId}, ${planVersion}, ${t.key}, ${t.title}, ${t.intendedOutcome}, ${t.taskType},
            ${t.requiredCapabilities}, ${t.providerTypes}, ${t.estimatedCostMinor ?? null}, ${t.estimateSource}, ${t.expectedDurationMinutes ?? null},
            ${t.requiredEvidence}, ${t.assignedAgentId ?? null}, ${t.priority}, ${t.deadline ?? null}, 'BLOCKED', ${t.readiness}, ${t.readinessReason},
            ${t.requiresOwnerApproval}, ${t.explanation}, ${now}, ${now})`;
        }
        for (const t of checked.tasks)
          for (const d of t.dependsOn)
            await tx`insert into mission_task_deps (mission_id, plan_version, task_key, depends_on_key, kind) values (${missionId}, ${planVersion}, ${t.key}, ${d.key}, ${d.kind})`;
        if (activeNow)
          await this.activateInTx(
            tx,
            m,
            planVersion,
            { kind: "MEMBER", id: caller.id },
            now,
          );
        return {
          ok: true,
          value: {
            planVersion,
            status: activeNow ? "ACTIVE" : "PROPOSED",
            replayed: false,
            estimatedTotalMinor: checked.estimatedTotalMinor,
            overBudget: checked.overBudget,
          },
        };
      },
    );
    if (out.ok && !out.value.replayed)
      await this.audit(
        caller,
        out.value.status === "ACTIVE"
          ? "MISSION_PLAN_ACTIVATED"
          : "MISSION_PLAN_PROPOSED",
        missionId,
        { planVersion: out.value.planVersion, source: body.data.source },
        now,
      );
    return out;
  }

  private async activateInTx(
    tx: TransactionSql,
    m: Row,
    planVersion: number,
    actor: { kind: "MEMBER"; id: string },
    now: string,
  ) {
    const missionId = String(m.mission_id);
    const [old] =
      await tx`select plan_version from mission_plans where mission_id = ${missionId} and status = 'ACTIVE'`;
    if (old) {
      const oldTasks =
        await tx`select * from mission_tasks where mission_id = ${missionId} and plan_version = ${Number(old.plan_version)}`;
      for (const t of oldTasks)
        if (!DONE.includes(t.state as TaskState))
          await this.setState(
            tx,
            t,
            "INVALIDATED",
            "PLAN_SUPERSEDED",
            { kind: "MEMBER", id: actor.id },
            now,
            { detail: `superseded by plan ${planVersion}` },
          );
      await tx`update mission_plans set status = 'SUPERSEDED' where mission_id = ${missionId} and plan_version = ${Number(old.plan_version)}`;
    }
    await tx`update mission_plans set status = 'ACTIVE', activated_by = ${actor.id}, activated_at = ${now} where mission_id = ${missionId} and plan_version = ${planVersion}`;
    await this.reconcile(tx, m, now);
  }

  async activate(
    caller: MissionCaller,
    missionId: string,
    planVersion: number,
    decision: "ACTIVATE" | "REJECT",
  ): Promise<PResult<{ planVersion: number; status: string }>> {
    if (caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "NOT_ASSIGNED",
        detail: "ONLY_A_MEMBER_ACTIVATES_A_PLAN",
      };
    const now = this.deps.now();
    const out = await this.deps.sql.begin(
      async (tx): Promise<PResult<{ planVersion: number; status: string }>> => {
        const m = await this.lockMission(tx, caller, missionId);
        if (!m) return { ok: false, refusal: "NOT_FOUND" };
        if (
          ["COMPLETED", "CANCELLED", "EXPIRED", "REVOKED", "FAILED"].includes(
            String(m.status),
          )
        )
          return { ok: false, refusal: "MISSION_TERMINAL" };
        const [p] =
          await tx`select status from mission_plans where mission_id = ${missionId} and plan_version = ${planVersion}`;
        if (!p || p.status !== "PROPOSED")
          return { ok: false, refusal: "NOT_PROPOSED" };
        if (decision === "REJECT") {
          await tx`update mission_plans set status = 'REJECTED' where mission_id = ${missionId} and plan_version = ${planVersion}`;
          return { ok: true, value: { planVersion, status: "REJECTED" } };
        }
        // Revalidate against the contract in force NOW: the mission may have narrowed since the proposal.
        const contract = await this.contractInForce(tx, m);
        const rows =
          await tx`select * from mission_tasks where mission_id = ${missionId} and plan_version = ${planVersion}`;
        const depRows =
          await tx`select task_key, depends_on_key, kind from mission_task_deps where mission_id = ${missionId} and plan_version = ${planVersion}`;
        const draft = PlanDraftSchema.parse({
          rationale: "",
          tasks: (rows as unknown as Row[]).map((r) => ({
            key: r.task_key,
            title: r.title,
            intendedOutcome: r.intended_outcome,
            taskType: r.task_type,
            requiredCapabilities: r.required_capabilities,
            providerTypes: r.provider_types,
            ...(r.estimated_cost_minor === null
              ? {}
              : { estimatedCostMinor: Number(r.estimated_cost_minor) }),
            estimateSource:
              r.estimate_source === "VERIFIED_QUOTE"
                ? "NONE"
                : r.estimate_source,
            requiredEvidence: r.required_evidence,
            ...(r.assigned_agent_id
              ? { assignedAgentId: r.assigned_agent_id }
              : {}),
            priority: r.priority,
            explanation: r.explanation,
            dependsOn: (depRows as unknown as Row[])
              .filter((d) => d.task_key === r.task_key)
              .map((d) => ({ key: d.depends_on_key, kind: d.kind })),
          })),
        });
        const checked = validatePlan(
          contract,
          draft,
          this.deps.connectors ?? NO_CONNECTORS,
        );
        if (!checked.ok)
          return {
            ok: false,
            refusal: "PLAN_INVALID",
            problems: checked.problems,
          };
        await this.activateInTx(
          tx,
          m,
          planVersion,
          { kind: "MEMBER", id: caller.id },
          now,
        );
        return { ok: true, value: { planVersion, status: "ACTIVE" } };
      },
    );
    if (out.ok)
      await this.audit(
        caller,
        decision === "ACTIVATE"
          ? "MISSION_PLAN_ACTIVATED"
          : "MISSION_PLAN_REJECTED",
        missionId,
        { planVersion },
        now,
      );
    return out;
  }

  // -------------------------------------------------------------------------------------------------- read
  /** The active plan (reconciled with the mission first), any proposals waiting, and progress. */
  async current(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
  ) {
    const now = this.deps.now();
    await this.deps.missions.expireDue().catch(() => 0);
    const synced = await this.deps.sql.begin(async (tx) => {
      const m = await this.lockMission(tx, caller, missionId);
      if (!m) return false;
      await this.reconcile(tx, m, now);
      return true;
    });
    if (!synced) return { ok: false as const, refusal: "NOT_FOUND" as const };
    const sql = this.deps.sql;
    const plans =
      await sql`select * from mission_plans where mission_id = ${missionId} order by plan_version`;
    const activePlan = plans.find((p) => p.status === "ACTIVE");
    const tasks = activePlan
      ? await this.tasksOf(sql, missionId, Number(activePlan.plan_version))
      : [];
    const counts = tasks.reduce<Record<string, number>>(
      (a, t) => ((a[t.state] = (a[t.state] ?? 0) + 1), a),
      {},
    );
    const estimated = tasks.reduce(
      (n, t) => n + (t.estimatedCostMinor ?? 0),
      0,
    );
    return {
      ok: true as const,
      value: {
        plans: plans.map((p) => ({
          planVersion: Number(p.plan_version),
          status: String(p.status),
          source: String(p.source),
          sourceLabel: (p.source_label as string | null) ?? null,
          basedOnMissionVersion: Number(p.based_on_mission_version),
          createdByKind: String(p.created_by_kind),
          createdBy: String(p.created_by),
          rationale: String(p.rationale),
          createdAt: iso(p.created_at),
        })),
        activePlanVersion: activePlan ? Number(activePlan.plan_version) : null,
        tasks,
        progress: counts,
        estimatedTotalMinor: estimated,
        estimateNote:
          "Estimates are labelled AI_ESTIMATE or HUMAN_ESTIMATE and are never quotes.",
      },
    };
  }
  private async tasksOf(
    sql: Sql | TransactionSql,
    missionId: string,
    planVersion: number,
  ): Promise<TaskView[]> {
    const rows =
      await sql`select * from mission_tasks where mission_id = ${missionId} and plan_version = ${planVersion} order by created_at, task_key`;
    const deps =
      await sql`select task_key, depends_on_key, kind from mission_task_deps where mission_id = ${missionId} and plan_version = ${planVersion}`;
    return rows.map((r) =>
      toTask(
        r,
        deps
          .filter((d) => d.task_key === r.task_key)
          .map((d) => ({
            key: String(d.depends_on_key),
            kind: String(d.kind),
          })),
      ),
    );
  }
  async proposedPlanTasks(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
    planVersion: number,
  ) {
    const [m] = await this.deps
      .sql`select 1 from missions where mission_id = ${missionId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
    return m ? this.tasksOf(this.deps.sql, missionId, planVersion) : null;
  }
  async history(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    taskId: string,
  ) {
    const [t] = await this.deps
      .sql`select t.task_id from mission_tasks t join missions m on m.mission_id = t.mission_id
      where t.task_id = ${taskId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!t) return null;
    const ev = await this.deps
      .sql`select seq, from_state, to_state, event, actor_kind, actor_id, detail, occurred_at from mission_task_events where task_id = ${taskId} order by seq`;
    return ev.map((e) => ({
      seq: Number(e.seq),
      from: (e.from_state as string | null) ?? null,
      to: String(e.to_state),
      event: String(e.event),
      actorKind: String(e.actor_kind),
      actorId: String(e.actor_id),
      detail: (e.detail as string | null) ?? null,
      at: iso(e.occurred_at),
    }));
  }
  /** The tasks assigned to one agent on missions in force: what it should work on. */
  async forAgent(caller: MissionCaller, missionId?: string) {
    await this.deps.missions.expireDue().catch(() => 0);
    const rows = await this.deps.sql`
      select t.* from mission_tasks t
      join missions m on m.mission_id = t.mission_id
      join mission_plans p on p.mission_id = t.mission_id and p.plan_version = t.plan_version and p.status = 'ACTIVE'
      where m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment} and m.status = 'ACTIVE'
        and t.assigned_agent_id = ${caller.id} and t.state in ('READY','IN_PROGRESS','AWAITING_APPROVAL','BLOCKED')
        and (${missionId ?? null}::text is null or t.mission_id = ${missionId ?? null})
      order by t.created_at, t.task_key limit 200`;
    return rows.map((r) => ({
      missionId: String(r.mission_id),
      ...toTask(r, []),
    }));
  }

  // --------------------------------------------------------------------------------------- task operations
  private async loadTask(
    tx: TransactionSql,
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    taskId: string,
  ) {
    const [t] =
      await tx`select t.*, m.mission_id as mid from mission_tasks t join missions m on m.mission_id = t.mission_id
      where t.task_id = ${taskId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    return t ?? null;
  }
  private async withTask<T>(
    caller: MissionCaller,
    taskId: string,
    run: (
      tx: TransactionSql,
      task: Row,
      m: Row,
      now: string,
    ) => Promise<PResult<T>>,
  ): Promise<PResult<T>> {
    const now = this.deps.now();
    const found = await this.deps
      .sql`select mission_id from mission_tasks where task_id = ${taskId}`;
    if (!found[0]) return { ok: false, refusal: "NOT_FOUND" };
    return this.deps.sql.begin(async (tx) => {
      const m = await this.lockMission(
        tx,
        caller,
        String(found[0]!.mission_id),
      );
      if (!m) return { ok: false, refusal: "NOT_FOUND" }; // another tenant's task is indistinguishable from none
      const t = await this.loadTask(tx, caller, taskId);
      if (!t) return { ok: false, refusal: "NOT_FOUND" };
      const [plan] =
        await tx`select status from mission_plans where mission_id = ${String(m.mission_id)} and plan_version = ${Number(t.plan_version)}`;
      if (!plan || plan.status !== "ACTIVE")
        return {
          ok: false,
          refusal: "WRONG_STATE",
          detail: "PLAN_NOT_ACTIVE",
        };
      await this.reconcile(tx, m, now);
      const [fresh] =
        await tx`select * from mission_tasks where task_id = ${taskId}`;
      return run(tx, fresh!, m, now);
    });
  }

  async claim(
    caller: MissionCaller,
    taskId: string,
    rawBody: unknown,
  ): Promise<PResult<TaskView>> {
    const body = ClaimSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    return this.afterTask(
      caller,
      taskId,
      "TASK_CLAIMED",
      await this.withTask(caller, taskId, async (tx, t, m, now) => {
        if (caller.kind !== "AGENT" || t.assigned_agent_id !== caller.id)
          return { ok: false, refusal: "NOT_ASSIGNED" };
        if (t.state === "IN_PROGRESS")
          return t.run_key === body.data.runKey
            ? { ok: true, value: toTask(t, []) }
            : { ok: false, refusal: "RUN_KEY_MISMATCH" };
        if (m.status !== "ACTIVE")
          return {
            ok: false,
            refusal: "MISSION_NOT_ACTIVE",
            detail: String(m.status),
          };
        if (t.state !== "READY")
          return { ok: false, refusal: "WRONG_STATE", detail: String(t.state) };
        for (const c of t.required_capabilities as string[]) {
          const gate = await this.deps.missions.authorizeCapability(
            caller,
            String(m.mission_id),
            caller.id,
            c as Capability,
            tx,
          );
          if (!gate.allowed)
            return {
              ok: false,
              refusal: "CAPABILITY_REFUSED",
              detail: gate.reason,
            };
        }
        await tx`update mission_tasks set run_key = ${body.data.runKey} where task_id = ${String(t.task_id)}`;
        await this.setState(
          tx,
          t,
          "IN_PROGRESS",
          "CLAIMED",
          { kind: "AGENT", id: caller.id },
          now,
        );
        const [after] =
          await tx`select * from mission_tasks where task_id = ${String(t.task_id)}`;
        return { ok: true, value: toTask(after!, []) };
      }),
    );
  }

  async complete(
    caller: MissionCaller,
    taskId: string,
    rawBody: unknown,
  ): Promise<PResult<TaskView>> {
    const body = CompleteSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    return this.afterTask(
      caller,
      taskId,
      "TASK_COMPLETED",
      await this.withTask(caller, taskId, async (tx, t, m, now) => {
        if (caller.kind !== "AGENT" || t.assigned_agent_id !== caller.id)
          return { ok: false, refusal: "NOT_ASSIGNED" };
        if (t.state === "COMPLETED")
          return t.run_key === body.data.runKey
            ? { ok: true, value: toTask(t, []) }
            : { ok: false, refusal: "RUN_KEY_MISMATCH" };
        if (t.state !== "IN_PROGRESS")
          return { ok: false, refusal: "WRONG_STATE", detail: String(t.state) };
        if (t.run_key !== body.data.runKey)
          return { ok: false, refusal: "RUN_KEY_MISMATCH" };
        if (m.status !== "ACTIVE")
          return {
            ok: false,
            refusal: "MISSION_NOT_ACTIVE",
            detail: String(m.status),
          };
        const have = new Set(body.data.evidence.map((e) => e.kind));
        const missing = (t.required_evidence as string[]).filter(
          (k) => !have.has(k),
        );
        if (missing.length)
          return {
            ok: false,
            refusal: "MISSING_EVIDENCE",
            detail: missing.join(","),
          };
        await tx`update mission_tasks set result = ${tx.json({ reportedBy: "AGENT_REPORTED", summary: body.data.summary, evidence: body.data.evidence })} where task_id = ${String(t.task_id)}`;
        await this.setState(
          tx,
          t,
          "COMPLETED",
          "COMPLETED",
          { kind: "AGENT", id: caller.id },
          now,
        );
        await this.reconcile(tx, m, now);
        const [after] =
          await tx`select * from mission_tasks where task_id = ${String(t.task_id)}`;
        return { ok: true, value: toTask(after!, []) };
      }),
    );
  }

  async fail(
    caller: MissionCaller,
    taskId: string,
    rawBody: unknown,
  ): Promise<PResult<TaskView>> {
    const body = FailSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    return this.afterTask(
      caller,
      taskId,
      "TASK_FAILED",
      await this.withTask(caller, taskId, async (tx, t, m, now) => {
        if (caller.kind !== "AGENT" || t.assigned_agent_id !== caller.id)
          return { ok: false, refusal: "NOT_ASSIGNED" };
        if (t.state === "FAILED")
          return t.run_key === body.data.runKey
            ? { ok: true, value: toTask(t, []) }
            : { ok: false, refusal: "RUN_KEY_MISMATCH" };
        if (t.state !== "IN_PROGRESS" || t.run_key !== body.data.runKey)
          return {
            ok: false,
            refusal:
              t.state !== "IN_PROGRESS" ? "WRONG_STATE" : "RUN_KEY_MISMATCH",
          };
        await tx`update mission_tasks set failure = ${tx.json({ reportedBy: "AGENT_REPORTED", reason: body.data.reason })} where task_id = ${String(t.task_id)}`;
        await this.setState(
          tx,
          t,
          "FAILED",
          "FAILED",
          { kind: "AGENT", id: caller.id },
          now,
          { detail: body.data.reason },
        );
        await this.reconcile(tx, m, now);
        const [after] =
          await tx`select * from mission_tasks where task_id = ${String(t.task_id)}`;
        return { ok: true, value: toTask(after!, []) };
      }),
    );
  }

  async handoff(
    caller: MissionCaller,
    taskId: string,
    rawBody: unknown,
  ): Promise<PResult<TaskView>> {
    const body = HandoffSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    return this.afterTask(
      caller,
      taskId,
      "TASK_HANDED_OFF",
      await this.withTask(caller, taskId, async (tx, t, _m, now) => {
        if (caller.kind !== "AGENT" || t.assigned_agent_id !== caller.id)
          return { ok: false, refusal: "NOT_ASSIGNED" };
        if (t.state === "HANDED_OFF") return { ok: true, value: toTask(t, []) };
        if (t.state !== "IN_PROGRESS" || t.run_key !== body.data.runKey)
          return {
            ok: false,
            refusal:
              t.state !== "IN_PROGRESS" ? "WRONG_STATE" : "RUN_KEY_MISMATCH",
          };
        await tx`update mission_tasks set result = ${tx.json({ reportedBy: "AGENT_REPORTED", handoffNote: body.data.note })} where task_id = ${String(t.task_id)}`;
        await this.setState(
          tx,
          t,
          "HANDED_OFF",
          "HANDED_OFF",
          { kind: "AGENT", id: caller.id },
          now,
          { detail: body.data.note },
        );
        const [after] =
          await tx`select * from mission_tasks where task_id = ${String(t.task_id)}`;
        return { ok: true, value: toTask(after!, []) };
      }),
    );
  }

  /** Member actions on a task: approve (owner), confirm-handoff, skip, invalidate, retry. */
  async memberAction(
    caller: MissionCaller,
    taskId: string,
    op: "approve" | "confirm-handoff" | "skip" | "invalidate" | "retry",
    rawBody: unknown,
  ): Promise<PResult<TaskView>> {
    if (caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "NOT_ASSIGNED",
        detail: "ONLY_A_MEMBER_DOES_THIS",
      };
    const body = MemberTaskSchema.safeParse(rawBody ?? {});
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    return this.afterTask(
      caller,
      taskId,
      `TASK_${op.toUpperCase().replace("-", "_")}`,
      await this.withTask(caller, taskId, async (tx, t, m, now) => {
        const actor = { kind: "MEMBER" as const, id: caller.id };
        const state = t.state as TaskState;
        if (op === "approve") {
          if (state !== "AWAITING_APPROVAL")
            return { ok: false, refusal: "WRONG_STATE", detail: state };
          await tx`update mission_tasks set approved_by = ${caller.id}, approved_at = ${now} where task_id = ${String(t.task_id)}`;
          await this.reconcile(tx, m, now);
        } else if (op === "confirm-handoff") {
          if (t.readiness === "EXECUTABLE" && state !== "HANDED_OFF")
            return { ok: false, refusal: "NOT_A_HANDOFF" };
          if (!["READY", "HANDED_OFF", "IN_PROGRESS"].includes(state))
            return { ok: false, refusal: "WRONG_STATE", detail: state };
          const have = new Set((body.data.evidence ?? []).map((e) => e.kind));
          const missing = (t.required_evidence as string[]).filter(
            (k) => !have.has(k),
          );
          if (missing.length)
            return {
              ok: false,
              refusal: "MISSING_EVIDENCE",
              detail: missing.join(","),
            };
          // Labelled as reported by a person; it is not provider-confirmed.
          await tx`update mission_tasks set result = ${tx.json({ reportedBy: "OWNER_REPORTED", summary: body.data.summary ?? "", evidence: body.data.evidence ?? [] })} where task_id = ${String(t.task_id)}`;
          await this.setState(
            tx,
            t,
            "COMPLETED",
            "HANDOFF_CONFIRMED",
            actor,
            now,
          );
          await this.reconcile(tx, m, now);
        } else if (op === "skip") {
          if (DONE.includes(state))
            return { ok: false, refusal: "WRONG_STATE", detail: state };
          await this.setState(tx, t, "SKIPPED", "SKIPPED", actor, now, {
            detail: body.data.reason,
          });
          await this.reconcile(tx, m, now);
        } else if (op === "invalidate") {
          if (state === "INVALIDATED" || state === "COMPLETED")
            return { ok: false, refusal: "WRONG_STATE", detail: state };
          await this.setState(tx, t, "INVALIDATED", "INVALIDATED", actor, now, {
            detail: body.data.reason,
          });
          await this.reconcile(tx, m, now);
        } else {
          if (state !== "FAILED")
            return { ok: false, refusal: "WRONG_STATE", detail: state };
          await tx`update mission_tasks set run_key = null, failure = null where task_id = ${String(t.task_id)}`;
          await this.setState(tx, t, "BLOCKED", "RETRY", actor, now, {
            detail: body.data.reason,
          });
          await this.reconcile(tx, m, now);
        }
        const [after] =
          await tx`select * from mission_tasks where task_id = ${String(t.task_id)}`;
        return { ok: true, value: toTask(after!, []) };
      }),
    );
  }

  private async afterTask(
    caller: MissionCaller,
    taskId: string,
    action: string,
    r: PResult<TaskView>,
  ): Promise<PResult<TaskView>> {
    if (r.ok)
      await this.audit(
        caller,
        action,
        taskId,
        { state: r.value.state },
        this.deps.now(),
      ).catch(() => undefined);
    return r;
  }
}
