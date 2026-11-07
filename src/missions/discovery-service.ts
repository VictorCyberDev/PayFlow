import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import type { CResult, ConnectorService } from "./connector-service.js";
import { ConnectorQuerySchema, ConnectorRecordSchema } from "./connectors.js";
import {
  RequirementsSchema,
  compareFacts,
  matchKeyOf,
  rank,
  type CandidateFacts,
  type Requirements,
} from "./discovery.js";
import type { LedgerService } from "./ledger-service.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M32 — product discovery. An agent SEARCHES through a connector (all of M31's gates apply, unchanged); what comes back is
 * stored as immutable CANDIDATES with where and when each was observed, judged against stated requirements by deterministic
 * checks, and compared side by side. Nothing here is a quote, an approval or a commitment, and what a candidate says about
 * itself never changes how it is ranked beyond the checks the requirements name (text that looks like an instruction is data).
 */
const Idem = z.string().min(16).max(128);
export const SearchSchema = z
  .object({
    connectorId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/u),
    query: ConnectorQuerySchema,
    requirements: RequirementsSchema.optional(),
    idempotencyKey: Idem,
  })
  .strict();
export const MarkSchema = z
  .object({
    decision: z.enum(["SHORTLIST", "REJECT", "CLEAR"]),
    reason: z.string().trim().max(300).default(""),
    idempotencyKey: Idem,
  })
  .strict();
