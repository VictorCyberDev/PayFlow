import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import { MissionContractSchema } from "./contract.js";
import type { ConnectorCatalog } from "./plan.js";
import {
  ConnectorQuerySchema,
  ConnectorResultSchema,
  OBSERVATION_NOTICE,
  OBSERVE_CAPABILITIES,
  isObserveCapability,
  type ConnectorDefinition,
  type ConnectorObservation,
  type ConnectorRegistry,
} from "./connectors.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M31 — installing connectors and governing every call through them.
 *
 * A call is allowed only when ALL of these hold, checked in this order. A refusal before the call is claimed fetches nothing and
 * writes no call row; every call that is claimed is recorded with its outcome and audited:
 *  1. the caller is an agent, and the connector offers the capability and the capability is read-only;
 *  2. the mission is ACTIVE, not past its deadline, and grants this agent that capability (the same check as everything else);
 *  3. the approved contract names a provider type this connector serves;
 *  4. the organization installed the connector, it is enabled (not disabled or suspended), fits the environment, has the
 *     credential reference it needs, and its circuit is not open after repeated failures;
 *  5. the mission has not used up the connector's hourly allowance (counted under a lock, so concurrent calls cannot overshoot);
 *  6. the idempotency key has not been used for a different request (a repeat returns the stored result and does not call out).
 * The adapter then runs with a hard timeout and NO database connection or transaction held. Its output is bounded and parsed
 * strictly; anything else is recorded as INVALID_OUTPUT and never shown.
 */
export type ConnectorRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CONNECTOR_NOT_FOUND"
  | "CAPABILITY_NOT_OBSERVABLE"
  | "CAPABILITY_REFUSED"
  | "PROVIDER_TYPE_NOT_APPROVED"
  | "CONNECTOR_NOT_INSTALLED"
  | "CONNECTOR_DISABLED"
  | "CONNECTOR_SUSPENDED"
  | "CREDENTIAL_REQUIRED"
  | "ENVIRONMENT_MISMATCH"
  | "CONNECTOR_DEGRADED"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CALL_IN_PROGRESS"
  | "CONNECTOR_FAILED"
  | "CONNECTOR_TIMEOUT"
  | "CONNECTOR_INVALID_OUTPUT"
  | "AGENT_ONLY"
  | "MEMBER_ONLY";
export type CResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: ConnectorRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/u);
export const InstallSchema = z
  .object({
    /** The owner has read what the data may be used for. */
    acknowledgedDataUse: z.literal(true),
    credentialRef: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
      .optional(),
  })
  .strict();
export const InvokeSchema = z
  .object({
    connectorId: Id,
    capability: z.enum(OBSERVE_CAPABILITIES),
    query: ConnectorQuerySchema,
    idempotencyKey: Idem,
  })
  .strict();
const StateSchema = z
  .object({
    acknowledgedDataUse: z.literal(true).optional(),
    expectedRowVersion: z.number().int().min(1).optional(),
  })
  .strict();

const sha = (v: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(v, (_k, x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)),
            )
          : x,
      ),
    )
    .digest("hex");
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
type Tenant = Pick<MissionCaller, "organizationId" | "environment">;

export interface InstallView {
  readonly state: "ENABLED" | "DISABLED" | "SUSPENDED";
  readonly hasCredential: boolean;
  readonly consecutiveFailures: number;
  readonly breakerOpenUntil: string | null;
  readonly rowVersion: number;
  readonly installedAt: string;
  readonly updatedAt: string;
}
export type ConnectorStatus =
  | "NOT_INSTALLED"
  | "READY"
  | "DISABLED"
  | "SUSPENDED"
  | "NEEDS_CREDENTIAL"
  | "NOT_FOR_THIS_ENVIRONMENT"
  | "DEGRADED";
const toInstall = (r: Row): InstallView => ({
  state: r.state as InstallView["state"],
  hasCredential: r.credential_ref !== null,
  consecutiveFailures: Number(r.consecutive_failures),
  breakerOpenUntil: r.breaker_open_until ? iso(r.breaker_open_until) : null,
  rowVersion: Number(r.row_version),
  installedAt: iso(r.installed_at),
  updatedAt: iso(r.updated_at),
});

