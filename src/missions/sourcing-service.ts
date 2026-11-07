import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { LedgerService } from "./ledger-service.js";
import type { QualificationService } from "./qualification-service.js";
import type { QuoteService, QuoteView } from "./quote-service.js";
import {
  optimize,
  type Excluded,
  type OptQuote,
  type Outcome,
} from "./sourcing.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M35 — recommending which recorded quotes to rely on. The service gathers only what is genuinely usable (current, complete,
 * in the mission's currency, from a qualified supplier), says why each other quote was left out, runs the exhaustive search, and
 * records the run immutably. A run recommends and commits nothing. Adopting it is a person's act and puts the chosen quotes in
 * the budget as QUOTED items (which hold no budget until a person approves them there).
 */
export type SRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "TOO_MANY_ELIGIBLE_QUOTES"
  | "RUN_NOT_ADOPTABLE"
  | "ADOPTION_INCOMPLETE"
  | "MEMBER_ONLY";
export type SResult<T> =
  { ok: true; value: T } | { ok: false; refusal: SRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const RunSchema = z
  .object({
    demand: z
      .array(
        z
          .object({
            sku: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
            quantity: z.number().int().min(1).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (d) => new Set(d.map((x) => x.sku)).size === d.length,
        "duplicate sku",
      ),
    quoteIds: z
      .array(z.string().regex(/^qte_[a-f0-9]{24}$/u))
      .min(1)
      .max(100)
      .optional(),
    maxSurplusUnits: z.number().int().min(0).max(1_000_000).default(0),
    allowExtras: z.boolean().default(false),
    requireQualified: z.boolean().default(true),
    idempotencyKey: Idem,
  })
  .strict();
const AdoptSchema = z.object({ idempotencyKey: Idem }).strict();

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
export const SOURCING_NOTICE =
  "Optimal only for the quotes recorded here and the constraints given; it says nothing about quotes nobody has obtained. A recommendation, not an approval or a purchase.";

export interface RunView {
  readonly runId: string;
  readonly missionId: string;
  readonly status: "OPTIMAL" | "INFEASIBLE";
  readonly demand: unknown;
  readonly constraints: unknown;
  readonly snapshot: unknown;
  readonly result: unknown;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly adopted: boolean;
  readonly notice: string;
}
const toRun = (r: Row, adopted: boolean): RunView => ({
  runId: String(r.run_id),
  missionId: String(r.mission_id),
  status: r.status as RunView["status"],
  demand: r.demand,
  constraints: r.constraints,
  snapshot: r.snapshot,
  result: r.result,
  requestedBy: `${String(r.requested_by_kind).toLowerCase()}:${String(r.requested_by)}`,
  createdAt: iso(r.created_at),
  adopted,
  notice: SOURCING_NOTICE,
});

export class SourcingService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      quotes: QuoteService;
      qualification: QualificationService;
      ledger: LedgerService;
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
        subjectKind: "MISSION_SOURCING",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async gate(
    caller: MissionCaller,
    missionId: string,
    capability: "READ" | "COMPARE",
  ): Promise<SResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    const a = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      capability,
    );
    if (a.allowed) return { ok: true, value: true };
    return a.reason === "MISSION_NOT_FOUND"
      ? { ok: false, refusal: "NOT_FOUND" }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
  }

  async run(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<SResult<{ run: RunView; replayed: boolean }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.gate(caller, missionId, "COMPARE");
    if (!g.ok) return g;
    const b = RunSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const req = b.data;
    const reader: MissionCaller = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      id: "sourcing",
      kind: "MEMBER",
    };
    const contract = m.value.activeContract ?? m.value.latestContract;
    const now = this.deps.now();

    const ql = await this.deps.quotes.list(reader, missionId);
    const qs = await this.deps.qualification.list(reader, missionId);
    if (!ql.ok || !qs.ok) return { ok: false, refusal: "NOT_FOUND" };
    const outcomeOf = new Map(
      (qs.value.suppliers as { supplierId: string; outcome: string }[]).map(
        (s) => [s.supplierId, s.outcome],
      ),
    );
    const led = await this.deps.ledger.overview(reader, missionId);
    const available = led.ok ? led.value.summary.availableMinor : null;

    let pool: QuoteView[] = ql.value.quotes;
    const early: Excluded[] = [];
    if (req.quoteIds) {
      const wanted = new Set(req.quoteIds);
      if (pool.filter((q) => wanted.has(q.quoteId)).length !== wanted.size)
        return { ok: false, refusal: "NOT_FOUND", detail: "QUOTE" };
      pool = pool.filter((q) => wanted.has(q.quoteId));
    }
    const usable: OptQuote[] = [];
    const snapshot: {
      quoteId: string;
      supplierId: string;
      totalMinor: number;
    }[] = [];
    for (const q of pool) {
      const out = outcomeOf.get(q.supplierId);
      if (q.status !== "CURRENT")
        early.push({
          quoteId: q.quoteId,
          reason:
            q.status === "EXPIRED"
              ? "The quote has expired."
              : "A newer quote replaced it.",
        });
      else if (q.currency !== contract.currency)
        early.push({
          quoteId: q.quoteId,
          reason: `In ${q.currency}; no conversion is done.`,
        });
      else if (!q.landed.complete || q.landed.totalMinor === null)
        early.push({
          quoteId: q.quoteId,
          reason: `Not complete: ${q.landed.unknown.join(", ")} unknown.`,
        });
      else if (out === "NOT_QUALIFIED")
        early.push({
          quoteId: q.quoteId,
          reason:
            "The supplier is not qualified (a failure or the contract bars it).",
        });
      else if (req.requireQualified && out !== "QUALIFIED")
        early.push({
          quoteId: q.quoteId,
          reason: "The supplier is not yet qualified.",
        });
      else {
        usable.push({
          quoteId: q.quoteId,
          supplierId: q.supplierId,
          totalMinor: q.landed.totalMinor,
          lines: q.document.lines.map((l) => ({
            sku: l.sku ?? null,
            quantity: l.quantity,
          })),
        });
        snapshot.push({
          quoteId: q.quoteId,
          supplierId: q.supplierId,
          totalMinor: q.landed.totalMinor,
        });
      }
    }
    const constraints = {
      currency: contract.currency,
      availableMinor: available,
      maxCommitmentMinor: contract.maxCommitmentMinor,
      humanApprovalAboveMinor:
        contract.approvalConditions.humanApprovalAboveMinor ?? null,
      maxSurplusUnits: req.maxSurplusUnits,
      allowExtras: req.allowExtras,
      requireQualified: req.requireQualified,
    };
    const result: Outcome = optimize({
      demand: req.demand,
      quotes: usable,
      availableMinor: available,
      maxCommitmentMinor: contract.maxCommitmentMinor,
      humanApprovalAboveMinor:
        contract.approvalConditions.humanApprovalAboveMinor,
      maxSurplusUnits: req.maxSurplusUnits,
      allowExtras: req.allowExtras,
    });
    if (result.status === "TOO_MANY_ELIGIBLE")
      return {
        ok: false,
        refusal: "TOO_MANY_ELIGIBLE_QUOTES",
        detail: `${result.eligible} eligible; the limit is ${result.limit}. Narrow with quoteIds.`,
      };
    const excluded = [...early, ...result.excluded];
    const stored = { ...result, excluded };
    const inputsDigest = sha({
      missionId,
      demand: req.demand,
      constraints,
      snapshot,
    });
    const requestDigest = sha({ missionId, ...req, idempotencyKey: undefined });
    const id = `src_${randomBytes(12).toString("hex")}`;
    const sql = this.deps.sql;
    const out = await sql.begin(
      async (tx): Promise<SResult<{ row: Row; replayed: boolean }>> => {
        await tx`select pg_advisory_xact_lock(hashtext(${"sourcing|" + missionId + "|" + caller.id}))`;
        const [prior] =
          await tx`select * from mission_sourcing_runs where mission_id = ${missionId} and requested_by = ${caller.id} and idempotency_key = ${req.idempotencyKey}`;
        if (prior)
          return prior.request_digest === requestDigest
            ? { ok: true, value: { row: prior, replayed: true } }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        const [row] =
          await tx`insert into mission_sourcing_runs (run_id, mission_id, requested_by_kind, requested_by, demand, constraints, snapshot, status, result,
          inputs_digest, idempotency_key, request_digest, created_at)
        values (${id}, ${missionId}, ${caller.kind}, ${caller.id}, ${tx.json(req.demand)}, ${tx.json(constraints)}, ${tx.json(snapshot)},
          ${result.status}, ${tx.json(stored as never)}, ${inputsDigest}, ${req.idempotencyKey}, ${requestDigest}, ${now}) returning *`;
        return { ok: true, value: { row: row!, replayed: false } };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(
        caller,
        "SOURCING_RUN",
        id,
        { status: result.status, considered: snapshot.length },
        now,
      );
    return {
      ok: true,
      value: { run: toRun(out.value.row, false), replayed: out.value.replayed },
    };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<SResult<{ runs: RunView[] }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.gate(caller, missionId, "READ");
    if (!g.ok) return g;
    const rows = await this.deps
      .sql`select * from mission_sourcing_runs where mission_id = ${missionId} order by created_at, run_id`;
    const adopted = new Set(
      (
        await this.deps
          .sql`select run_id from mission_sourcing_adoptions where run_id in (select run_id from mission_sourcing_runs where mission_id = ${missionId})`
      ).map((r) => String(r.run_id)),
    );
    return {
      ok: true,
      value: { runs: rows.map((r) => toRun(r, adopted.has(String(r.run_id)))) },
    };
  }

  async get(
    tenant: Pick<MissionCaller, "organizationId" | "environment">,
    runId: string,
  ): Promise<RunView | null> {
    const [r] = await this.deps
      .sql`select r.* from mission_sourcing_runs r join missions m on m.mission_id = r.mission_id
      where r.run_id = ${runId} and m.organization_id = ${tenant.organizationId} and m.environment = ${tenant.environment}`;
    if (!r) return null;
    const [a] = await this.deps
      .sql`select 1 from mission_sourcing_adoptions where run_id = ${runId}`;
    return toRun(r, !!a);
  }

  /** A person puts the chosen quotes in the budget. Idempotent and retryable; the adoption is recorded only when every quote went in. */
  async adopt(
    caller: MissionCaller,
    runId: string,
    rawBody: unknown,
  ): Promise<
    SResult<{
      runId: string;
      items: { quoteId: string; itemId: string }[];
      replayed: boolean;
    }>
  > {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    if (!/^src_[a-f0-9]{24}$/u.test(runId))
      return { ok: false, refusal: "NOT_FOUND" };
    if (!AdoptSchema.safeParse(rawBody).success)
      return { ok: false, refusal: "MALFORMED" };
    const run = await this.get(caller, runId);
    if (!run) return { ok: false, refusal: "NOT_FOUND" };
    const res = run.result as { status: string; best?: { quoteIds: string[] } };
    if (run.status !== "OPTIMAL" || !res.best)
      return {
        ok: false,
        refusal: "RUN_NOT_ADOPTABLE",
        detail: "NOTHING_WAS_RECOMMENDED",
      };
    const items: { quoteId: string; itemId: string }[] = [];
    const failures: string[] = [];
    for (const quoteId of res.best.quoteIds) {
      const r = await this.deps.quotes.toLedger(caller, quoteId, {
        idempotencyKey: `adopt-${runId}-${quoteId}`.slice(0, 128),
      });
      if (r.ok) items.push({ quoteId, itemId: r.value.itemId });
      else failures.push(`${quoteId}:${r.refusal}`);
    }
    if (failures.length > 0)
      return {
        ok: false,
        refusal: "ADOPTION_INCOMPLETE",
        detail: failures.join(","),
      };
    const now = this.deps.now();
    const [first] = await this.deps
      .sql`insert into mission_sourcing_adoptions (run_id, adopted_by, adopted_at) values (${runId}, ${caller.id}, ${now}) on conflict (run_id) do nothing returning run_id`;
    if (first)
      await this.log(
        caller,
        "SOURCING_ADOPTED",
        runId,
        { quotes: items.length },
        now,
      );
    return { ok: true, value: { runId, items, replayed: !first } };
  }
}