export const CompareSchema = z
  .object({
    candidateIds: z
      .array(z.string().regex(/^cnd_[a-f0-9]{24}$/u))
      .min(2)
      .max(5),
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

export interface CandidateView extends CandidateFacts {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly callId: string;
  readonly connectorId: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly matchKey: string | null;
  readonly foundByAgent: string;
  readonly mark: {
    readonly decision: "SHORTLIST" | "REJECT" | "CLEAR";
    readonly reason: string;
    readonly by: string;
    readonly at: string;
  } | null;
}
const toCandidate = (r: Row, mark: Row | undefined): CandidateView => ({
  candidateId: String(r.candidate_id),
  missionId: String(r.mission_id),
  missionVersion: Number(r.mission_version),
  callId: String(r.call_id),
  connectorId: String(r.connector_id),
  recordId: String(r.record_id),
  kind: String(r.record_kind),
  title: String(r.title),
  unitPriceMinor:
    r.unit_price_minor === null ? null : Number(r.unit_price_minor),
  currency: r.currency === null ? null : (r.currency as string).trim(),
  availableQuantity:
    r.available_quantity === null ? null : Number(r.available_quantity),
  url: (r.url as string | null) ?? null,
  observedAt: iso(r.observed_at),
  claims: r.claims as CandidateFacts["claims"],
  matchKey: (r.match_key as string | null) ?? null,
  foundByAgent: String(r.found_by_agent),
  mark:
    mark && mark.decision !== "CLEAR"
      ? {
          decision: mark.decision as "SHORTLIST" | "REJECT",
          reason: String(mark.reason),
          by: `${String(mark.actor_kind).toLowerCase()}:${String(mark.actor_id)}`,
          at: iso(mark.occurred_at),
        }
      : null,
});

export const DISCOVERY_NOTICE =
  "Observed values at the time shown. Not quotes, not commitments. Ranking is against the stated requirements only; it is not an approval.";

export class DiscoveryService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      connectors: ConnectorService;
      ledger?: LedgerService;
      now: () => string;
    },
  ) {}

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
        subjectKind: "MISSION_DISCOVERY",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------------- search
  async search(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{
      callId: string;
      replayed: boolean;
      candidates: unknown[];
      notice: string;
    }>
  > {
    if (caller.kind !== "AGENT") return { ok: false, refusal: "AGENT_ONLY" };
    const b = SearchSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    // Every M31 gate applies here, unchanged: mission, grant, provider type, install state, allowance, idempotency, bounds.
    const out = await this.deps.connectors.invoke(caller, missionId, {
      connectorId: b.data.connectorId,
      capability: "SEARCH",
      query: b.data.query,
      idempotencyKey: b.data.idempotencyKey,
    });
    if (!out.ok) return out;
    const sql = this.deps.sql;
    const [call] =
      await sql`select mission_version from connector_calls where call_id = ${out.value.callId}`;
    const now = this.deps.now();
    const records = out.value.observation.records;
    // Records already passed ConnectorResultSchema; parse again so nothing unvalidated is ever stored.
    const safe = records.map((r) => ConnectorRecordSchema.parse(r));
    await sql.begin(async (tx) => {
      for (const r of safe)
        await tx`insert into mission_candidates (candidate_id, mission_id, mission_version, call_id, connector_id, record_id, record_kind,
          title, unit_price_minor, currency, available_quantity, url, observed_at, claims, match_key, found_by_agent, created_at)
          values (${"cnd_" + randomBytes(12).toString("hex")}, ${missionId}, ${Number(call!.mission_version)}, ${out.value.callId},
          ${b.data.connectorId}, ${r.recordId}, ${r.kind}, ${r.title}, ${r.priceObservation?.minor ?? null}, ${r.priceObservation?.currency ?? null},
          ${r.availableQuantity}, ${r.url}, ${r.observedAt}, ${tx.json(r.claims)}, ${matchKeyOf(r.claims)}, ${caller.id}, ${now})
          on conflict (mission_id, call_id, record_id) do nothing`;
    });
    const rows =
      await sql`select * from mission_candidates where mission_id = ${missionId} and call_id = ${out.value.callId}`;
    const req = b.data.requirements ?? RequirementsSchema.parse({});
    const ranked = rank(
      rows.map((r) => toCandidate(r, undefined)),
      req,
      now,
    );
    if (!out.value.replayed)
      await this.log(
        caller,
        "DISCOVERY_SEARCHED",
        out.value.callId,
        { connector: b.data.connectorId, candidates: rows.length },
        now,
      );
    return {
      ok: true,
      value: {
        callId: out.value.callId,
        replayed: out.value.replayed,
        candidates: ranked,
        notice: DISCOVERY_NOTICE,
      },
    };
  }

  /** An agent reads candidates with READ and compares with COMPARE, granted by the mission like everything else. Members need nothing here. */
  async gate(
    caller: MissionCaller,
    missionId: string,
    capability: "READ" | "COMPARE",
  ): Promise<CResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    const auth = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      capability,
    );
    if (auth.allowed) return { ok: true, value: true };
    return auth.reason === "MISSION_NOT_FOUND"
      ? { ok: false, refusal: "NOT_FOUND" }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: auth.reason };
  }

  // ---------------------------------------------------------------------------------------------------- read
  async list(tenant: Tenant, missionId: string, requirements?: Requirements) {
    const m = await this.deps.missions.get(tenant, missionId);
    if (!m.ok) return { ok: false as const, refusal: "NOT_FOUND" as const };
    const sql = this.deps.sql;
    const now = this.deps.now();
    const rows =
      await sql`select * from mission_candidates where mission_id = ${missionId} order by created_at, candidate_id`;
    const marks =
      await sql`select distinct on (candidate_id) * from mission_candidate_marks
      where candidate_id in (select candidate_id from mission_candidates where mission_id = ${missionId}) order by candidate_id, seq desc`;
    const markOf = new Map(marks.map((x) => [String(x.candidate_id), x]));
    const items = rows.map((r) =>
      toCandidate(r, markOf.get(String(r.candidate_id))),
    );
    const req = requirements ?? RequirementsSchema.parse({});
    const contract = m.value.activeContract ?? m.value.latestContract;
    const ledger = this.deps.ledger
      ? await this.deps.ledger.overview(tenant, missionId)
      : null;
    const available = ledger?.ok ? ledger.value.summary.availableMinor : null;
    const ranked = rank(items, req, now).map((c) => {
      const comparable =
        c.unitPriceMinor !== null && c.currency === contract.currency;
      return {
        ...c,
        fits: {
          /** One unit's observed price against the largest single commitment the contract allows. Not a quote. */
          withinMaxCommitment: comparable
            ? c.unitPriceMinor <= contract.maxCommitmentMinor
            : null,
          withinAvailableBudget:
            comparable && available !== null
              ? c.unitPriceMinor <= available
              : null,
        },
      };
    });
    // Same SKU seen more than once: show the spread, never merge.
    const groups = new Map<string, CandidateView[]>();
    for (const c of items)
      if (c.matchKey)
        groups.set(c.matchKey, [...(groups.get(c.matchKey) ?? []), c]);
    const sameSku = [...groups.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([key, v]) => {
        const prices = v
          .filter(
            (x) => x.unitPriceMinor !== null && x.currency === v[0]!.currency,
          )
          .map((x) => x.unitPriceMinor!);
        return {
          matchKey: key,
          candidateIds: v.map((x) => x.candidateId),
          connectors: [...new Set(v.map((x) => x.connectorId))],
          priceSpreadMinor:
            prices.length > 1
              ? Math.max(...prices) - Math.min(...prices)
              : null,
        };
      });
    return {
      ok: true as const,
      value: {
        candidates: ranked,
        sameSku,
        requirements: req,
        notice: DISCOVERY_NOTICE,
      },
    };
  }

  async compare(
    tenant: Tenant,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{ rows: unknown[]; candidateIds: string[]; notice: string }>
  > {
    const b = CompareSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    if (new Set(b.data.candidateIds).size !== b.data.candidateIds.length)
      return { ok: false, refusal: "MALFORMED", detail: "DUPLICATE_CANDIDATE" };
    const rows = await this.deps.sql`
      select c.* from mission_candidates c join missions m on m.mission_id = c.mission_id
      where c.mission_id = ${missionId} and m.organization_id = ${tenant.organizationId} and m.environment = ${tenant.environment}
      and c.candidate_id in ${this.deps.sql(b.data.candidateIds)}`;
    if (rows.length !== b.data.candidateIds.length)
      return { ok: false, refusal: "NOT_FOUND" };
    const byId = new Map(
      rows.map((r) => [String(r.candidate_id), toCandidate(r, undefined)]),
    );
    const ordered = b.data.candidateIds.map((id) => byId.get(id)!);
    return {
      ok: true,
      value: {
        candidateIds: b.data.candidateIds,
        rows: compareFacts(ordered),
        notice: `${DISCOVERY_NOTICE} No total or landed cost is computed here.`,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------- mark
  async mark(
    caller: MissionCaller,
    candidateId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{ candidateId: string; decision: string; replayed: boolean }>
  > {
    if (!/^cnd_[a-f0-9]{24}$/u.test(candidateId))
      return { ok: false, refusal: "NOT_FOUND" };
    const b = MarkSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const sql = this.deps.sql;
    const [c] =
      await sql`select c.mission_id from mission_candidates c join missions m on m.mission_id = c.mission_id
      where c.candidate_id = ${candidateId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!c) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const auth = await this.deps.missions.authorizeCapability(
        caller,
        String(c.mission_id),
        caller.id,
        "COMPARE",
      );
      if (!auth.allowed)
        return {
          ok: false,
          refusal: "CAPABILITY_REFUSED",
          detail: auth.reason,
        };
    }
    const digest = sha({
      candidateId,
      decision: b.data.decision,
      reason: b.data.reason,
    });
    const now = this.deps.now();
    const out = await sql.begin(
      async (
        tx,
      ): Promise<
        CResult<{ candidateId: string; decision: string; replayed: boolean }>
      > => {
        const [prior] =
          await tx`select request_digest from mission_candidate_marks where candidate_id = ${candidateId}
        and actor_id = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
        if (prior)
          return prior.request_digest === digest
            ? {
                ok: true,
                value: {
                  candidateId,
                  decision: b.data.decision,
                  replayed: true,
                },
              }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        await tx`insert into mission_candidate_marks (candidate_id, decision, reason, actor_kind, actor_id, idempotency_key, request_digest, occurred_at)
        values (${candidateId}, ${b.data.decision}, ${b.data.reason}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${digest}, ${now})`;
        return {
          ok: true,
          value: { candidateId, decision: b.data.decision, replayed: false },
        };
      },
    );
    if (out.ok && !out.value.replayed)
      await this.log(
        caller,
        "DISCOVERY_MARKED",
        candidateId,
        { decision: b.data.decision },
        now,
      );
    return out;
  }
}
export type { Environment };
