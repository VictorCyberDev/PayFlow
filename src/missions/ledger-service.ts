import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { AuditLog, Environment } from "../network/ops-controls.js";
import { MissionContractSchema, type MissionContract } from "./contract.js";
import {
  AGENT_STAGES,
  canMove,
  consumes,
  evidenceOk,
  exposureOf,
  EVIDENCE_KINDS,
  STAGES,
  summarize,
  type EvidenceKind,
  type LedgerSummary,
  type Stage,
} from "./ledger.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * The mission's authoritative financial view. Rules enforced here, under the mission's row lock:
 *  - capacity: the sum of exposures never exceeds the ceiling of the contract in force (a commitment that would is refused);
 *  - per-commitment: no item at APPROVED or later exceeds the contract's maximum commitment;
 *  - currency: every item is in the mission's currency; no conversion happens anywhere;
 *  - who: an agent may only estimate and quote; approval, commitment, reservation, payment and settlement are member or system
 *    facts, and an agent's word is never evidence that money moved;
 *  - evidence: moves that assert what happened outside (settled, refunded, failed, released) need Proof or a provider
 *    confirmation; reservations and payment starts need an Authority receipt or better;
 *  - mission state: nothing new may be approved, committed, reserved or started while the mission is not ACTIVE, but settling,
 *    cancelling, refunding and resolving UNKNOWN always remain possible (the money truth continues after a pause);
 *  - idempotency: every create and every transition carries a key; a repeat is a replay, never a second effect.
 */
export type LedgerRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CURRENCY_MISMATCH"
  | "CAPACITY_EXCEEDED"
  | "ABOVE_MAX_COMMITMENT"
  | "ILLEGAL_MOVE"
  | "EVIDENCE_INSUFFICIENT"
  | "AGENT_NOT_PERMITTED"
  | "MISSION_NOT_ACTIVE"
  | "AMOUNT_FROZEN"
  | "REFUND_EXCEEDS_SETTLED"
  | "STALE_ROW_VERSION"
  | "CAPABILITY_REFUSED";
export type LResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: LedgerRefusal; detail?: string };
export type LedgerCaller =
  | MissionCaller
  | {
      organizationId: string;
      environment: Environment;
      id: string;
      kind: "SYSTEM";
    };

const Idem = z.string().min(16).max(128);
const Money = z.number().int().safe().min(1).max(1_000_000_000_000);
const Evidence = z
  .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
  .default({});
const KINDS = [
  "GOODS",
  "SERVICE",
  "SUBSCRIPTION",
  "DEPOSIT",
  "CONTRACTOR_MILESTONE",
  "FEE",
  "OTHER",
] as const;
export const CreateItemSchema = z
  .object({
    kind: z.enum(KINDS),
    label: z.string().trim().min(1).max(200),
    amountMinor: Money,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    stage: z.enum(STAGES).default("ESTIMATED"),
    verification: z
      .enum(["OWNER_REPORTED", "UNVERIFIED"])
      .default("UNVERIFIED"),
    evidenceKind: z.enum(EVIDENCE_KINDS).default("NONE"),
    evidence: Evidence,
    agentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .optional(),
    idempotencyKey: Idem,
  })
  .strict();
