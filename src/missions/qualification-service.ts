import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { CResult } from "./connector-service.js";
import {
  COMPUTED_CRITERION,
  CRITERIA,
  CRITERION_IDS,
  DEFAULT_REQUIRED,
  assess,
  verificationProblem,
  type EvidenceKind,
  type FactRow,
  type FactStatus,
} from "./qualification.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M33 — supplier dossiers. Facts are append-only; the latest per criterion is current. An agent may CLAIM or record a FAILURE
 * but cannot VERIFY, and cannot erase a person's verification with a weaker fact. QUALIFIED is computed, never stored, and is not
 * an approval to negotiate or buy.
 */
const Idem = z.string().min(16).max(128);
const Ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const AddSupplierSchema = z
  .object({
    externalRef: Ref.optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    fromCandidateId: z
      .string()
      .regex(/^cnd_[a-f0-9]{24}$/u)
      .optional(),
  })
  .strict()
  .refine(
    (b) => (b.externalRef !== undefined) !== (b.fromCandidateId !== undefined),
    {
      message: "give externalRef or fromCandidateId, not both",
    },
  );
export const FactSchema = z
  .object({
    criterion: z
      .string()
      .refine((c) => CRITERION_IDS.includes(c), "unknown criterion"),
    status: z.enum(["CLAIMED", "VERIFIED", "FAILED", "UNKNOWN"]),
    value: z
      .record(
        z.string().max(64),
        z.union([z.string().max(300), z.number(), z.boolean()]),
      )
      .default({})
      .refine((v) => Object.keys(v).length <= 12, "at most 12 values"),
    evidenceKind: z
      .enum(["NONE", "CONNECTOR_CALL", "DOCUMENT_REF", "OWNER_ATTESTATION"])
      .default("NONE"),
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(300).default(""),
    idempotencyKey: Idem,
  })
  .strict();
