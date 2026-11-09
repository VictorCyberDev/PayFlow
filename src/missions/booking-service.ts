import { randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import {
  ConfirmSchema,
  EVIDENCE_KINDS,
  canMoveBooking,
  claim,
  depositState,
  heldMinor,
  type BookingState,
  type EvidenceKind,
} from "./booking.js";
import type { AutomationService } from "../automation/automation-service.js";
import type { LedgerService } from "./ledger-service.js";
import type { MissionCaller, MissionService } from "./service.js";
import {
  StaySchema,
  WorkspaceNeedSchema,
  assess,
  type WorkspaceListing,
} from "./workspace.js";

/**
 * V3 M53 — booking intents. Approving holds budget; only evidence a person attaches says a space is reserved or a deposit is paid; an
 * unclear outcome is UNKNOWN and is never retried. No provider is contacted by PayFlow here: the person books with the provider (a
 * handoff) and records what they were told. Every state change and its ledger effect are ONE transaction.
 */
export type BkRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "MEMBER_ONLY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "MISSION_NOT_ACTIVE"
  | "NOT_QUALIFIED"
  | "ALREADY_LIVE"
  | "BAD_DEADLINE"
  | "ILLEGAL_MOVE"
  | "EXPIRED"
  | "LEDGER_REFUSED"
  | "PENALTY_ABOVE_TERMS"
  | "DEPOSIT_NOT_REQUIRED";
export type BkResult<T> =
  { ok: true; value: T } | { ok: false; refusal: BkRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const ProposeSchema = z
  .object({
    searchId: z.string().regex(/^wsq_[a-f0-9]{24}$/u),
    listingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    /** Not confirmed by then => the intent expires and its budget is released. */
    deadline: z.string().datetime(),
    idempotencyKey: Idem,
  })
  .strict();
const NoteSchema = z
  .object({ note: z.string().trim().max(300).default("") })
  .strict();
const CancelSchema = z
  .object({
    /** What the provider's terms actually charge for cancelling: at most the frozen cancellation exposure. */
    penaltyMinor: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .default(0),
    note: z.string().trim().max(300).default(""),
  })
  .strict();
const DepositSchema = z
  .object({
    evidenceKind: z.enum(EVIDENCE_KINDS),
    evidenceRef: z.string().trim().min(1).max(300).optional(),
    refunded: z.boolean().default(false),
  })
  .strict()
  .refine(
    (d) =>
      d.evidenceKind === "OWNER_ATTESTATION" || d.evidenceRef !== undefined,
    { message: "evidence reference required" },
  );

type Row = Record<string, unknown>;
const iso = (v: unknown) => new Date(v as string).toISOString();
const MAX_DEADLINE_MS = 30 * 86_400_000;

interface Frozen {
  currency: string;
  rentMinor: number;
  totalCostMinor: number;
  depositMinor: number;
  maxExposureMinor: number;
  cancellationExposureMinor: number;
}
export interface BookingView {
  readonly bookingId: string;
  readonly missionId: string;
  readonly state: BookingState;
  readonly headline: string;
  readonly reserved: ReturnType<typeof claim>["reserved"];
  readonly listing: WorkspaceListing;
  readonly stay: z.infer<typeof StaySchema>;
  readonly frozen: Frozen;
  readonly heldMinor: number;
  readonly deposit: ReturnType<typeof depositState>;
  readonly deadline: string;
  readonly evidence: { kind: EvidenceKind; ref: string | null } | null;
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly notice: string;
}
const NOTICE =
  "PayFlow does not contact the provider or move a deposit. A space counts as reserved only when you attach evidence of the provider's confirmation.";

class Rollback extends Error {
  constructor(
    readonly refusal: BkRefusal,
    readonly detail?: string,
  ) {
    super("ROLLBACK");
  }
}

export class BookingService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      ledger: LedgerService;
      now: () => string;
      /** When present, approval schedules a durable job that expires the booking at its deadline even if nobody looks at it. */
      automation?: AutomationService;
    },
  ) {}

  private toView(r: Row): BookingView {
    const state = r.state as BookingState;
    const evidence = r.evidence_kind
      ? {
          kind: r.evidence_kind as EvidenceKind,
          ref: (r.evidence_ref as string | null) ?? null,
        }
      : null;
    const c = claim(state, evidence?.kind ?? null);
    const frozen = r.frozen as Frozen;
    return {
      bookingId: String(r.booking_id),
      missionId: String(r.mission_id),
      state,
      headline: c.headline,
      reserved: c.reserved,
      listing: r.listing as WorkspaceListing,
      stay: r.stay as z.infer<typeof StaySchema>,
      frozen,
      heldMinor: heldMinor(
        state,
        frozen,
        r.penalty_item_id ? frozen.cancellationExposureMinor : 0,
      ),
      deposit: depositState(
        frozen.depositMinor,
        r.deposit_evidence_kind
          ? { evidence: r.deposit_evidence_kind as EvidenceKind }
          : null,
        Boolean(r.deposit_refunded),
      ),
      deadline: iso(r.deadline),
      evidence,
      rowVersion: Number(r.row_version),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      notice: NOTICE,
    };
  }

  private async log(
    c: Pick<MissionCaller, "organizationId" | "environment" | "id" | "kind">,
    action: string,
    id: string,
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
        subjectKind: "MISSION_BOOKING",
        subjectId: id,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }

  private async row(
    caller: MissionCaller,
    bookingId: string,
  ): Promise<Row | null> {
    if (!/^bkg_[a-f0-9]{24}$/u.test(bookingId)) return null;
    const [r] = await this.deps
      .sql`select b.* from mission_bookings b join missions m on m.mission_id = b.mission_id
      where b.booking_id = ${bookingId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    return r ?? null;
  }

  /** Releases a booking's budget hold in the caller's transaction (no-op when nothing was ever held). */
  private release(
    caller: MissionCaller,
    bookingId: string,
  ): (
    tx: TransactionSql,
    r: Row,
    afters: (() => Promise<void>)[],
  ) => Promise<Record<string, unknown>> {
    return async (tx, r, afters) => {
      if (!r.ledger_item_id) return {};
      const t = await this.deps.ledger.transitionInTx(
        tx,
        caller,
        r.ledger_item_id as string,
        {
          to: "CANCELLED",
          idempotencyKey: `${bookingId}-release`.padEnd(16, "-"),
        },
      );
      if (!t.ok) throw new Rollback("LEDGER_REFUSED", t.refusal);
      if (t.after) afters.push(t.after);
      return {};
    };
  }

  /** Releases the budget of intents that ran past their deadline without confirmation. A booking in UNKNOWN is never expired. */
  async expireDue(caller: MissionCaller, missionId: string): Promise<void> {
    const now = this.deps.now();
    const due = await this.deps
      .sql`select booking_id from mission_bookings where mission_id = ${missionId}
      and state in ('PROPOSED','APPROVED','HANDED_OFF') and deadline <= ${now}`;
    for (const d of due)
      await this.move(
        caller,
        String(d.booking_id),
        ["PROPOSED", "APPROVED", "HANDED_OFF"],
        "EXPIRED",
        {
          actor: { kind: "SYSTEM", id: "expiry" },
          note: "deadline passed",
          inTx: this.release(caller, String(d.booking_id)),
        },
      ).catch(() => undefined);
  }

  /** The one place a state changes: row lock, legality, ledger effect and event in ONE transaction. */
  private async move(
    caller: Pick<MissionCaller, "organizationId" | "environment">,
    bookingId: string,
    from: readonly BookingState[],
    to: BookingState,
    o: {
      actor: { kind: "MEMBER" | "AGENT" | "SYSTEM"; id: string };
      note?: string;
      evidence?: { kind: EvidenceKind; ref: string | null };
      /** Extra work in the same transaction (ledger moves). May throw Rollback. */
      inTx?: (
        tx: TransactionSql,
        row: Row,
        afters: (() => Promise<void>)[],
      ) => Promise<Record<string, unknown>>;
    },
  ): Promise<BkResult<BookingView>> {
    const afters: (() => Promise<void>)[] = [];
    try {
      const now = this.deps.now();
      const updated = await this.deps.sql.begin(async (tx) => {
        const [cur] =
          await tx`select b.* from mission_bookings b join missions m on m.mission_id = b.mission_id
          where b.booking_id = ${bookingId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment} for update of b`;
        if (!cur) throw new Rollback("NOT_FOUND");
        const state = cur.state as BookingState;
        if (state === to) return { ...cur, __replay: true };
        if (!from.includes(state) || !canMoveBooking(state, to))
          throw new Rollback("ILLEGAL_MOVE", `${state}->${to}`);
        const extra = o.inTx ? await o.inTx(tx, cur, afters) : {};
        const cols = {
          state: to,
          updated_at: now,
          row_version: Number(cur.row_version) + 1,
          ...extra,
        };
        const [upd] =
          await tx`update mission_bookings set ${tx(cols as never)} where booking_id = ${bookingId} returning *`;
        await tx`insert into mission_booking_events (booking_id, from_state, to_state, actor_kind, actor_id, note, occurred_at)
          values (${bookingId}, ${state}, ${to}, ${o.actor.kind}, ${o.actor.id}, ${o.note ?? null}, ${now})`;
        return upd!;
      });
      for (const a of afters) await a();
      if (!updated["__replay"])
        await this.log(
          {
            ...caller,
            id: o.actor.id,
            kind: o.actor.kind === "AGENT" ? "AGENT" : "MEMBER",
          },
          `BOOKING_${to}`,
          bookingId,
          {},
          now,
        );
      return { ok: true, value: this.toView(updated) };
    } catch (e) {
      if (e instanceof Rollback)
        return {
          ok: false,
          refusal: e.refusal,
          ...(e.detail ? { detail: e.detail } : {}),
        };
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ propose
  async propose(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<BkResult<{ booking: BookingView; replayed: boolean }>> {
    const b = ProposeSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "REQUEST_APPROVAL",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const sql = this.deps.sql;
    const [prior] =
      await sql`select * from mission_bookings where mission_id = ${missionId} and created_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior)
      return prior.search_id === b.data.searchId &&
        prior.listing_id === b.data.listingId
        ? { ok: true, value: { booking: this.toView(prior), replayed: true } }
        : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    if (m.value.status !== "ACTIVE")
      return {
        ok: false,
        refusal: "MISSION_NOT_ACTIVE",
        detail: m.value.status,
      };
    const [s] =
      await sql`select * from mission_workspace_searches where search_id = ${b.data.searchId} and mission_id = ${missionId}`;
    const [l] = s
      ? await sql`select document from mission_workspace_listings where search_id = ${b.data.searchId} and listing_id = ${b.data.listingId}`
      : [];
    if (!s || !l) return { ok: false, refusal: "NOT_FOUND" };
    const listing = l.document as WorkspaceListing;
    const need = WorkspaceNeedSchema.parse(s.need);
    const stay = StaySchema.parse(s.stay);
    const a = assess(listing, need, stay, iso(s.cancel_at));
    // Only a listing that fits, with every term STATED, can be proposed: an unknown deposit or cancellation is never approved around.
    if (!a.qualified)
      return {
        ok: false,
        refusal: "NOT_QUALIFIED",
        detail: a.problems.join(","),
      };
    const now = this.deps.now();
    const deadline = Date.parse(b.data.deadline);
    if (
      !(deadline > Date.parse(now)) ||
      deadline > Date.parse(now) + MAX_DEADLINE_MS ||
      deadline > Date.parse(stay.start)
    )
      return { ok: false, refusal: "BAD_DEADLINE" };
    const lia = a.liability;
    const frozen: Frozen = {
      currency: lia.currency,
      rentMinor: lia.rentMinor,
      totalCostMinor: lia.totalCostMinor!,
      depositMinor: lia.depositMinor!,
      maxExposureMinor: lia.maxExposureMinor!,
      cancellationExposureMinor: lia.cancellationExposureMinor!,
    };
    const id = `bkg_${randomBytes(12).toString("hex")}`;
    try {
      const row = await sql.begin(async (tx) => {
        const [r] =
          await tx`insert into mission_bookings (booking_id, mission_id, search_id, listing_id, listing, stay, frozen, state, deadline, created_by_kind, created_by, idempotency_key, created_at, updated_at)
          values (${id}, ${missionId}, ${b.data.searchId}, ${b.data.listingId}, ${tx.json(listing)}, ${tx.json(stay)}, ${tx.json(frozen as never)}, 'PROPOSED', ${b.data.deadline}, ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${now}, ${now}) returning *`;
        await tx`insert into mission_booking_events (booking_id, from_state, to_state, actor_kind, actor_id, note, occurred_at) values (${id}, null, 'PROPOSED', ${caller.kind}, ${caller.id}, null, ${now})`;
        return r!;
      });
      await this.log(
        caller,
        "BOOKING_PROPOSED",
        id,
        { maxExposureMinor: frozen.maxExposureMinor },
        now,
      );
      return {
        ok: true,
        value: { booking: this.toView(row), replayed: false },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return { ok: false, refusal: "ALREADY_LIVE" };
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ owner decisions
  async approve(
    caller: MissionCaller,
    bookingId: string,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const cur = await this.row(caller, bookingId);
    if (!cur) return { ok: false, refusal: "NOT_FOUND" };
    await this.expireDue(caller, String(cur.mission_id));
    const now = this.deps.now();
    const approved = await this.move(
      caller,
      bookingId,
      ["PROPOSED"],
      "APPROVED",
      {
        actor: { kind: "MEMBER", id: caller.id },
        inTx: async (tx, r, afters) => {
          if (new Date(r.deadline as string).getTime() <= Date.parse(now))
            throw new Rollback("EXPIRED");
          const f = r.frozen as Frozen;
          const l = r.listing as WorkspaceListing;
          const created = await this.deps.ledger.createItemInTx(
            tx,
            caller,
            String(r.mission_id),
            {
              kind: "SERVICE",
              label: `Workspace: ${l.name}`.slice(0, 200),
              amountMinor: f.maxExposureMinor,
              currency: f.currency,
              stage: "APPROVED",
              verification: "OWNER_REPORTED",
              evidenceKind: "OWNER_REPORTED",
              evidence: { booking: bookingId },
              idempotencyKey: `${bookingId}-hold`.padEnd(16, "-"),
            },
          );
          if (!created.ok)
            throw new Rollback("LEDGER_REFUSED", created.refusal);
          if (created.after) afters.push(created.after);
          return { ledger_item_id: created.value.itemId };
        },
      },
    );
    if (approved.ok && this.deps.automation)
      // Best effort: the sweep is a second line of defence. Expiry also runs whenever anyone reads or acts on the mission's bookings.
      await this.deps.automation
        .enqueue(
          {
            organizationId: caller.organizationId,
            environment: caller.environment,
          },
          {
            kind: "BOOKING_EXPIRE",
            effect: "NONE",
            payload: { missionId: approved.value.missionId },
            dedupeKey: bookingId,
            runAfter: approved.value.deadline,
          },
        )
        .catch(() => undefined);
    return approved;
  }

  /** The person books with the provider. PayFlow gives them the exact frozen terms and records that the attempt began. */
  async handOff(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<{ booking: BookingView; packet: object }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = NoteSchema.safeParse(raw);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const r = await this.move(caller, bookingId, ["APPROVED"], "HANDED_OFF", {
      actor: { kind: "MEMBER", id: caller.id },
      note: b.data.note,
    });
    if (!r.ok) return r;
    const v = r.value;
    return {
      ok: true,
      value: {
        booking: v,
        packet: {
          provider: v.listing.provenance.sourceId,
          listing: v.listing.name,
          providerListingId: v.listing.listingId,
          url: v.listing.provenance.url,
          dates: v.stay,
          people: v.stay.people,
          expectedTotalMinor: v.frozen.totalCostMinor,
          expectedDepositMinor: v.frozen.depositMinor,
          currency: v.frozen.currency,
          doNot:
            "Do not agree to terms, rates or a deposit different from these without coming back here: they were approved as shown.",
          afterwards:
            "Record the provider's confirmation (or that it was refused) here. Until then PayFlow treats nothing as reserved.",
        },
      },
    };
  }

  async markUnknown(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = NoteSchema.safeParse(raw);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    return this.move(caller, bookingId, ["HANDED_OFF"], "UNKNOWN", {
      actor: { kind: "MEMBER", id: caller.id },
      note: b.data.note,
    });
  }

  async confirm(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ConfirmSchema.safeParse(raw);
    if (!b.success)
      return { ok: false, refusal: "MALFORMED", detail: "evidence" };
    return this.move(
      caller,
      bookingId,
      ["HANDED_OFF", "UNKNOWN"],
      "CONFIRMED",
      {
        actor: { kind: "MEMBER", id: caller.id },
        note: b.data.note,
        evidence: {
          kind: b.data.evidenceKind,
          ref: b.data.evidenceRef ?? null,
        },
        inTx: async (tx, r, afters) => {
          // The hold becomes a recorded obligation. Whatever the evidence, the ledger item stays labelled OWNER_REPORTED: PayFlow did not verify it.
          const t = await this.deps.ledger.transitionInTx(
            tx,
            caller,
            String(r.ledger_item_id),
            {
              to: "COMMITTED",
              evidenceKind: "OWNER_REPORTED",
              evidence: {
                booking: bookingId,
                evidence: b.data.evidenceKind,
                // the ledger takes strings and numbers only: an absent reference is simply absent
                ...(b.data.evidenceRef ? { ref: b.data.evidenceRef } : {}),
              },
              idempotencyKey: `${bookingId}-commit`.padEnd(16, "-"),
            },
          );
          if (!t.ok) throw new Rollback("LEDGER_REFUSED", t.refusal);
          if (t.after) afters.push(t.after);
          return {
            evidence_kind: b.data.evidenceKind,
            evidence_ref: b.data.evidenceRef ?? null,
          };
        },
      },
    );
  }

  /** Not booked: the provider refused, or the owner abandoned it. From UNKNOWN this needs evidence that it was NOT booked. */
  async decline(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const cur = await this.row(caller, bookingId);
    if (!cur) return { ok: false, refusal: "NOT_FOUND" };
    // Declining a booking that is already declined is a replay, not a second release.
    if (cur.state === "DECLINED") return { ok: true, value: this.toView(cur) };
    const b =
      cur.state === "UNKNOWN"
        ? ConfirmSchema.safeParse(raw)
        : NoteSchema.safeParse(raw);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail:
          cur.state === "UNKNOWN"
            ? "evidence that it was not booked"
            : undefined,
      } as BkResult<BookingView>;
    return this.move(
      caller,
      bookingId,
      ["PROPOSED", "APPROVED", "HANDED_OFF", "UNKNOWN"],
      "DECLINED",
      {
        actor: { kind: "MEMBER", id: caller.id },
        note: b.data.note,
        inTx: async (tx, r, afters) => {
          if (!r.ledger_item_id) return {};
          const t = await this.deps.ledger.transitionInTx(
            tx,
            caller,
            r.ledger_item_id as string,
            {
              to: "CANCELLED",
              idempotencyKey: `${bookingId}-release`.padEnd(16, "-"),
            },
          );
          if (!t.ok) throw new Rollback("LEDGER_REFUSED", t.refusal);
          if (t.after) afters.push(t.after);
          return {};
        },
      },
    );
  }

  async cancel(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = CancelSchema.safeParse(raw);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    return this.move(caller, bookingId, ["CONFIRMED"], "CANCELLED", {
      actor: { kind: "MEMBER", id: caller.id },
      note: b.data.note,
      inTx: async (tx, r, afters) => {
        const f = r.frozen as Frozen;
        if (b.data.penaltyMinor > f.cancellationExposureMinor)
          throw new Rollback("PENALTY_ABOVE_TERMS");
        let penaltyItem: string | null = null;
        if (b.data.penaltyMinor > 0) {
          const p = await this.deps.ledger.createItemInTx(
            tx,
            caller,
            String(r.mission_id),
            {
              kind: "FEE",
              label:
                `Cancellation charge: ${(r.listing as WorkspaceListing).name}`.slice(
                  0,
                  200,
                ),
              amountMinor: b.data.penaltyMinor,
              currency: f.currency,
              stage: "COMMITTED",
              verification: "OWNER_REPORTED",
              evidenceKind: "OWNER_REPORTED",
              evidence: { booking: bookingId },
              idempotencyKey: `${bookingId}-penalty`.padEnd(16, "-"),
            },
          );
          if (!p.ok) throw new Rollback("LEDGER_REFUSED", p.refusal);
          if (p.after) afters.push(p.after);
          penaltyItem = p.value.itemId;
        }
        const t = await this.deps.ledger.transitionInTx(
          tx,
          caller,
          String(r.ledger_item_id),
          {
            to: "CANCELLED",
            idempotencyKey: `${bookingId}-cancel`.padEnd(16, "-"),
          },
        );
        if (!t.ok) throw new Rollback("LEDGER_REFUSED", t.refusal);
        if (t.after) afters.push(t.after);
        return { penalty_item_id: penaltyItem };
      },
    });
  }

  /** Records that the deposit was paid (or refunded) WITH evidence. PayFlow does not move deposits. */
  async recordDeposit(
    caller: MissionCaller,
    bookingId: string,
    raw: unknown,
  ): Promise<BkResult<BookingView>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = DepositSchema.safeParse(raw);
    if (!b.success)
      return { ok: false, refusal: "MALFORMED", detail: "evidence" };
    const cur = await this.row(caller, bookingId);
    if (!cur) return { ok: false, refusal: "NOT_FOUND" };
    if ((cur.frozen as Frozen).depositMinor === 0)
      return { ok: false, refusal: "DEPOSIT_NOT_REQUIRED" };
    if (!["HANDED_OFF", "UNKNOWN", "CONFIRMED"].includes(String(cur.state)))
      return { ok: false, refusal: "ILLEGAL_MOVE", detail: String(cur.state) };
    if (b.data.refunded && !cur.deposit_evidence_kind)
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: "NO_DEPOSIT_RECORDED",
      };
    const now = this.deps.now();
    const [u] = b.data.refunded
      ? await this.deps
          .sql`update mission_bookings set deposit_refunded = true, updated_at = ${now}, row_version = row_version + 1 where booking_id = ${bookingId} returning *`
      : await this.deps
          .sql`update mission_bookings set deposit_evidence_kind = ${b.data.evidenceKind}, deposit_evidence_ref = ${b.data.evidenceRef ?? null}, updated_at = ${now}, row_version = row_version + 1 where booking_id = ${bookingId} returning *`;
    await this.log(
      caller,
      b.data.refunded ? "BOOKING_DEPOSIT_REFUNDED" : "BOOKING_DEPOSIT_RECORDED",
      bookingId,
      {},
      now,
    );
    return { ok: true, value: this.toView(u!) };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<BkResult<{ bookings: BookingView[] }>> {
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
    await this.expireDue(caller, missionId);
    const rows = await this.deps
      .sql`select * from mission_bookings where mission_id = ${missionId} order by created_at desc, booking_id limit 50`;
    return { ok: true, value: { bookings: rows.map((r) => this.toView(r)) } };
  }
}