export const TransitionSchema = z
  .object({
    to: z.enum(STAGES),
    amountMinor: Money.optional(),
    refundMinor: Money.optional(),
    evidenceKind: z.enum(EVIDENCE_KINDS).default("NONE"),
    evidence: Evidence,
    expectedRowVersion: z.number().int().min(1).optional(),
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
export interface ItemView {
  readonly itemId: string;
  readonly missionId: string;
  readonly kind: string;
  readonly label: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly refundedMinor: number;
  readonly stage: Stage;
  readonly exposureMinor: number;
  readonly verification: string;
  readonly agentId: string | null;
  readonly rowVersion: number;
  readonly createdAt: string;
}
const toItem = (r: Row): ItemView => {
  const stage = r.stage as Stage;
  const amountMinor = Number(r.amount_minor);
  const refundedMinor = Number(r.refunded_minor);
  return {
    itemId: String(r.item_id),
    missionId: String(r.mission_id),
    kind: String(r.kind),
    label: String(r.label),
    currency: String(r.currency).trim(),
    amountMinor,
    refundedMinor,
    stage,
    exposureMinor: exposureOf({ stage, amountMinor, refundedMinor }),
    verification: String(r.verification),
    agentId: (r.agent_id as string | null) ?? null,
    rowVersion: Number(r.row_version),
    createdAt: iso(r.created_at),
  };
};

export class LedgerService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      now: () => string;
    },
  ) {}

  private async lock(
    tx: TransactionSql,
    t: { organizationId: string; environment: Environment },
    missionId: string,
  ) {
    const [m] =
      await tx`select * from missions where mission_id = ${missionId} and organization_id = ${t.organizationId}
      and environment = ${t.environment} for update`;
    return m ?? null;
  }
  private async contractOf(
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
  private async others(
    tx: TransactionSql | Sql,
    missionId: string,
    exceptItem: string | null,
  ): Promise<number> {
    const rows =
      await tx`select stage, amount_minor, refunded_minor from mission_ledger_items where mission_id = ${missionId}
      and (${exceptItem}::text is null or item_id <> ${exceptItem})`;
    return rows.reduce(
      (n, r) =>
        n +
        exposureOf({
          stage: r.stage as Stage,
          amountMinor: Number(r.amount_minor),
          refundedMinor: Number(r.refunded_minor),
        }),
      0,
    );
  }
  private async audit(
    c: LedgerCaller,
    action: string,
    subjectId: string,
    detail: Record<string, string | number>,
    now: string,
  ) {
    await this.deps.audit
      .append({
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
        subjectKind: "MISSION_LEDGER",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private verificationAfter(current: string, evidence: EvidenceKind): string {
    // Verification only ever improves: PayFlow's own receipt or a provider confirmation upgrades it; nothing downgrades it.
    if (evidence === "PROVIDER_CONFIRMATION") return "PROVIDER_CONFIRMED";
    if (
      evidence === "PAYFLOW_AUTHORITY_RECEIPT" ||
      evidence === "PAYFLOW_PROOF"
    )
      return current === "PROVIDER_CONFIRMED" ? current : "PAYFLOW_ENFORCED";
    return current;
  }
  private async append(
    tx: TransactionSql,
    itemId: string,
    from: Stage | null,
    to: Stage,
    amount: number,
    refunded: number,
    verification: string,
    ek: EvidenceKind,
    evidence: unknown,
    actor: LedgerCaller,
    key: string,
    now: string,
  ) {
    const [n] =
      await tx`select coalesce(max(seq),0)::int n from mission_ledger_entries where item_id = ${itemId}`;
    await tx`insert into mission_ledger_entries (item_id, seq, from_stage, to_stage, amount_minor, refunded_minor, verification, evidence_kind, evidence,
        actor_kind, actor_id, idempotency_key, occurred_at)
      values (${itemId}, ${Number(n!.n) + 1}, ${from}, ${to}, ${amount}, ${refunded}, ${verification}, ${ek}, ${tx.json(evidence as never)}, ${actor.kind}, ${actor.id}, ${key}, ${now})`;
  }

  /**
   * The insert itself, on the caller's transaction. Nothing here touches the pool, so a caller that already holds a transaction can
   * create ledger items atomically with its own writes (the mission row lock is taken on that same connection).
   */
  private async insertItem(
    tx: TransactionSql,
    caller: LedgerCaller,
    missionId: string,
    b: z.infer<typeof CreateItemSchema>,
    digest: string,
    now: string,
  ): Promise<LResult<{ item: Row; replayed: boolean }>> {
    const m = await this.lock(tx, caller, missionId);
    if (!m) return { ok: false, refusal: "NOT_FOUND" };
    const [prior] =
      await tx`select * from mission_ledger_items where mission_id = ${missionId} and idempotency_key = ${b.idempotencyKey}`;
    if (prior)
      return prior.request_digest === digest
        ? { ok: true, value: { item: prior, replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    const contract = await this.contractOf(tx, m);
    if (b.currency !== contract.currency)
      return {
        ok: false,
        refusal: "CURRENCY_MISMATCH",
        detail: `${b.currency}!=${contract.currency}`,
      };
    if (
      b.stage === "CANCELLED" ||
      b.stage === "RELEASED" ||
      b.stage === "FAILED" ||
      b.stage === "REFUNDED" ||
      b.stage === "SETTLED" ||
      b.stage === "IN_FLIGHT" ||
      b.stage === "UNKNOWN" ||
      b.stage === "RESERVED"
    )
      // An item is born as an estimate, a quote, an approval, or an obligation recorded from outside (committed). Money-moving
      // stages are reached by transition, with evidence, never by declaration.
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: "ITEMS_START_AS_ESTIMATE_QUOTE_APPROVAL_OR_COMMITMENT",
      };
    if (!evidenceOk(b.stage, b.evidenceKind, b.verification))
      return { ok: false, refusal: "EVIDENCE_INSUFFICIENT" };
    if (consumes(b.stage)) {
      if (caller.kind === "AGENT")
        return { ok: false, refusal: "AGENT_NOT_PERMITTED" };
      if (m.status !== "ACTIVE")
        return {
          ok: false,
          refusal: "MISSION_NOT_ACTIVE",
          detail: String(m.status),
        };
      if (b.amountMinor > contract.maxCommitmentMinor)
        return { ok: false, refusal: "ABOVE_MAX_COMMITMENT" };
      if (
        (await this.others(tx, missionId, null)) + b.amountMinor >
        contract.totalBudgetMinor
      )
        return { ok: false, refusal: "CAPACITY_EXCEEDED" };
    }
    const itemId = `itm_${randomBytes(12).toString("hex")}`;
    const [item] =
      await tx`insert into mission_ledger_items (item_id, mission_id, created_by_kind, created_by, agent_id, kind, label, currency, amount_minor,
      stage, verification, idempotency_key, request_digest, created_at, updated_at)
    values (${itemId}, ${missionId}, ${caller.kind}, ${caller.id}, ${caller.kind === "AGENT" ? caller.id : (b.agentId ?? null)}, ${b.kind}, ${b.label}, ${b.currency},
      ${b.amountMinor}, ${b.stage}, ${b.verification}, ${b.idempotencyKey}, ${digest}, ${now}, ${now}) returning *`;
    await this.append(
      tx,
      itemId,
      null,
      b.stage,
      b.amountMinor,
      0,
      b.verification,
      b.evidenceKind,
      b.evidence,
      caller,
      b.idempotencyKey,
      now,
    );
    return { ok: true, value: { item: item!, replayed: false } };
  }

  /**
   * Create a ledger item inside the caller's transaction. Returns the item and a function that records the audit entry: call it only
   * AFTER the transaction commits (the audit log uses its own connection and must never describe something that rolled back).
   */
  async createItemInTx(
    tx: TransactionSql,
    caller: LedgerCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<
    LResult<ItemView & { replayed: boolean }> & {
      after?: () => Promise<void>;
    }
  > {
    if (caller.kind === "AGENT")
      return { ok: false, refusal: "AGENT_NOT_PERMITTED" };
    const body = CreateItemSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const b = body.data;
    const now = this.deps.now();
    const out = await this.insertItem(
      tx,
      caller,
      missionId,
      b,
      sha({ missionId, ...b }),
      now,
    );
    if (!out.ok) return out;
    const itemId = String(out.value.item.item_id);
    return {
      ok: true,
      value: { ...toItem(out.value.item), replayed: out.value.replayed },
      after: async () => {
        if (!out.value.replayed)
          await this.audit(
            caller,
            "MISSION_LEDGER_ITEM_CREATED",
            itemId,
            { stage: b.stage, amountMinor: b.amountMinor },
            now,
          );
      },
    };
  }

  // -------------------------------------------------------------------------------------------- create
  async createItem(
    caller: LedgerCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<LResult<ItemView & { replayed: boolean }>> {
    const body = CreateItemSchema.safeParse(rawBody);
    if (!body.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: body.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}:${i.message}`)
          .join(" | "),
      };
    const b = body.data;
    const now = this.deps.now();
    const digest = sha({ missionId, ...b });
    if (caller.kind === "AGENT") {
      if (!AGENT_STAGES.includes(b.stage))
        return {
          ok: false,
          refusal: "AGENT_NOT_PERMITTED",
          detail: "AGENTS_ONLY_ESTIMATE_AND_QUOTE",
        };
      let allowed = false;
      for (const cap of ["SEARCH", "COMPARE", "NEGOTIATE"] as const)
        if (
          (
            await this.deps.missions.authorizeCapability(
              caller,
              missionId,
              caller.id,
              cap,
            )
          ).allowed
        )
          allowed = true;
      if (!allowed) return { ok: false, refusal: "CAPABILITY_REFUSED" };
      if (b.evidenceKind !== "NONE" && b.evidenceKind !== "AGENT_REPORTED")
        return {
          ok: false,
          refusal: "EVIDENCE_INSUFFICIENT",
          detail: "AGENT_CANNOT_CLAIM_AUTHORITATIVE_EVIDENCE",
        };
    }
    const out = await this.deps.sql.begin((tx) =>
      this.insertItem(tx, caller, missionId, b, digest, now),
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.audit(
        caller,
        "MISSION_LEDGER_ITEM_CREATED",
        String(out.value.item.item_id),
        { stage: b.stage, amountMinor: b.amountMinor },
        now,
      );
    return {
      ok: true,
      value: { ...toItem(out.value.item), replayed: out.value.replayed },
    };
  }

  /** The transition itself, on the caller's transaction: nothing here touches the pool. */
  private async applyTransition(
    tx: TransactionSql,
    caller: LedgerCaller,
    itemId: string,
    missionId: string,
    b: z.infer<typeof TransitionSchema>,
    now: string,
  ): Promise<LResult<{ item: Row; replayed: boolean }>> {
    const m = await this.lock(tx, caller, missionId);
    if (!m) return { ok: false, refusal: "NOT_FOUND" };
    const [dup] =
      await tx`select idempotency_key from mission_ledger_entries where item_id = ${itemId} and idempotency_key = ${b.idempotencyKey}`;
    const [cur0] =
      await tx`select * from mission_ledger_items where item_id = ${itemId} for update`;
    if (!cur0) return { ok: false, refusal: "NOT_FOUND" };
    if (dup) {
      // A repeat of an applied transition: only an identical request is a replay.
      const [e] =
        await tx`select to_stage, amount_minor, refunded_minor from mission_ledger_entries where item_id = ${itemId} and idempotency_key = ${b.idempotencyKey}`;
      const same =
        e!.to_stage === b.to &&
        (b.amountMinor === undefined ||
          Number(e!.amount_minor) === b.amountMinor);
      return same
        ? { ok: true, value: { item: cur0, replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    }
    const cur = toItem(cur0);
    if (
      b.expectedRowVersion !== undefined &&
      b.expectedRowVersion !== cur.rowVersion
    )
      return { ok: false, refusal: "STALE_ROW_VERSION" };
    const contract = await this.contractOf(tx, m);
    const refundOnly = b.refundMinor !== undefined;
    let to = b.to;
    let amount = cur.amountMinor;
    let refunded = cur.refundedMinor;

    // --- who may do this
    if (caller.kind === "AGENT") {
      if (cur0.agent_id !== caller.id)
        return {
          ok: false,
          refusal: "AGENT_NOT_PERMITTED",
          detail: "NOT_YOUR_ITEM",
        };
      if (!(
        AGENT_STAGES.includes(to) ||
        (to === "CANCELLED" && !consumes(cur.stage))
      ))
        return {
          ok: false,
          refusal: "AGENT_NOT_PERMITTED",
          detail: "AGENTS_ONLY_ESTIMATE_AND_QUOTE",
        };
      if (b.evidenceKind !== "NONE" && b.evidenceKind !== "AGENT_REPORTED")
        return {
          ok: false,
          refusal: "EVIDENCE_INSUFFICIENT",
          detail: "AGENT_CANNOT_CLAIM_AUTHORITATIVE_EVIDENCE",
        };
    }
    if (b.evidenceKind === "AGENT_REPORTED" && caller.kind !== "AGENT")
      return { ok: false, refusal: "EVIDENCE_INSUFFICIENT" };

    // --- what move
    if (refundOnly) {
      if (cur.stage !== "SETTLED" || !(to === "SETTLED" || to === "REFUNDED"))
        return {
          ok: false,
          refusal: "ILLEGAL_MOVE",
          detail: "REFUNDS_APPLY_TO_SETTLED_ITEMS",
        };
      if (b.refundMinor! > cur.amountMinor - cur.refundedMinor)
        return { ok: false, refusal: "REFUND_EXCEEDS_SETTLED" };
      refunded = cur.refundedMinor + b.refundMinor!;
      to = refunded === cur.amountMinor ? "REFUNDED" : "SETTLED";
      if (!evidenceOk("REFUNDED", b.evidenceKind, cur.verification as never))
        return { ok: false, refusal: "EVIDENCE_INSUFFICIENT" };
    } else {
      // An obligation recorded from OUTSIDE PayFlow (owner-reported or unverified) may be settled straight from COMMITTED: it never
      // passed through a PayFlow reservation. Nothing PayFlow enforces may skip those stages.
      const external =
        cur.verification === "OWNER_REPORTED" ||
        cur.verification === "UNVERIFIED";
      const externalSettle =
        external && cur.stage === "COMMITTED" && to === "SETTLED";
      if (!canMove(cur.stage, to) && !externalSettle)
        return {
          ok: false,
          refusal: "ILLEGAL_MOVE",
          detail: `${cur.stage}->${to}`,
        };
      if (b.amountMinor !== undefined && b.amountMinor !== cur.amountMinor) {
        // The amount changes only when an offer is re-quoted; once approved it is frozen.
        if (!(
          to === "QUOTED" &&
          (cur.stage === "QUOTED" ||
            cur.stage === "APPROVED" ||
            cur.stage === "ESTIMATED")
        ))
          return { ok: false, refusal: "AMOUNT_FROZEN" };
        amount = b.amountMinor;
      }
      if (!evidenceOk(to, b.evidenceKind, cur.verification as never))
        return {
          ok: false,
          refusal: "EVIDENCE_INSUFFICIENT",
          detail: `${to}_NEEDS_BETTER_EVIDENCE`,
        };
    }

    // --- mission state and capacity
    const entersNew =
      ["APPROVED", "COMMITTED", "RESERVED", "IN_FLIGHT"].includes(to) &&
      cur.stage !== to;
    if (entersNew && m.status !== "ACTIVE")
      return {
        ok: false,
        refusal: "MISSION_NOT_ACTIVE",
        detail: String(m.status),
      };
    const after = exposureOf({
      stage: to,
      amountMinor: amount,
      refundedMinor: refunded,
    });
    const before = exposureOf({
      stage: cur.stage,
      amountMinor: cur.amountMinor,
      refundedMinor: cur.refundedMinor,
    });
    if (after > before) {
      if (
        ["APPROVED", "COMMITTED", "RESERVED", "IN_FLIGHT"].includes(to) &&
        amount > contract.maxCommitmentMinor
      )
        return { ok: false, refusal: "ABOVE_MAX_COMMITMENT" };
      if (
        (await this.others(tx, missionId, itemId)) + after >
        contract.totalBudgetMinor
      )
        return { ok: false, refusal: "CAPACITY_EXCEEDED" };
    }

    const verification = this.verificationAfter(
      cur.verification,
      b.evidenceKind,
    );
    await tx`update mission_ledger_items set stage = ${to}, amount_minor = ${amount}, refunded_minor = ${refunded}, verification = ${verification},
    row_version = row_version + 1, updated_at = ${now} where item_id = ${itemId}`;
    await this.append(
      tx,
      itemId,
      cur.stage,
      to,
      amount,
      refunded,
      verification,
      b.evidenceKind,
      b.evidence,
      caller,
      b.idempotencyKey,
      now,
    );
    const [after0] =
      await tx`select * from mission_ledger_items where item_id = ${itemId}`;
    return { ok: true, value: { item: after0!, replayed: false } };
  }

  /**
   * Move a ledger item inside the caller's transaction (the item's mission is read on that connection). Returns a function that records
   * the audit entry; call it only AFTER the transaction commits.
   */
  async transitionInTx(
    tx: TransactionSql,
    caller: LedgerCaller,
    itemId: string,
    rawBody: unknown,
  ): Promise<
    LResult<ItemView & { replayed: boolean }> & { after?: () => Promise<void> }
  > {
    const body = TransitionSchema.safeParse(rawBody);
    if (!body.success) return { ok: false, refusal: "MALFORMED" };
    const b = body.data;
    const now = this.deps.now();
    const [found] =
      await tx`select i.mission_id from mission_ledger_items i join missions m on m.mission_id = i.mission_id
      where i.item_id = ${itemId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!found) return { ok: false, refusal: "NOT_FOUND" };
    const out = await this.applyTransition(
      tx,
      caller,
      itemId,
      String(found.mission_id),
      b,
      now,
    );
    if (!out.ok) return out;
    return {
      ok: true,
      value: { ...toItem(out.value.item), replayed: out.value.replayed },
      after: async () => {
        if (!out.value.replayed)
          await this.audit(
            caller,
            "MISSION_LEDGER_TRANSITION",
            itemId,
            {
              to: String(out.value.item.stage),
              amountMinor: Number(out.value.item.amount_minor),
            },
            now,
          );
      },
    };
  }

  // ---------------------------------------------------------------------------------------- transition
  async transition(
    caller: LedgerCaller,
    itemId: string,
    rawBody: unknown,
  ): Promise<LResult<ItemView & { replayed: boolean }>> {
    const body = TransitionSchema.safeParse(rawBody);
    if (!body.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: body.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}:${i.message}`)
          .join(" | "),
      };
    const b = body.data;
    const now = this.deps.now();
    const [found] = await this.deps
      .sql`select i.mission_id from mission_ledger_items i join missions m on m.mission_id = i.mission_id
      where i.item_id = ${itemId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!found) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(found.mission_id);
    const out = await this.deps.sql.begin((tx) =>
      this.applyTransition(tx, caller, itemId, missionId, b, now),
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.audit(
        caller,
        "MISSION_LEDGER_TRANSITION",
        itemId,
        {
          to: String(out.value.item.stage),
          amountMinor: Number(out.value.item.amount_minor),
        },
        now,
      );
    return {
      ok: true,
      value: { ...toItem(out.value.item), replayed: out.value.replayed },
    };
  }

  // ------------------------------------------------------------------------------------------------ read
  async overview(
    caller: Pick<LedgerCaller, "organizationId" | "environment">,
    missionId: string,
  ): Promise<
    LResult<{
      summary: LedgerSummary & { overCommittedMinor: number };
      items: ItemView[];
    }>
  > {
    const sql = this.deps.sql;
    const [m] =
      await sql`select * from missions where mission_id = ${missionId} and organization_id = ${caller.organizationId} and environment = ${caller.environment}`;
    if (!m) return { ok: false, refusal: "NOT_FOUND" };
    const contract = await this.contractOf(sql, m);
    const rows =
      await sql`select * from mission_ledger_items where mission_id = ${missionId} order by created_at, item_id`;
    const items = rows.map(toItem);
    const summary = summarize(
      contract.currency,
      contract.totalBudgetMinor,
      items,
    );
    return {
      ok: true,
      value: {
        summary: {
          ...summary,
          overCommittedMinor: Math.max(
            0,
            summary.exposureMinor - contract.totalBudgetMinor,
          ),
        },
        items,
      },
    };
  }
  async history(
    caller: Pick<LedgerCaller, "organizationId" | "environment">,
    itemId: string,
  ) {
    const [x] = await this.deps
      .sql`select i.item_id from mission_ledger_items i join missions m on m.mission_id = i.mission_id
      where i.item_id = ${itemId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!x) return null;
    const rows = await this.deps
      .sql`select seq, from_stage, to_stage, amount_minor, refunded_minor, verification, evidence_kind, evidence, actor_kind, actor_id, occurred_at
      from mission_ledger_entries where item_id = ${itemId} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      from: (r.from_stage as string | null) ?? null,
      to: String(r.to_stage),
      amountMinor: Number(r.amount_minor),
      refundedMinor: Number(r.refunded_minor),
      verification: String(r.verification),
      evidenceKind: String(r.evidence_kind),
      evidence: r.evidence as unknown,
      actorKind: String(r.actor_kind),
      actorId: String(r.actor_id),
      at: iso(r.occurred_at),
    }));
  }
}
