import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { LedgerService } from "./ledger-service.js";
import { contractAllows } from "./qualification.js";
import {
  QuoteDocumentSchema,
  compareQuotes,
  landed,
  statusOf,
  type Landed,
  type QuoteStatus,
} from "./quotes.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M34 — recording supplier quotes and what they cost landed. A quote is what a supplier STATED, kept immutable; a newer one
 * supersedes it. Recording needs COMPARE (agents) or the plan permission (people). Nothing here accepts, reserves or commits.
 * Putting a quote in the budget creates one QUOTED ledger item (which holds no budget until a person approves it in the ledger),
 * once, and only when the quote is current, complete and in the mission's currency.
 */
export type QuoteRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "SUPPLIER_NOT_ALLOWED_BY_CONTRACT"
  | "SOURCE_EVIDENCE_INVALID"
  | "QUOTE_EXPIRED"
  | "QUOTE_SUPERSEDED"
  | "QUOTE_INCOMPLETE"
  | "CURRENCY_MISMATCH"
  | "LEDGER_REFUSED";
export type QResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: QuoteRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const RecordQuoteSchema = z
  .object({
    supplierId: z.string().regex(/^sup_[a-f0-9]{24}$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    validUntil: z.string().datetime(),
    document: QuoteDocumentSchema,
    source: z
      .object({
        kind: z.enum([
          "CONNECTOR_CALL",
          "DOCUMENT_REF",
          "SUPPLIER_STATED",
          "OWNER_REPORTED",
        ]),
        ref: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    supersedes: z
      .string()
      .regex(/^qte_[a-f0-9]{24}$/u)
      .optional(),
    idempotencyKey: Idem,
  })
  .strict();
const LedgerLinkSchema = z.object({ idempotencyKey: Idem }).strict();
const CompareSchema = z
  .object({
    quoteIds: z
      .array(z.string().regex(/^qte_[a-f0-9]{24}$/u))
      .min(2)
      .max(20)
      .optional(),
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
export const QUOTE_NOTICE =
  "A quote is what the supplier stated, as recorded. It is not an acceptance and not binding, and a landed total is shown only when nothing in it is unknown.";

export interface QuoteView {
  readonly quoteId: string;
  readonly missionId: string;
  readonly supplierId: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly status: QuoteStatus;
  readonly document: z.infer<typeof QuoteDocumentSchema>;
  readonly landed: Landed;
  readonly source: { kind: string; ref: string | null };
  readonly supersedes: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly ledgerItemId: string | null;
}

export class QuoteService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
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
        subjectKind: "MISSION_QUOTE",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async gate(
    caller: MissionCaller,
    missionId: string,
  ): Promise<QResult<true>> {
    if (caller.kind !== "AGENT") return { ok: true, value: true };
    const a = await this.deps.missions.authorizeCapability(
      caller,
      missionId,
      caller.id,
      "COMPARE",
    );
    if (a.allowed) return { ok: true, value: true };
    return a.reason === "MISSION_NOT_FOUND"
      ? { ok: false, refusal: "NOT_FOUND" }
      : { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
  }
  private view(
    r: Row,
    now: string,
    superseded: Set<string>,
    ledgerItem: string | null,
  ): QuoteView {
    const document = QuoteDocumentSchema.parse(r.document);
    const l = landed(document);
    if ("tooLarge" in l) throw new Error("STORED_QUOTE_OUT_OF_RANGE");
    return {
      quoteId: String(r.quote_id),
      missionId: String(r.mission_id),
      supplierId: String(r.supplier_id),
      currency: String(r.currency).trim(),
      validUntil: iso(r.valid_until),
      status: statusOf(
        iso(r.valid_until),
        superseded.has(String(r.quote_id)),
        now,
      ),
      document,
      landed: l,
      source: {
        kind: String(r.source_kind),
        ref: (r.source_ref as string | null) ?? null,
      },
      supersedes: (r.supersedes_quote_id as string | null) ?? null,
      recordedBy: `${String(r.recorded_by_kind).toLowerCase()}:${String(r.recorded_by)}`,
      recordedAt: iso(r.recorded_at),
      ledgerItemId: ledgerItem,
    };
  }

  // ---------------------------------------------------------------------------------------------------- record
  async record(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<QResult<{ quote: QuoteView; replayed: boolean }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const g = await this.gate(caller, missionId);
    if (!g.ok) return g;
    const b = RecordQuoteSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const q = b.data;
    const sql = this.deps.sql;
    const now = this.deps.now();
    const [sup] =
      await sql`select supplier_id, external_ref from mission_suppliers where supplier_id = ${q.supplierId} and mission_id = ${missionId}`;
    if (!sup) return { ok: false, refusal: "NOT_FOUND", detail: "SUPPLIER" };
    const contract = m.value.activeContract ?? m.value.latestContract;
    if (!contractAllows(contract, String(sup.external_ref)).allowed)
      return { ok: false, refusal: "SUPPLIER_NOT_ALLOWED_BY_CONTRACT" };
    const l = landed(q.document);
    if ("tooLarge" in l)
      return { ok: false, refusal: "MALFORMED", detail: "AMOUNT_OUT_OF_RANGE" };
    if (Date.parse(q.validUntil) <= Date.parse(now))
      return { ok: false, refusal: "QUOTE_EXPIRED", detail: "ALREADY_EXPIRED" };
    if (Date.parse(q.validUntil) > Date.parse(now) + 366 * 86_400_000)
      return { ok: false, refusal: "MALFORMED", detail: "VALID_UNTIL_TOO_FAR" };
    // evidence for where the quote came from
    const ref = q.source.ref ?? null;
    if (q.source.kind === "OWNER_REPORTED" && caller.kind !== "MEMBER")
      return {
        ok: false,
        refusal: "SOURCE_EVIDENCE_INVALID",
        detail: "OWNER_REPORTED_IS_A_PERSONS_ACT",
      };
    if (q.source.kind !== "OWNER_REPORTED" && !ref)
      return {
        ok: false,
        refusal: "SOURCE_EVIDENCE_INVALID",
        detail: "REFERENCE_REQUIRED",
      };
    if (q.source.kind === "CONNECTOR_CALL") {
      const [c] =
        await sql`select 1 from connector_calls where call_id = ${ref} and mission_id = ${missionId} and outcome = 'OK'`;
      if (!c)
        return {
          ok: false,
          refusal: "SOURCE_EVIDENCE_INVALID",
          detail: "NO_SUCH_SUCCESSFUL_CONNECTOR_CALL_FOR_THIS_MISSION",
        };
    }
    const digest = sha({ missionId, ...q, idempotencyKey: undefined });
    const id = `qte_${randomBytes(12).toString("hex")}`;
    const out = await sql.begin(
      async (tx): Promise<QResult<{ row: Row; replayed: boolean }>> => {
        await tx`select pg_advisory_xact_lock(hashtext(${missionId + "|" + q.supplierId}))`;
        const [prior] =
          await tx`select * from mission_quotes where mission_id = ${missionId} and recorded_by = ${caller.id} and idempotency_key = ${q.idempotencyKey}`;
        if (prior)
          return prior.request_digest === digest
            ? { ok: true, value: { row: prior, replayed: true } }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        if (q.supersedes) {
          const [old] =
            await tx`select supplier_id from mission_quotes where quote_id = ${q.supersedes} and mission_id = ${missionId}`;
          if (!old || old.supplier_id !== q.supplierId)
            return {
              ok: false,
              refusal: "NOT_FOUND",
              detail: "SUPERSEDED_QUOTE",
            };
          const [dup] =
            await tx`select 1 from mission_quotes where supersedes_quote_id = ${q.supersedes}`;
          if (dup)
            return {
              ok: false,
              refusal: "QUOTE_SUPERSEDED",
              detail: "ALREADY_REPLACED",
            };
        }
        const [row] =
          await tx`insert into mission_quotes (quote_id, mission_id, supplier_id, currency, valid_until, document, source_kind, source_ref,
          supersedes_quote_id, recorded_by_kind, recorded_by, idempotency_key, request_digest, recorded_at)
        values (${id}, ${missionId}, ${q.supplierId}, ${q.currency}, ${q.validUntil}, ${tx.json(q.document)}, ${q.source.kind}, ${ref},
          ${q.supersedes ?? null}, ${caller.kind}, ${caller.id}, ${q.idempotencyKey}, ${digest}, ${now}) returning *`;
        return { ok: true, value: { row: row!, replayed: false } };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(
        caller,
        "QUOTE_RECORDED",
        id,
        {
          supplier: q.supplierId,
          currency: q.currency,
          complete: l.complete ? 1 : 0,
        },
        now,
      );
    const view = await this.one(out.value.row, now);
    return { ok: true, value: { quote: view, replayed: out.value.replayed } };
  }

  private async one(row: Row, now: string): Promise<QuoteView> {
    const sql = this.deps.sql;
    const [sup] =
      await sql`select 1 from mission_quotes where supersedes_quote_id = ${String(row.quote_id)}`;
    const [link] =
      await sql`select item_id from mission_quote_ledger where quote_id = ${String(row.quote_id)}`;
    return this.view(
      row,
      now,
      new Set(sup ? [String(row.quote_id)] : []),
      link ? String(link.item_id) : null,
    );
  }

  // ---------------------------------------------------------------------------------------------------- read
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<QResult<{ quotes: QuoteView[]; notice: string }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const sql = this.deps.sql;
    const now = this.deps.now();
    const rows =
      await sql`select * from mission_quotes where mission_id = ${missionId} order by recorded_at, quote_id`;
    const sup = new Set(
      (
        await sql`select supersedes_quote_id from mission_quotes where mission_id = ${missionId} and supersedes_quote_id is not null`
      ).map((r) => String(r.supersedes_quote_id)),
    );
    const links = new Map(
      (
        await sql`select quote_id, item_id from mission_quote_ledger where quote_id in (select quote_id from mission_quotes where mission_id = ${missionId})`
      ).map((r) => [String(r.quote_id), String(r.item_id)]),
    );
    return {
      ok: true,
      value: {
        quotes: rows.map((r) =>
          this.view(r, now, sup, links.get(String(r.quote_id)) ?? null),
        ),
        notice: QUOTE_NOTICE,
      },
    };
  }

  async compare(caller: MissionCaller, missionId: string, rawBody: unknown) {
    const b = CompareSchema.safeParse(rawBody ?? {});
    if (!b.success)
      return { ok: false as const, refusal: "MALFORMED" as const };
    const g = await this.gate(caller, missionId);
    if (!g.ok) return g;
    const l = await this.list(
      caller.kind === "AGENT" ? caller : caller,
      missionId,
    );
    if (!l.ok) return l;
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false as const, refusal: "NOT_FOUND" as const };
    const contract = m.value.activeContract ?? m.value.latestContract;
    let quotes = l.value.quotes;
    if (b.data.quoteIds) {
      const wanted = new Set(b.data.quoteIds);
      quotes = quotes.filter((q) => wanted.has(q.quoteId));
      if (quotes.length !== wanted.size)
        return { ok: false as const, refusal: "NOT_FOUND" as const };
    }
    return {
      ok: true as const,
      value: {
        currency: contract.currency,
        ...compareQuotes(
          quotes.map((q) => ({
            quoteId: q.quoteId,
            supplierId: q.supplierId,
            currency: q.currency,
            status: q.status,
            landed: q.landed,
          })),
          contract.currency,
        ),
        notice: QUOTE_NOTICE,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------- into the budget
  async toLedger(
    caller: MissionCaller,
    quoteId: string,
    rawBody: unknown,
  ): Promise<QResult<{ quoteId: string; itemId: string; replayed: boolean }>> {
    if (!/^qte_[a-f0-9]{24}$/u.test(quoteId))
      return { ok: false, refusal: "NOT_FOUND" };
    const b = LedgerLinkSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const sql = this.deps.sql;
    const [r] =
      await sql`select q.*, m.organization_id, s.display_name from mission_quotes q
      join missions m on m.mission_id = q.mission_id join mission_suppliers s on s.supplier_id = q.supplier_id
      where q.quote_id = ${quoteId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!r) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(r.mission_id);
    const g = await this.gate(caller, missionId);
    if (!g.ok) return g;
    const now = this.deps.now();
    const view = await this.one(r, now);
    const [existing] =
      await sql`select item_id from mission_quote_ledger where quote_id = ${quoteId}`;
    if (existing)
      return {
        ok: true,
        value: { quoteId, itemId: String(existing.item_id), replayed: true },
      };
    if (view.status === "EXPIRED")
      return { ok: false, refusal: "QUOTE_EXPIRED" };
    if (view.status === "SUPERSEDED")
      return { ok: false, refusal: "QUOTE_SUPERSEDED" };
    if (!view.landed.complete || view.landed.totalMinor === null)
      return {
        ok: false,
        refusal: "QUOTE_INCOMPLETE",
        detail: view.landed.unknown.join(", "),
      };
    if (view.landed.totalMinor < 1)
      return { ok: false, refusal: "MALFORMED", detail: "ZERO_TOTAL" };
    const created = await this.deps.ledger.createItem(caller, missionId, {
      kind: "GOODS",
      label: `Quote from ${String(r.display_name)}`.slice(0, 200),
      amountMinor: view.landed.totalMinor,
      currency: view.currency,
      stage: "QUOTED",
      verification: "UNVERIFIED",
      // One deterministic key per quote: however many times or in whatever race this runs, the ledger gets one item.
      idempotencyKey: `quote-${quoteId}-ledger`,
    });
    if (!created.ok) {
      if (created.refusal === "CURRENCY_MISMATCH")
        return { ok: false, refusal: "CURRENCY_MISMATCH" };
      return { ok: false, refusal: "LEDGER_REFUSED", detail: created.refusal };
    }
    const itemId = (created.value as unknown as { itemId: string }).itemId;
    // The link row has two unique keys (quote and item). Concurrent callers all hold the same item, so a conflict on EITHER key means the
    // link already exists: ignore both, not just the quote key, or the loser of a race fails with a unique violation.
    const [linked] =
      await sql`insert into mission_quote_ledger (quote_id, item_id, linked_by, linked_at) values (${quoteId}, ${itemId}, ${caller.id}, ${now})
      on conflict do nothing returning item_id`;
    if (linked)
      await this.log(
        caller,
        "QUOTE_PUT_IN_BUDGET",
        quoteId,
        { amountMinor: view.landed.totalMinor },
        now,
      );
    return { ok: true, value: { quoteId, itemId, replayed: !linked } };
  }
}
