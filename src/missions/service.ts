import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import {
  CAPABILITIES,
  contractDigest,
  MissionContractSchema,
  normalize,
  wideningReasons,
  type Capability,
  type MissionContract,
} from "./contract.js";

/**
 * Mission lifecycle. One class owns every state change so the rules live in one place:
 *
 *   DRAFT ──submit──▶ PENDING_OWNER_APPROVAL ──approve──▶ ACTIVE ⇄ PAUSED
 *   any non-terminal ──cancel──▶ CANCELLED     any non-terminal ──revoke──▶ REVOKED
 *   ACTIVE/PAUSED ──complete──▶ COMPLETED      ACTIVE/PAUSED ──deadline──▶ EXPIRED (recorded by SYSTEM)
 *
 * Rules enforced here, not in the UI and not in a prompt:
 *  - tenant, environment and acting identity come from the authenticated caller, never the body;
 *  - only an approver may put a version in force, and only a version that exists and is PENDING or a first draft;
 *  - a revision that grants anything its predecessor did not (see `wideningReasons`) never takes effect without an owner approval,
 *    and an agent-authored revision never takes effect without one;
 *  - the version in force is the last APPROVED version; a pending revision changes nothing until approved;
 *  - stale writers lose: revisions name the version they were based on, control operations may name the row version;
 *  - every transition is an append-only row, and every change is mirrored to the organization audit trail.
 */
export type MissionStatus =
  | "DRAFT"
  | "PENDING_OWNER_APPROVAL"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";
const TERMINAL: readonly MissionStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "REVOKED",
  "FAILED",
];

export interface MissionCaller {
  readonly organizationId: string;
  readonly environment: Environment;
  readonly id: string;
  readonly kind: "MEMBER" | "AGENT";
}

export type MissionRefusal =
  | "MALFORMED"
  | "INVALID_CONTRACT"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "STALE_ROW_VERSION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "ILLEGAL_TRANSITION"
  | "MISSION_TERMINAL"
  | "NOTHING_TO_APPROVE"
  | "VERSION_MISMATCH"
  | "ALREADY_EXPIRED"
  | "AGENT_NOT_IN_ORGANIZATION"
  | "EXPIRY_IN_PAST"
  | "NOT_ASSIGNED";

export interface MissionRecord {
  readonly missionId: string;
  readonly organizationId: string;
  readonly environment: Environment;
  readonly status: MissionStatus;
  readonly latestVersion: number;
  readonly activeVersion: number | null;
  readonly pendingVersion: number | null;
  readonly rowVersion: number;
  readonly createdByMemberId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MissionView extends MissionRecord {
  /** The approved contract in force (null until a first approval). */
  readonly activeContract: MissionContract | null;
  /** The proposed contract awaiting an owner decision, and why it needs one. */
  readonly pendingContract: MissionContract | null;
  readonly pendingReasons: readonly string[];
  /** The newest stored contract (draft or proposal), for editing. */
  readonly latestContract: MissionContract;
}
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: MissionRefusal; detail?: string };

const IdemKey = z.string().min(16).max(128);
export const CreateRequestSchema = z
  .object({ contract: z.unknown(), idempotencyKey: IdemKey })
  .strict();
export const ReviseRequestSchema = z
  .object({
    baseVersion: z.number().int().min(1),
    contract: z.unknown(),
    idempotencyKey: IdemKey,
  })
  .strict();
export const ControlRequestSchema = z
  .object({
    reason: z.string().trim().max(300).optional(),
    expectedRowVersion: z.number().int().min(1).optional(),
  })
  .strict();
export const DecisionRequestSchema = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().max(300).optional(),
    expectedRowVersion: z.number().int().min(1).optional(),
  })
  .strict();

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const iso = (v: unknown) => new Date(v as string).toISOString();