export class ConnectorService {
  private readonly threshold: number;
  private readonly openMs: number;
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      registry: ConnectorRegistry;
      now: () => string;
      /** Consecutive failures that open the circuit, and for how long. */
      breaker?: { threshold: number; openMs: number };
    },
  ) {
    this.threshold = deps.breaker?.threshold ?? 3;
    this.openMs = deps.breaker?.openMs ?? 5 * 60_000;
  }

  private statusOf(
    def: ConnectorDefinition,
    install: Row | undefined,
    env: Environment,
    now: string,
  ): ConnectorStatus {
    if (!install) return "NOT_INSTALLED";
    if (def.mode === "SANDBOX" && env === "PRODUCTION")
      return "NOT_FOR_THIS_ENVIRONMENT";
    if (install.state === "SUSPENDED") return "SUSPENDED";
    if (install.state === "DISABLED") return "DISABLED";
    if (def.credential === "REQUIRED" && install.credential_ref === null)
      return "NEEDS_CREDENTIAL";
    if (install.breaker_open_until && iso(install.breaker_open_until) > now)
      return "DEGRADED";
    return "READY";
  }
  private async log(
    c: Pick<MissionCaller, "organizationId" | "environment" | "id" | "kind">,
    action: string,
    subjectId: string,
    detail: Record<string, string | number>,
    now: string,
  ) {
    await this.deps.audit
      .append({
        organizationId: c.organizationId,
        environment: c.environment,
        actorKind: c.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: c.id,
        action,
        subjectKind: "CONNECTOR",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------------ catalogue
  async catalog(tenant: Tenant) {
    const now = this.deps.now();
    const rows = await this.deps
      .sql`select * from connector_installs where organization_id = ${tenant.organizationId} and environment = ${tenant.environment}`;
    return this.deps.registry.list().map((d) => {
      const r = rows.find((x) => x.connector_id === d.id);
      return {
        connectorId: d.id,
        displayName: d.displayName,
        providerTypes: d.providerTypes,
        mode: d.mode,
        capabilities: d.capabilities,
        credential: d.credential,
        dataUse: d.dataUse,
        limits: d.limits,
        status: this.statusOf(d, r, tenant.environment, now),
        install: r ? toInstall(r) : null,
      };
    });
  }

  /** What planning may rely on: provider type × capability pairs served by a connector that is READY right now. */
  async catalogFor(tenant: Tenant): Promise<ConnectorCatalog> {
    const now = this.deps.now();
    const rows = await this.deps
      .sql`select * from connector_installs where organization_id = ${tenant.organizationId} and environment = ${tenant.environment}`;
    const pairs = new Set<string>();
    for (const r of rows) {
      const d = this.deps.registry.get(String(r.connector_id));
      if (!d || this.statusOf(d, r, tenant.environment, now) !== "READY")
        continue;
      for (const t of d.providerTypes)
        for (const c of d.capabilities) pairs.add(`${t}:${c}`);
    }
    return { supports: (t, c) => pairs.has(`${t}:${c}`) };
  }

  // ------------------------------------------------------------------------------------------------ install & state
  async install(
    caller: MissionCaller,
    connectorId: string,
    rawBody: unknown,
  ): Promise<CResult<{ connector: InstallView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const def = this.deps.registry.get(connectorId);
    if (!def) return { ok: false, refusal: "CONNECTOR_NOT_FOUND" };
    const body = InstallSchema.safeParse(rawBody);
    if (!body.success)
      return { ok: false, refusal: "MALFORMED", detail: "acknowledgedDataUse" };
    if (def.mode === "SANDBOX" && caller.environment === "PRODUCTION")
      return { ok: false, refusal: "ENVIRONMENT_MISMATCH" };
    if (def.credential === "REQUIRED" && !body.data.credentialRef)
      return { ok: false, refusal: "CREDENTIAL_REQUIRED" };
    const now = this.deps.now();
    const [created] = await this.deps.sql`
      insert into connector_installs (organization_id, environment, connector_id, state, credential_ref, installed_by, state_changed_by, installed_at, updated_at)
      values (${caller.organizationId}, ${caller.environment}, ${connectorId}, 'ENABLED', ${body.data.credentialRef ?? null}, ${caller.id}, ${caller.id}, ${now}, ${now})
      on conflict do nothing returning *`;
    if (created) {
      await this.log(caller, "CONNECTOR_INSTALLED", connectorId, {}, now);
      return {
        ok: true,
        value: { connector: toInstall(created), replayed: false },
      };
    }
    const [existing] = await this.deps.sql`
      select * from connector_installs where organization_id = ${caller.organizationId} and environment = ${caller.environment} and connector_id = ${connectorId}`;
    return {
      ok: true,
      value: { connector: toInstall(existing!), replayed: true },
    };
  }

  async setState(
    caller: MissionCaller,
    connectorId: string,
    op: "enable" | "disable" | "suspend",
    rawBody: unknown,
  ): Promise<CResult<{ connector: InstallView }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const def = this.deps.registry.get(connectorId);
    if (!def) return { ok: false, refusal: "CONNECTOR_NOT_FOUND" };
    const body = StateSchema.safeParse(rawBody ?? {});
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const now = this.deps.now();
    const out = await this.deps.sql.begin(
      async (tx): Promise<CResult<{ connector: InstallView }>> => {
        const [r] = await tx`
          select * from connector_installs where organization_id = ${caller.organizationId} and environment = ${caller.environment}
          and connector_id = ${connectorId} for update`;
        if (!r) return { ok: false, refusal: "CONNECTOR_NOT_INSTALLED" };
        if (
          body.data.expectedRowVersion !== undefined &&
          body.data.expectedRowVersion !== Number(r.row_version)
        )
          return {
            ok: false,
            refusal: "MALFORMED",
            detail: "STALE_ROW_VERSION",
          };
        const target =
          op === "enable"
            ? "ENABLED"
            : op === "disable"
              ? "DISABLED"
              : "SUSPENDED";
        if (op === "enable") {
          if (def.mode === "SANDBOX" && caller.environment === "PRODUCTION")
            return { ok: false, refusal: "ENVIRONMENT_MISMATCH" };
          if (def.credential === "REQUIRED" && r.credential_ref === null)
            return { ok: false, refusal: "CREDENTIAL_REQUIRED" };
          // Re-enabling something an owner disabled needs the data-use acknowledgement again; lifting a suspension does not.
          if (r.state === "DISABLED" && body.data.acknowledgedDataUse !== true)
            return {
              ok: false,
              refusal: "MALFORMED",
              detail: "acknowledgedDataUse",
            };
        }
        if (r.state === target)
          return { ok: true, value: { connector: toInstall(r) } };
        const [u] = await tx`
          update connector_installs set state = ${target}, state_changed_by = ${caller.id}, updated_at = ${now},
            row_version = row_version + 1,
            consecutive_failures = ${op === "enable" ? 0 : Number(r.consecutive_failures)},
            breaker_open_until = ${op === "enable" ? null : (r.breaker_open_until as Date | null)}
          where organization_id = ${caller.organizationId} and environment = ${caller.environment} and connector_id = ${connectorId}
          returning *`;
        return { ok: true, value: { connector: toInstall(u!) } };
      },
    );
    if (out.ok)
      await this.log(
        caller,
        {
          enable: "CONNECTOR_ENABLED",
          disable: "CONNECTOR_DISABLED",
          suspend: "CONNECTOR_SUSPENDED",
        }[op],
        connectorId,
        {},
        now,
      );
    return out;
  }

  // ------------------------------------------------------------------------------------------------ invoke
  async invoke(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{
      callId: string;
      replayed: boolean;
      observation: ConnectorObservation;
    }>
  > {
    if (caller.kind !== "AGENT") return { ok: false, refusal: "AGENT_ONLY" };
    const parsed = InvokeSchema.safeParse(rawBody);
    if (!parsed.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const b = parsed.data;
    const def = this.deps.registry.get(b.connectorId);
    if (!def) return { ok: false, refusal: "CONNECTOR_NOT_FOUND" };
    if (
      !def.capabilities.includes(b.capability) ||
      !isObserveCapability(b.capability)
    )
      return { ok: false, refusal: "CAPABILITY_NOT_OBSERVABLE" };
    const auth = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      b.capability,
    );
    if (!auth.allowed)
      return auth.reason === "MISSION_NOT_FOUND"
        ? { ok: false, refusal: "NOT_FOUND" }
        : { ok: false, refusal: "CAPABILITY_REFUSED", detail: auth.reason };
    const sql = this.deps.sql;
    const [v] =
      await sql`select contract from mission_versions where mission_id = ${missionId} and version = ${auth.version}`;
    const contract = MissionContractSchema.parse(v!.contract);
    if (
      !def.providerTypes.some((t) => contract.approvedProviderTypes.includes(t))
    )
      return { ok: false, refusal: "PROVIDER_TYPE_NOT_APPROVED" };
    const now0 = this.deps.now();
    const [install] =
      await sql`select * from connector_installs where organization_id = ${caller.organizationId} and environment = ${caller.environment} and connector_id = ${def.id}`;
    const status = this.statusOf(def, install, caller.environment, now0);
    const gate: Partial<Record<ConnectorStatus, ConnectorRefusal>> = {
      NOT_INSTALLED: "CONNECTOR_NOT_INSTALLED",
      DISABLED: "CONNECTOR_DISABLED",
      SUSPENDED: "CONNECTOR_SUSPENDED",
      NEEDS_CREDENTIAL: "CREDENTIAL_REQUIRED",
      NOT_FOR_THIS_ENVIRONMENT: "ENVIRONMENT_MISMATCH",
      DEGRADED: "CONNECTOR_DEGRADED",
    };
    if (status !== "READY") return { ok: false, refusal: gate[status]! };

    const digest = sha({
      missionId,
      agent: caller.id,
      ...b,
      idempotencyKey: undefined,
    });
    const callId = `cal_${randomBytes(12).toString("hex")}`;
    const claimed = await sql.begin(
      async (
        tx,
      ): Promise<
        | { kind: "REFUSE"; refusal: ConnectorRefusal }
        | { kind: "REPLAY"; row: Row }
        | { kind: "RUN" }
      > => {
        await tx`select pg_advisory_xact_lock(hashtext(${missionId + "|" + def.id}))`;
        const [prior] =
          await tx`select * from connector_calls where mission_id = ${missionId} and agent_id = ${caller.id} and idempotency_key = ${b.idempotencyKey}`;
        if (prior) {
          if (prior.request_digest !== digest)
            return { kind: "REFUSE", refusal: "IDEMPOTENCY_KEY_REUSED" };
          if (prior.outcome === "PENDING") {
            const age =
              Date.parse(this.deps.now()) - Date.parse(iso(prior.started_at));
            if (age <= def.limits.timeoutMs + 5_000)
              return { kind: "REFUSE", refusal: "CALL_IN_PROGRESS" };
            const [done] =
              await tx`update connector_calls set outcome = 'ABANDONED', error_code = 'ABANDONED', finished_at = ${this.deps.now()}
              where call_id = ${String(prior.call_id)} returning *`;
            return { kind: "REPLAY", row: done! };
          }
          return { kind: "REPLAY", row: prior };
        }
        const [{ n }] =
          (await tx`select count(*)::int as n from connector_calls where mission_id = ${missionId}
          and connector_id = ${def.id} and started_at > ${new Date(Date.parse(now0) - 3_600_000).toISOString()}::timestamptz`) as unknown as [
            { n: number },
          ];
        if (n >= def.limits.callsPerHour)
          return { kind: "REFUSE", refusal: "RATE_LIMITED" };
        await tx`insert into connector_calls (call_id, organization_id, environment, mission_id, mission_version, agent_id, connector_id,
          capability, idempotency_key, request_digest, outcome, started_at)
          values (${callId}, ${caller.organizationId}, ${caller.environment}, ${missionId}, ${auth.version}, ${caller.id}, ${def.id},
          ${b.capability}, ${b.idempotencyKey}, ${digest}, 'PENDING', ${now0})`;
        return { kind: "RUN" };
      },
    );
    if (claimed.kind === "REFUSE")
      return { ok: false, refusal: claimed.refusal };
    if (claimed.kind === "REPLAY") return this.fromRow(claimed.row, def, true);

    // The adapter runs with no connection or transaction held, under a hard timeout.
    let outcome: "OK" | "ERROR" | "TIMEOUT" | "INVALID_OUTPUT" = "OK";
    let records: ConnectorObservation["records"] = [];
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const raw = await Promise.race([
        def.adapter.observe(
          { capability: b.capability, query: b.query },
          ac.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            ac.abort();
            reject(new Error("TIMEOUT"));
          }, def.limits.timeoutMs);
        }),
      ]);
      const bytes = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
      const res = ConnectorResultSchema.safeParse(raw);
      if (
        bytes > def.limits.maxResultBytes ||
        !res.success ||
        res.data.records.length > Math.min(b.query.limit, def.limits.maxRecords)
      )
        outcome = "INVALID_OUTPUT";
      else records = res.data.records;
    } catch {
      outcome = timedOut ? "TIMEOUT" : "ERROR";
    } finally {
      if (timer) clearTimeout(timer);
    }
    const finished = this.deps.now();
    const observation: ConnectorObservation = {
      connectorId: def.id,
      mode: def.mode,
      capability: b.capability,
      trust: "UNTRUSTED_OBSERVATION",
      notice: OBSERVATION_NOTICE,
      records,
    };
    const [row] = await sql.begin(async (tx) => {
      const [u] =
        await tx`update connector_calls set outcome = ${outcome}, record_count = ${outcome === "OK" ? records.length : null},
        result = ${outcome === "OK" ? tx.json(observation as never) : null}, error_code = ${outcome === "OK" ? null : outcome}, finished_at = ${finished}
        where call_id = ${callId} returning *`;
      const [inst] =
        await tx`select consecutive_failures from connector_installs where organization_id = ${caller.organizationId}
        and environment = ${caller.environment} and connector_id = ${def.id} for update`;
      const failures =
        outcome === "OK" ? 0 : Number(inst?.consecutive_failures ?? 0) + 1;
      const opensUntil =
        outcome !== "OK" && failures >= this.threshold
          ? new Date(Date.parse(finished) + this.openMs).toISOString()
          : null;
      await tx`update connector_installs set consecutive_failures = ${failures},
        breaker_open_until = ${outcome === "OK" ? null : opensUntil}
        where organization_id = ${caller.organizationId} and environment = ${caller.environment} and connector_id = ${def.id}`;
      return [u!];
    });
    await this.log(
      caller,
      "CONNECTOR_CALLED",
      callId,
      {
        connector: def.id,
        capability: b.capability,
        outcome,
        records: records.length,
      },
      finished,
    );
    return this.fromRow(row, def, false);
  }

  private fromRow(
    row: Row,
    def: ConnectorDefinition,
    replayed: boolean,
  ): CResult<{
    callId: string;
    replayed: boolean;
    observation: ConnectorObservation;
  }> {
    switch (row.outcome) {
      case "OK":
        return {
          ok: true,
          value: {
            callId: String(row.call_id),
            replayed,
            observation: row.result as ConnectorObservation,
          },
        };
      case "TIMEOUT":
        return { ok: false, refusal: "CONNECTOR_TIMEOUT", detail: def.id };
      case "INVALID_OUTPUT":
        return {
          ok: false,
          refusal: "CONNECTOR_INVALID_OUTPUT",
          detail: def.id,
        };
      default:
        return { ok: false, refusal: "CONNECTOR_FAILED", detail: def.id };
    }
  }

  // ------------------------------------------------------------------------------------------------ read
  async calls(
    tenant: Tenant,
    filter: { missionId?: string; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.deps.sql`
      select call_id, mission_id, mission_version, agent_id, connector_id, capability, outcome, record_count, error_code, started_at, finished_at
      from connector_calls where organization_id = ${tenant.organizationId} and environment = ${tenant.environment}
      and (${filter.missionId ?? null}::text is null or mission_id = ${filter.missionId ?? null})
      order by started_at desc, call_id limit ${limit}`;
    return rows.map((r) => ({
      callId: String(r.call_id),
      missionId: String(r.mission_id),
      missionVersion: Number(r.mission_version),
      agentId: String(r.agent_id),
      connectorId: String(r.connector_id),
      capability: String(r.capability),
      outcome: String(r.outcome),
      recordCount: r.record_count === null ? null : Number(r.record_count),
      errorCode: (r.error_code as string | null) ?? null,
      startedAt: iso(r.started_at),
      finishedAt: r.finished_at ? iso(r.finished_at) : null,
    }));
  }
}