export const PolicySchema = z
  .object({
    required: z
      .array(z.string())
      .min(1)
      .max(8)
      .refine(
        (r) =>
          r.every((c) => CRITERION_IDS.includes(c) || c === COMPUTED_CRITERION),
        "unknown criterion",
      )
      .refine((r) => new Set(r).size === r.length, "duplicate criterion"),
    idempotencyKey: Idem,
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

const toFact = (r: Row): FactRow => ({
  criterion: String(r.criterion),
  status: r.status as FactStatus,
  evidenceKind: r.evidence_kind as EvidenceKind,
  evidenceRef: (r.evidence_ref as string | null) ?? null,
  recordedAt: iso(r.recorded_at),
  actorKind: r.actor_kind as "MEMBER" | "AGENT",
});
export const QUALIFICATION_NOTICE =
  "Qualified means the required evidence is on file and current. It is not an approval to negotiate, buy or contract, and PayFlow does not itself screen suppliers.";

export class QualificationService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
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
        subjectKind: "MISSION_SUPPLIER",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async gate(
    caller: MissionCaller,
    missionId: string,
    capability: "READ" | "VERIFY",
  ): Promise<CResult<true>> {
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
  private async supplierOf(tenant: Tenant, supplierId: string) {
    const [s] = await this.deps
      .sql`select s.* from mission_suppliers s join missions m on m.mission_id = s.mission_id
      where s.supplier_id = ${supplierId} and m.organization_id = ${tenant.organizationId} and m.environment = ${tenant.environment}`;
    return s ?? null;
  }
  private async requiredFor(missionId: string): Promise<string[]> {
    const [p] = await this.deps
      .sql`select required from mission_qualification_policy where mission_id = ${missionId} order by seq desc limit 1`;
    return p ? (p.required as string[]) : [...DEFAULT_REQUIRED];
  }

  // ---------------------------------------------------------------------------------------------------- suppliers
  async addSupplier(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<CResult<{ supplierId: string; replayed: boolean }>> {
    const b = AddSupplierSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.gate(caller, missionId, "READ");
    if (!g.ok) return g;
    const sql = this.deps.sql;
    let ref = b.data.externalRef;
    let name = b.data.displayName;
    if (b.data.fromCandidateId) {
      const [cand] =
        await sql`select claims from mission_candidates where candidate_id = ${b.data.fromCandidateId} and mission_id = ${missionId}`;
      if (!cand) return { ok: false, refusal: "NOT_FOUND" };
      const merchant = (cand.claims as Record<string, unknown>)["merchantId"];
      if (typeof merchant !== "string" || !Ref.safeParse(merchant).success)
        return {
          ok: false,
          refusal: "MALFORMED",
          detail: "CANDIDATE_STATES_NO_MERCHANT",
        };
      ref = merchant;
      name ??= merchant;
    }
    name ??= ref!;
    const now = this.deps.now();
    const id = `sup_${randomBytes(12).toString("hex")}`;
    const [created] =
      await sql`insert into mission_suppliers (supplier_id, mission_id, external_ref, display_name, source_candidate_id, created_by_kind, created_by, created_at)
      values (${id}, ${missionId}, ${ref!}, ${name}, ${b.data.fromCandidateId ?? null}, ${caller.kind}, ${caller.id}, ${now}) on conflict (mission_id, external_ref) do nothing returning supplier_id`;
    if (created) {
      await this.log(caller, "SUPPLIER_ADDED", id, { externalRef: ref! }, now);
      return { ok: true, value: { supplierId: id, replayed: false } };
    }
    const [existing] =
      await sql`select supplier_id from mission_suppliers where mission_id = ${missionId} and external_ref = ${ref!}`;
    return {
      ok: true,
      value: { supplierId: String(existing!.supplier_id), replayed: true },
    };
  }

  // ---------------------------------------------------------------------------------------------------- facts
  async recordFact(
    caller: MissionCaller,
    supplierId: string,
    rawBody: unknown,
  ): Promise<
    CResult<{
      supplierId: string;
      criterion: string;
      status: string;
      replayed: boolean;
    }>
  > {
    const s = await this.supplierOf(caller, supplierId);
    if (!s) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(s.mission_id);
    const b = FactSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const g = await this.gate(caller, missionId, "VERIFY");
    if (!g.ok) return g;
    const f = b.data;
    const actorKind = caller.kind;
    const ref = f.evidenceRef ?? null;
    const refuse = (detail: string): CResult<never> => ({
      ok: false,
      refusal: "CAPABILITY_REFUSED",
      detail,
    });
    if (f.evidenceKind === "OWNER_ATTESTATION" && actorKind !== "MEMBER")
      return refuse("ATTESTATION_IS_A_PERSONS_ACT");
    if (
      f.evidenceKind !== "NONE" &&
      f.evidenceKind !== "OWNER_ATTESTATION" &&
      !ref
    )
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: "EVIDENCE_REFERENCE_REQUIRED",
      };
    if (f.evidenceKind === "NONE" && ref)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: "REFERENCE_WITHOUT_EVIDENCE_KIND",
      };
    if (f.status === "VERIFIED") {
      const problem = verificationProblem(
        f.criterion,
        f.evidenceKind,
        ref,
        actorKind,
      );
      if (problem) return refuse(problem);
    }
    if (f.evidenceKind === "CONNECTOR_CALL") {
      // The reference must be a real, successful connector call of THIS mission: evidence cannot be invented.
      const [c] = await this.deps
        .sql`select 1 from connector_calls where call_id = ${ref} and mission_id = ${missionId} and outcome = 'OK'`;
      if (!c)
        return {
          ok: false,
          refusal: "MALFORMED",
          detail: "NO_SUCH_SUCCESSFUL_CONNECTOR_CALL_FOR_THIS_MISSION",
        };
    }
    const digest = sha({ supplierId, ...f, idempotencyKey: undefined });
    const now = this.deps.now();
    const out = await this.deps.sql.begin(
      async (
        tx,
      ): Promise<
        CResult<{
          supplierId: string;
          criterion: string;
          status: string;
          replayed: boolean;
        }>
      > => {
        await tx`select pg_advisory_xact_lock(hashtext(${supplierId + "|" + f.criterion}))`;
        const [prior] =
          await tx`select request_digest from mission_supplier_facts where supplier_id = ${supplierId} and actor_id = ${caller.id} and idempotency_key = ${f.idempotencyKey}`;
        if (prior)
          return prior.request_digest === digest
            ? {
                ok: true,
                value: {
                  supplierId,
                  criterion: f.criterion,
                  status: f.status,
                  replayed: true,
                },
              }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        if (
          actorKind === "AGENT" &&
          (f.status === "CLAIMED" || f.status === "UNKNOWN")
        ) {
          const [cur] =
            await tx`select status, actor_kind from mission_supplier_facts where supplier_id = ${supplierId} and criterion = ${f.criterion} order by seq desc limit 1`;
          if (cur?.status === "VERIFIED")
            return {
              ok: false,
              refusal: "CAPABILITY_REFUSED",
              detail:
                "WOULD_ERASE_A_VERIFICATION: an agent may report a failure, not weaken a verification",
            };
        }
        await tx`insert into mission_supplier_facts (supplier_id, criterion, status, value, evidence_kind, evidence_ref, note, actor_kind, actor_id, idempotency_key, request_digest, recorded_at)
        values (${supplierId}, ${f.criterion}, ${f.status}, ${tx.json(f.value)}, ${f.evidenceKind}, ${ref}, ${f.note}, ${actorKind}, ${caller.id}, ${f.idempotencyKey}, ${digest}, ${now})`;
        return {
          ok: true,
          value: {
            supplierId,
            criterion: f.criterion,
            status: f.status,
            replayed: false,
          },
        };
      },
    );
    if (out.ok && !out.value.replayed)
      await this.log(
        caller,
        "SUPPLIER_FACT_RECORDED",
        supplierId,
        { criterion: f.criterion, status: f.status, evidence: f.evidenceKind },
        now,
      );
    return out;
  }

  async setPolicy(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<CResult<{ required: string[]; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = PolicySchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    // What the contract allows is always checked; a policy cannot drop it.
    const required = [
      COMPUTED_CRITERION,
      ...b.data.required.filter((c) => c !== COMPUTED_CRITERION),
    ];
    const digest = sha({ missionId, required });
    const now = this.deps.now();
    const [prior] = await this.deps
      .sql`select request_digest, required from mission_qualification_policy where mission_id = ${missionId} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.request_digest === digest
        ? {
            ok: true,
            value: { required: prior.required as string[], replayed: true },
          }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    await this.deps
      .sql`insert into mission_qualification_policy (mission_id, required, set_by, idempotency_key, request_digest, set_at)
      values (${missionId}, ${this.deps.sql.json(required)}, ${caller.id}, ${b.data.idempotencyKey}, ${digest}, ${now})`;
    await this.log(
      caller,
      "QUALIFICATION_POLICY_SET",
      missionId,
      { required: required.join(",") },
      now,
    );
    return { ok: true, value: { required, replayed: false } };
  }

  // ---------------------------------------------------------------------------------------------------- read
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<
    CResult<{
      required: string[];
      suppliers: unknown[];
      notice: string;
      criteria: unknown[];
    }>
  > {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.gate(caller, missionId, "READ");
    if (!g.ok) return g;
    const sql = this.deps.sql;
    const now = this.deps.now();
    const contract = m.value.activeContract ?? m.value.latestContract;
    const required = await this.requiredFor(missionId);
    const suppliers =
      await sql`select * from mission_suppliers where mission_id = ${missionId} order by created_at, supplier_id`;
    const facts =
      await sql`select distinct on (supplier_id, criterion) * from mission_supplier_facts
      where supplier_id in (select supplier_id from mission_suppliers where mission_id = ${missionId}) order by supplier_id, criterion, seq desc`;
    return {
      ok: true,
      value: {
        required,
        notice: QUALIFICATION_NOTICE,
        criteria: CRITERIA.map((c) => ({
          id: c.id,
          title: c.title,
          acceptableEvidence: c.acceptableEvidence,
          validDays: c.validDays,
          howToClose: c.howToClose,
        })),
        suppliers: suppliers.map((s) => {
          const latest = new Map(
            facts
              .filter((f) => f.supplier_id === s.supplier_id)
              .map((f) => [String(f.criterion), toFact(f)]),
          );
          const a = assess(
            required,
            latest,
            contract,
            String(s.external_ref),
            now,
          );
          return {
            supplierId: String(s.supplier_id),
            externalRef: String(s.external_ref),
            displayName: String(s.display_name),
            ...a,
          };
        }),
      },
    };
  }

  async history(tenant: Tenant, supplierId: string) {
    const s = await this.supplierOf(tenant, supplierId);
    if (!s) return null;
    const rows = await this.deps
      .sql`select seq, criterion, status, value, evidence_kind, evidence_ref, note, actor_kind, actor_id, recorded_at
      from mission_supplier_facts where supplier_id = ${supplierId} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      criterion: String(r.criterion),
      status: String(r.status),
      value: r.value as unknown,
      evidenceKind: String(r.evidence_kind),
      evidenceRef: (r.evidence_ref as string | null) ?? null,
      note: String(r.note),
      by: `${String(r.actor_kind).toLowerCase()}:${String(r.actor_id)}`,
      at: iso(r.recorded_at),
    }));
  }

  /** For later milestones: may this mission deal with this supplier, on the evidence on file right now? */
  async isQualified(
    tenant: Tenant,
    missionId: string,
    externalRef: string,
  ): Promise<boolean> {
    const l = await this.list(
      { ...tenant, id: "system", kind: "MEMBER" },
      missionId,
    );
    if (!l.ok) return false;
    return (
      l.value.suppliers as { externalRef: string; outcome: string }[]
    ).some((s) => s.externalRef === externalRef && s.outcome === "QUALIFIED");
  }
}