type Row = Record<string, unknown>;
const toRecord = (r: Row): MissionRecord => ({
  missionId: String(r.mission_id),
  organizationId: String(r.organization_id),
  environment: r.environment as Environment,
  status: r.status as MissionStatus,
  latestVersion: Number(r.latest_version),
  activeVersion: r.active_version === null ? null : Number(r.active_version),
  pendingVersion: r.pending_version === null ? null : Number(r.pending_version),
  rowVersion: Number(r.row_version),
  createdByMemberId: String(r.created_by_member_id),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class MissionService {
  constructor(
    private readonly deps: { sql: Sql; audit: AuditLog; now: () => string },
  ) {}

  // ------------------------------------------------------------------------------------------------- helpers
  private parseContract(raw: unknown): Result<MissionContract> {
    const parsed = MissionContractSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        refusal: "INVALID_CONTRACT",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".")}:${i.message}`)
          .slice(0, 5)
          .join(" | "),
      };
    return { ok: true, value: normalize(parsed.data) };
  }

  private async agentsExist(
    sql: Sql | TransactionSql,
    caller: MissionCaller,
    contract: MissionContract,
  ): Promise<boolean> {
    for (const a of contract.agents) {
      const [row] = await sql`
        select lifecycle from organization_agents
        where organization_id = ${caller.organizationId} and environment = ${caller.environment} and agent_id = ${a.agentId}`;
      if (
        !row ||
        ["SUSPENDED", "REVOKED", "RETIRED"].includes(String(row.lifecycle))
      )
        return false;
    }
    return true;
  }

  private async lock(
    tx: TransactionSql,
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
  ): Promise<Row | null> {
    const [row] = await tx`
      select * from missions where mission_id = ${missionId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}
      for update`;
    return row ?? null;
  }

  private async contractOf(
    sql: Sql | TransactionSql,
    missionId: string,
    version: number,
  ): Promise<MissionContract> {
    const [row] =
      await sql`select contract from mission_versions where mission_id = ${missionId} and version = ${version}`;
    return MissionContractSchema.parse(row!.contract);
  }

  private async transition(
    tx: TransactionSql,
    missionId: string,
    from: MissionStatus | null,
    to: MissionStatus,
    event: string,
    actor: { kind: "MEMBER" | "AGENT" | "SYSTEM"; id: string },
    version: number | null,
    reason: string | undefined,
    now: string,
  ) {
    const [last] =
      await tx`select coalesce(max(seq), 0)::int n from mission_transitions where mission_id = ${missionId}`;
    await tx`insert into mission_transitions (mission_id, seq, from_status, to_status, event, actor_kind, actor_id, version, reason, occurred_at)
      values (${missionId}, ${Number(last!.n) + 1}, ${from}, ${to}, ${event}, ${actor.kind}, ${actor.id}, ${version}, ${reason?.slice(0, 300) ?? null}, ${now})`;
  }

  private async audit(
    caller:
      | MissionCaller
      | {
          organizationId: string;
          environment: Environment;
          kind: "SYSTEM";
          id: string;
        },
    action: string,
    missionId: string,
    detail: Record<string, string | number>,
    now: string,
  ) {
    await this.deps.audit.append({
      organizationId: caller.organizationId,
      environment: caller.environment,
      actorKind:
        caller.kind === "MEMBER"
          ? "MEMBER"
          : caller.kind === "AGENT"
            ? "AGENT_CREDENTIAL"
            : "SYSTEM",
      actorId: caller.id,
      action,
      subjectKind: "MISSION",
      subjectId: missionId,
      detail,
      occurredAt: now,
    });
  }

  private async insertVersion(
    tx: TransactionSql,
    missionId: string,
    version: number,
    contract: MissionContract,
    author: { kind: "MEMBER" | "AGENT"; id: string },
    widening: readonly string[],
    decision: "PENDING" | "APPROVED",
    decider: string | null,
    idem: string,
    requestDigest: string,
    now: string,
  ) {
    await tx`insert into mission_versions
      (mission_id, version, contract, contract_digest, authored_by_kind, authored_by, widening, decision, decided_by, decided_at,
       idempotency_key, request_digest, created_at)
      values (${missionId}, ${version}, ${tx.json(contract)}, ${contractDigest(contract)}, ${author.kind}, ${author.id},
        ${tx.json(widening)}, ${decision}, ${decider}, ${decision === "APPROVED" ? now : null}, ${idem}, ${requestDigest}, ${now})`;
    for (const a of contract.agents)
      await tx`insert into mission_agent_grants (mission_id, version, agent_id, capabilities)
        values (${missionId}, ${version}, ${a.agentId}, ${a.capabilities})`;
  }

  // ------------------------------------------------------------------------------------------------ create
  async create(
    caller: MissionCaller,
    rawBody: unknown,
  ): Promise<Result<MissionView & { replayed: boolean }>> {
    // Only an authenticated member creates a mission; an agent never does.
    if (caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "NOT_ASSIGNED",
        detail: "ONLY_A_MEMBER_CAN_CREATE",
      };
    const body = CreateRequestSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const contract = this.parseContract(body.data.contract);
    if (!contract.ok) return contract;
    const now = this.deps.now();
    if (Date.parse(contract.value.expiresAt) <= Date.parse(now))
      return { ok: false, refusal: "EXPIRY_IN_PAST" };
    if (!(await this.agentsExist(this.deps.sql, caller, contract.value)))
      return { ok: false, refusal: "AGENT_NOT_IN_ORGANIZATION" };
    const requestDigest = digest({ op: "create", contract: contract.value });
    const missionId = `msn_${randomBytes(12).toString("hex")}`;
    const outcome = await this.deps.sql.begin(async (tx) => {
      const inserted = await tx`
        insert into missions (mission_id, organization_id, environment, created_by_member_id, status, latest_version, row_version,
          idempotency_key, request_digest, created_at, updated_at)
        values (${missionId}, ${caller.organizationId}, ${caller.environment}, ${caller.id}, 'DRAFT', 1, 1,
          ${body.data.idempotencyKey}, ${requestDigest}, ${now}, ${now})
        on conflict (organization_id, environment, idempotency_key) do nothing returning mission_id`;
      if (inserted.length === 0) {
        const [prior] = await tx`select mission_id, request_digest from missions
          where organization_id = ${caller.organizationId} and environment = ${caller.environment} and idempotency_key = ${body.data.idempotencyKey}`;
        return prior!.request_digest === requestDigest
          ? ({ replay: String(prior!.mission_id) } as const)
          : ({ reused: true } as const);
      }
      await this.insertVersion(
        tx,
        missionId,
        1,
        contract.value,
        { kind: "MEMBER", id: caller.id },
        [],
        "PENDING",
        null,
        body.data.idempotencyKey,
        requestDigest,
        now,
      );
      await this.transition(
        tx,
        missionId,
        null,
        "DRAFT",
        "CREATED",
        { kind: "MEMBER", id: caller.id },
        1,
        undefined,
        now,
      );
      return { created: missionId } as const;
    });
    if ("reused" in outcome)
      return { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const id = "replay" in outcome ? outcome.replay : outcome.created;
    if ("created" in outcome)
      await this.audit(
        caller,
        "MISSION_CREATED",
        id,
        {
          version: 1,
          currency: contract.value.currency,
          budgetMinor: contract.value.totalBudgetMinor,
        },
        now,
      );
    const view = await this.get(caller, id);
    return view.ok
      ? { ok: true, value: { ...view.value, replayed: "replay" in outcome } }
      : view;
  }

  // -------------------------------------------------------------------------------------------------- read
  async get(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
  ): Promise<Result<MissionView>> {
    const sql = this.deps.sql;
    const [row] =
      await sql`select * from missions where mission_id = ${missionId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
    if (!row) return { ok: false, refusal: "NOT_FOUND" };
    const rec = toRecord(row);
    const [pending, active, latest] = await Promise.all([
      rec.pendingVersion
        ? this.contractOf(sql, rec.missionId, rec.pendingVersion)
        : null,
      rec.activeVersion
        ? this.contractOf(sql, rec.missionId, rec.activeVersion)
        : null,
      this.contractOf(sql, rec.missionId, rec.latestVersion),
    ]);
    const reasons = rec.pendingVersion
      ? ((
          await sql`select widening from mission_versions where mission_id = ${rec.missionId} and version = ${rec.pendingVersion}`
        )[0]!.widening as string[])
      : [];
    return {
      ok: true,
      value: {
        ...rec,
        activeContract: active,
        pendingContract: pending,
        pendingReasons: reasons,
        latestContract: latest,
      },
    };
  }

  async list(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    filter: { status?: MissionStatus; limit?: number; after?: string } = {},
  ): Promise<{ missions: readonly MissionRecord[]; next: string | null }> {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const sql = this.deps.sql;
    let afterAt: string | null = null;
    let afterId: string | null = null;
    if (filter.after) {
      const [c] =
        await sql`select created_at, mission_id from missions where mission_id = ${filter.after}
        and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
      if (c) {
        afterAt = iso(c.created_at);
        afterId = String(c.mission_id);
      }
    }
    const rows = await sql`
      select * from missions
      where organization_id = ${caller.organizationId} and environment = ${caller.environment}
        and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
        and (${afterAt}::timestamptz is null or (created_at, mission_id) > (${afterAt}::timestamptz, ${afterId}))
      order by created_at, mission_id limit ${limit + 1}`;
    const page = rows.slice(0, limit).map(toRecord);
    return {
      missions: page,
      next: rows.length > limit ? page[page.length - 1]!.missionId : null,
    };
  }

  async history(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
  ) {
    const found = await this.get(caller, missionId);
    if (!found.ok) return found;
    const sql = this.deps.sql;
    const transitions =
      await sql`select seq, from_status, to_status, event, actor_kind, actor_id, version, reason, occurred_at
      from mission_transitions where mission_id = ${missionId} order by seq`;
    const versions =
      await sql`select version, contract_digest, authored_by_kind, authored_by, widening, decision, decided_by, decided_at, decision_reason, created_at
      from mission_versions where mission_id = ${missionId} order by version`;
    return {
      ok: true as const,
      value: {
        transitions: transitions.map((t) => ({
          seq: Number(t.seq),
          from: t.from_status as string | null,
          to: String(t.to_status),
          event: String(t.event),
          actorKind: String(t.actor_kind),
          actorId: String(t.actor_id),
          version: t.version === null ? null : Number(t.version),
          reason: (t.reason as string | null) ?? null,
          at: iso(t.occurred_at),
        })),
        versions: versions.map((v) => ({
          version: Number(v.version),
          digest: String(v.contract_digest).trim(),
          authoredByKind: String(v.authored_by_kind),
          authoredBy: String(v.authored_by),
          widening: v.widening as string[],
          decision: String(v.decision),
          decidedBy: (v.decided_by as string | null) ?? null,
          decidedAt: v.decided_at ? iso(v.decided_at) : null,
          reason: (v.decision_reason as string | null) ?? null,
          createdAt: iso(v.created_at),
        })),
      },
    };
  }

  // ------------------------------------------------------------------------------------------------ revise
  /**
   * A revision names the version it was based on (`baseVersion`) and must equal the newest stored version: concurrent editors
   * cannot overwrite each other. On a mission with no approved version yet it replaces the working draft. On a mission in
   * force it either takes effect immediately (a MEMBER narrowing it) or waits for an owner (anything wider, or any agent).
   */
  async revise(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<Result<MissionView & { applied: boolean; replayed: boolean }>> {
    const body = ReviseRequestSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const contract = this.parseContract(body.data.contract);
    if (!contract.ok) return contract;
    const now = this.deps.now();
    const requestDigest = digest({
      op: "revise",
      missionId,
      base: body.data.baseVersion,
      contract: contract.value,
    });
    // Existence in THIS tenant is established first, so another tenant's mission is indistinguishable from none.
    const [exists] = await this.deps
      .sql`select 1 from missions where mission_id = ${missionId}
      and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
    if (!exists) return { ok: false, refusal: "NOT_FOUND" };
    if (!(await this.agentsExist(this.deps.sql, caller, contract.value)))
      return { ok: false, refusal: "AGENT_NOT_IN_ORGANIZATION" };
    const outcome = await this.deps.sql.begin(
      async (
        tx,
      ): Promise<
        Result<{ applied: boolean; replayed: boolean; version: number }>
      > => {
        const m = await this.lock(tx, caller, missionId);
        if (!m) return { ok: false, refusal: "NOT_FOUND" };
        const rec = toRecord(m);
        const [prior] =
          await tx`select version, request_digest from mission_versions where mission_id = ${missionId} and idempotency_key = ${body.data.idempotencyKey}`;
        if (prior)
          return prior.request_digest === requestDigest
            ? {
                ok: true,
                value: {
                  applied: rec.activeVersion === Number(prior.version),
                  replayed: true,
                  version: Number(prior.version),
                },
              }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        if (TERMINAL.includes(rec.status))
          return { ok: false, refusal: "MISSION_TERMINAL" };
        if (body.data.baseVersion !== rec.latestVersion)
          return { ok: false, refusal: "STALE_VERSION" };
        if (Date.parse(contract.value.expiresAt) <= Date.parse(now))
          return { ok: false, refusal: "EXPIRY_IN_PAST" };
        const version = rec.latestVersion + 1;
        const hasActive = rec.activeVersion !== null;
        let widening: string[] = [];
        let applyNow = false;
        if (hasActive) {
          widening = wideningReasons(
            await this.contractOf(tx, missionId, rec.activeVersion),
            contract.value,
          );
          // Only a MEMBER, and only a non-widening revision, takes effect without an owner decision.
          applyNow = caller.kind === "MEMBER" && widening.length === 0;
          if (caller.kind === "AGENT")
            widening = widening.length ? widening : ["AGENT_PROPOSAL"];
        }
        // An agent may only PROPOSE a change to a mission in force; it never edits a draft.
        if (!hasActive && caller.kind === "AGENT")
          return {
            ok: false,
            refusal: "NOT_ASSIGNED",
            detail: "AGENTS_CANNOT_EDIT_A_DRAFT",
          };
        if (!hasActive)
          // Still a draft: supersede the previous working version.
          await tx`update mission_versions set decision = 'SUPERSEDED', decided_by = ${caller.id}, decided_at = ${now}
            where mission_id = ${missionId} and version = ${rec.latestVersion} and decision = 'PENDING'`;
        await this.insertVersion(
          tx,
          missionId,
          version,
          contract.value,
          { kind: caller.kind, id: caller.id },
          widening,
          applyNow ? "APPROVED" : "PENDING",
          applyNow ? caller.id : null,
          body.data.idempotencyKey,
          requestDigest,
          now,
        );
        if (applyNow) {
          await tx`update mission_versions set decision = 'SUPERSEDED' where mission_id = ${missionId} and version = ${rec.pendingVersion ?? 0} and decision = 'PENDING'`;
          await tx`update mission_versions set decision = 'SUPERSEDED' where mission_id = ${missionId} and version = ${rec.activeVersion} and decision = 'APPROVED'`;
          await tx`update missions set latest_version = ${version}, active_version = ${version}, pending_version = null, row_version = row_version + 1, updated_at = ${now} where mission_id = ${missionId}`;
          await this.transition(
            tx,
            missionId,
            rec.status,
            rec.status,
            "REVISION_APPLIED",
            { kind: caller.kind, id: caller.id },
            version,
            "NARROWING_ONLY",
            now,
          );
        } else if (hasActive) {
          if (rec.pendingVersion)
            await tx`update mission_versions set decision = 'SUPERSEDED', decided_by = ${caller.id}, decided_at = ${now} where mission_id = ${missionId} and version = ${rec.pendingVersion} and decision = 'PENDING'`;
          await tx`update missions set latest_version = ${version}, pending_version = ${version}, row_version = row_version + 1, updated_at = ${now} where mission_id = ${missionId}`;
          await this.transition(
            tx,
            missionId,
            rec.status,
            rec.status,
            "REVISION_PROPOSED",
            { kind: caller.kind, id: caller.id },
            version,
            widening.join(",").slice(0, 300),
            now,
          );
        } else {
          await tx`update missions set latest_version = ${version}, row_version = row_version + 1, updated_at = ${now} where mission_id = ${missionId}`;
          await tx`update missions set pending_version = ${rec.status === "PENDING_OWNER_APPROVAL" ? version : null} where mission_id = ${missionId}`;
          await this.transition(
            tx,
            missionId,
            rec.status,
            rec.status,
            "DRAFT_REVISED",
            { kind: caller.kind, id: caller.id },
            version,
            undefined,
            now,
          );
        }
        return {
          ok: true,
          value: { applied: applyNow, replayed: false, version },
        };
      },
    );
    if (!outcome.ok) return outcome;
    if (!outcome.value.replayed)
      await this.audit(
        caller,
        outcome.value.applied
          ? "MISSION_REVISION_APPLIED"
          : "MISSION_REVISION_PROPOSED",
        missionId,
        { version: outcome.value.version },
        now,
      );
    const view = await this.get(caller, missionId);
    return view.ok
      ? {
          ok: true,
          value: {
            ...view.value,
            applied: outcome.value.applied,
            replayed: outcome.value.replayed,
          },
        }
      : view;
  }

  // ------------------------------------------------------------------------------------------------- submit
  async submit(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<Result<MissionView>> {
    return this.control(caller, missionId, rawBody, "submit");
  }

  // ------------------------------------------------------------------------------------------------ decide
  /** Owner decision on a version: put it in force, or refuse it. Only an authenticated MEMBER with the approve permission reaches this. */
  async decide(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
    decision: "APPROVE" | "REJECT",
  ): Promise<Result<MissionView>> {
    if (caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "NOT_ASSIGNED",
        detail: "ONLY_A_MEMBER_CAN_DECIDE",
      };
    const body = DecisionRequestSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const now = this.deps.now();
    const outcome = await this.deps.sql.begin(
      async (tx): Promise<Result<true>> => {
        const m = await this.lock(tx, caller, missionId);
        if (!m) return { ok: false, refusal: "NOT_FOUND" };
        const rec = toRecord(m);
        if (TERMINAL.includes(rec.status))
          return { ok: false, refusal: "MISSION_TERMINAL" };
        if (
          body.data.expectedRowVersion !== undefined &&
          body.data.expectedRowVersion !== rec.rowVersion
        )
          return { ok: false, refusal: "STALE_ROW_VERSION" };
        const candidate =
          rec.pendingVersion ??
          (rec.activeVersion === null ? rec.latestVersion : null);
        if (candidate === null)
          return { ok: false, refusal: "NOTHING_TO_APPROVE" };
        if (candidate !== body.data.version)
          return { ok: false, refusal: "VERSION_MISMATCH" };
        const [v] =
          await tx`select decision from mission_versions where mission_id = ${missionId} and version = ${candidate}`;
        if (!v || v.decision !== "PENDING")
          return { ok: false, refusal: "NOTHING_TO_APPROVE" };
        if (decision === "REJECT") {
          await tx`update mission_versions set decision = 'REJECTED', decided_by = ${caller.id}, decided_at = ${now}, decision_reason = ${body.data.reason?.slice(0, 300) ?? null}
          where mission_id = ${missionId} and version = ${candidate}`;
          const back: MissionStatus =
            rec.status === "PENDING_OWNER_APPROVAL" ? "DRAFT" : rec.status;
          await tx`update missions set pending_version = null, status = ${back}, row_version = row_version + 1, updated_at = ${now} where mission_id = ${missionId}`;
          await this.transition(
            tx,
            missionId,
            rec.status,
            back,
            "VERSION_REJECTED",
            { kind: "MEMBER", id: caller.id },
            candidate,
            body.data.reason,
            now,
          );
          return { ok: true, value: true };
        }
        const contract = await this.contractOf(tx, missionId, candidate);
        if (Date.parse(contract.expiresAt) <= Date.parse(now))
          return { ok: false, refusal: "ALREADY_EXPIRED" };
        if (!(await this.agentsExist(tx, caller, contract)))
          return { ok: false, refusal: "AGENT_NOT_IN_ORGANIZATION" };
        if (rec.activeVersion !== null)
          await tx`update mission_versions set decision = 'SUPERSEDED' where mission_id = ${missionId} and version = ${rec.activeVersion} and decision = 'APPROVED'`;
        await tx`update mission_versions set decision = 'APPROVED', decided_by = ${caller.id}, decided_at = ${now}, decision_reason = ${body.data.reason?.slice(0, 300) ?? null}
        where mission_id = ${missionId} and version = ${candidate}`;
        const to: MissionStatus =
          rec.status === "DRAFT" || rec.status === "PENDING_OWNER_APPROVAL"
            ? "ACTIVE"
            : rec.status;
        await tx`update missions set active_version = ${candidate}, pending_version = null, status = ${to}, row_version = row_version + 1, updated_at = ${now} where mission_id = ${missionId}`;
        await this.transition(
          tx,
          missionId,
          rec.status,
          to,
          "VERSION_APPROVED",
          { kind: "MEMBER", id: caller.id },
          candidate,
          body.data.reason,
          now,
        );
        return { ok: true, value: true };
      },
    );
    if (!outcome.ok) return outcome;
    await this.audit(
      caller,
      decision === "APPROVE"
        ? "MISSION_VERSION_APPROVED"
        : "MISSION_VERSION_REJECTED",
      missionId,
      { version: body.data.version },
      now,
    );
    return this.get(caller, missionId);
  }

  // ----------------------------------------------------------------------------------------------- control
  async control(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
    op: "submit" | "pause" | "resume" | "cancel" | "revoke" | "complete",
  ): Promise<Result<MissionView>> {
    if (caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "NOT_ASSIGNED",
        detail: "ONLY_A_MEMBER_CAN_CONTROL",
      };
    const body = ControlRequestSchema.safeParse(rawBody ?? {});
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const now = this.deps.now();
    const rules: Record<
      typeof op,
      { from: readonly MissionStatus[]; to: MissionStatus; event: string }
    > = {
      submit: {
        from: ["DRAFT"],
        to: "PENDING_OWNER_APPROVAL",
        event: "SUBMITTED",
      },
      pause: { from: ["ACTIVE"], to: "PAUSED", event: "PAUSED" },
      resume: { from: ["PAUSED"], to: "ACTIVE", event: "RESUMED" },
      cancel: {
        from: ["DRAFT", "PENDING_OWNER_APPROVAL", "ACTIVE", "PAUSED"],
        to: "CANCELLED",
        event: "CANCELLED",
      },
      revoke: {
        from: ["DRAFT", "PENDING_OWNER_APPROVAL", "ACTIVE", "PAUSED"],
        to: "REVOKED",
        event: "REVOKED",
      },
      complete: {
        from: ["ACTIVE", "PAUSED"],
        to: "COMPLETED",
        event: "COMPLETED",
      },
    };
    const rule = rules[op];
    const outcome = await this.deps.sql.begin(
      async (tx): Promise<Result<true>> => {
        const m = await this.lock(tx, caller, missionId);
        if (!m) return { ok: false, refusal: "NOT_FOUND" };
        const rec = toRecord(m);
        if (TERMINAL.includes(rec.status))
          return { ok: false, refusal: "MISSION_TERMINAL" };
        if (
          body.data.expectedRowVersion !== undefined &&
          body.data.expectedRowVersion !== rec.rowVersion
        )
          return { ok: false, refusal: "STALE_ROW_VERSION" };
        if (!rule.from.includes(rec.status))
          return {
            ok: false,
            refusal: "ILLEGAL_TRANSITION",
            detail: `${rec.status}->${rule.to}`,
          };
        if (op === "resume" || op === "submit") {
          const v = op === "resume" ? rec.activeVersion : rec.latestVersion;
          if (
            v !== null &&
            Date.parse((await this.contractOf(tx, missionId, v)).expiresAt) <=
              Date.parse(now)
          )
            return { ok: false, refusal: "ALREADY_EXPIRED" };
        }
        await tx`update missions set status = ${rule.to}, row_version = row_version + 1, updated_at = ${now},
        pending_version = ${op === "submit" ? rec.latestVersion : op === "cancel" || op === "revoke" ? null : rec.pendingVersion}
        where mission_id = ${missionId}`;
        if (op === "cancel" || op === "revoke")
          await tx`update mission_versions set decision = 'SUPERSEDED' where mission_id = ${missionId} and decision = 'PENDING'`;
        await this.transition(
          tx,
          missionId,
          rec.status,
          rule.to,
          rule.event,
          { kind: caller.kind, id: caller.id },
          rec.activeVersion ?? rec.latestVersion,
          body.data.reason,
          now,
        );
        return { ok: true, value: true };
      },
    );
    if (!outcome.ok) return outcome;
    await this.audit(caller, `MISSION_${rule.event}`, missionId, { op }, now);
    return this.get(caller, missionId);
  }

  // ----------------------------------------------------------------------------------------------- expiry
  /** Records EXPIRED for every ACTIVE/PAUSED mission whose approved contract is past its deadline. Idempotent. */
  async expireDue(): Promise<number> {
    const now = this.deps.now();
    const due = await this.deps.sql`
      select m.mission_id, m.organization_id, m.environment, m.status, m.active_version
      from missions m join mission_versions v on v.mission_id = m.mission_id and v.version = m.active_version
      where m.status in ('ACTIVE','PAUSED') and (v.contract->>'expiresAt')::timestamptz <= ${now}::timestamptz`;
    let n = 0;
    for (const d of due) {
      const done = await this.deps.sql.begin(async (tx) => {
        const m = await this.lock(
          tx,
          {
            organizationId: String(d.organization_id),
            environment: d.environment as Environment,
          },
          String(d.mission_id),
        );
        if (!m || !["ACTIVE", "PAUSED"].includes(String(m.status)))
          return false;
        await tx`update missions set status = 'EXPIRED', pending_version = null, row_version = row_version + 1, updated_at = ${now} where mission_id = ${String(d.mission_id)}`;
        await tx`update mission_versions set decision = 'SUPERSEDED' where mission_id = ${String(d.mission_id)} and decision = 'PENDING'`;
        await this.transition(
          tx,
          String(d.mission_id),
          m.status as MissionStatus,
          "EXPIRED",
          "DEADLINE_PASSED",
          { kind: "SYSTEM", id: "expiry" },
          Number(d.active_version),
          undefined,
          now,
        );
        return true;
      });
      if (done) {
        n++;
        await this.audit(
          {
            organizationId: String(d.organization_id),
            environment: d.environment as Environment,
            kind: "SYSTEM",
            id: "expiry",
          },
          "MISSION_EXPIRED",
          String(d.mission_id),
          {},
          now,
        );
      }
    }
    return n;
  }

  // ------------------------------------------------------------------------------------- agent-facing
  /**
   * THE permission gate later milestones call before an agent does anything under a mission. It answers one question: may this
   * agent use this capability on this mission right now? It reads the version in force, never a draft or a pending proposal.
   * It does not authorize money; money still needs the Trust Kernel.
   */
  async authorizeCapability(
    tenant: Pick<MissionCaller, "organizationId" | "environment">,
    missionId: string,
    agentId: string,
    capability: Capability,
  ): Promise<
    { allowed: true; version: number } | { allowed: false; reason: string }
  > {
    if (!CAPABILITIES.includes(capability))
      return { allowed: false, reason: "UNKNOWN_CAPABILITY" };
    await this.expireDue().catch(() => 0);
    const sql = this.deps.sql;
    const [m] =
      await sql`select status, active_version from missions where mission_id = ${missionId}
      and organization_id = ${tenant.organizationId} and environment = ${tenant.environment}`;
    if (!m) return { allowed: false, reason: "MISSION_NOT_FOUND" };
    if (m.status !== "ACTIVE")
      return { allowed: false, reason: `MISSION_${String(m.status)}` };
    const version = Number(m.active_version);
    const [agent] =
      await sql`select lifecycle from organization_agents where organization_id = ${tenant.organizationId}
      and environment = ${tenant.environment} and agent_id = ${agentId}`;
    if (
      !agent ||
      ["SUSPENDED", "REVOKED", "RETIRED"].includes(String(agent.lifecycle))
    )
      return { allowed: false, reason: "AGENT_NOT_ACTIVE" };
    const [g] =
      await sql`select capabilities from mission_agent_grants where mission_id = ${missionId} and version = ${version} and agent_id = ${agentId}`;
    if (!g) return { allowed: false, reason: "AGENT_NOT_ASSIGNED" };
    if (!(g.capabilities as string[]).includes(capability))
      return { allowed: false, reason: "CAPABILITY_NOT_GRANTED" };
    return { allowed: true, version };
  }

  /** What one agent may see of its missions: its own capabilities and the facts it needs, not other agents' grants. */
  async forAgent(caller: MissionCaller, missionId?: string) {
    await this.expireDue().catch(() => 0);
    const sql = this.deps.sql;
    const rows = await sql`
      select m.mission_id, m.status, m.active_version, v.contract, g.capabilities
      from missions m
      join mission_agent_grants g on g.mission_id = m.mission_id and g.version = m.active_version and g.agent_id = ${caller.id}
      join mission_versions v on v.mission_id = m.mission_id and v.version = m.active_version
      where m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment} and m.status = 'ACTIVE'
        and (${missionId ?? null}::text is null or m.mission_id = ${missionId ?? null})
      order by m.created_at, m.mission_id limit 100`;
    return rows.map((r) => {
      const c = MissionContractSchema.parse(r.contract);
      return {
        missionId: String(r.mission_id),
        status: String(r.status),
        version: Number(r.active_version),
        objective: c.objective,
        intendedOutcome: c.intendedOutcome,
        successCriteria: c.successCriteria,
        currency: c.currency,
        expiresAt: c.expiresAt,
        myCapabilities: r.capabilities as string[],
      };
    });
  }
}
