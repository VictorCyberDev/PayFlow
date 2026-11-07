import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import { DefinitiveSendError, type ChannelRegistry } from "./channels.js";
import {
  AddressSchema,
  canMove,
  leakFindings,
  type MessageStatus,
  type Secrets,
} from "./communication.js";
import {
  expectedRound,
  previousOffer,
  type OurCounter,
} from "./counteroffers.js";
import type { LedgerService } from "./ledger-service.js";
import { MoveSchema, type NegotiationService } from "./negotiation-service.js";
import { NegotiationDocSchema } from "./negotiation.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M37 — talking to suppliers under control.
 *
 *  - Recipients come only from CONTACTS a person registered. An agent never types an address.
 *  - Every outbound message is approved by a person before it can be sent, and everything is checked again at approval and at send.
 *  - A NEGOTIATION message carries a structured COUNTER move that must pass the M36 rules; the move's total is the only amount it may
 *    state. Text an agent writes is scanned for the budget, the limits, and other suppliers' names.
 *  - Sending runs with no transaction held. An accepted send is SENT, a certain failure is FAILED, and anything uncertain is
 *    DELIVERY_UNKNOWN, which a person resolves; PayFlow never retries it on its own.
 *  - What a supplier writes back is recorded as untrusted text.
 */
export type CommRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CONTACT_NOT_USABLE"
  | "RULES_REFUSE"
  | "LEAK_BLOCKED"
  | "ILLEGAL_MOVE"
  | "CHANNEL_UNAVAILABLE"
  | "MISSION_NOT_ACTIVE"
  | "NOT_THE_AUTHOR"
  | "MEMBER_ONLY";
export type CommResult<T> =
  { ok: true; value: T } | { ok: false; refusal: CommRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const ContactSchema = z
  .object({
    address: AddressSchema,
    basis: z.string().trim().min(1).max(300),
    idempotencyKey: Idem.optional(),
  })
  .strict();
export const DraftSchema = z
  .object({
    supplierId: z.string().regex(/^sup_[a-f0-9]{24}$/u),
    contactId: z.string().regex(/^cnt_[a-f0-9]{24}$/u),
    kind: z.enum(["INQUIRY", "NEGOTIATION", "NOTICE"]),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(150)
      .refine((s) => !/[\r\n]/u.test(s), "no line breaks in a subject"),
    body: z.string().trim().min(1).max(4000),
    negotiationId: z
      .string()
      .regex(/^ngt_[a-f0-9]{24}$/u)
      .optional(),
    // Only a counteroffer can be sent; accepting is a later, separately governed step.
    move: MoveSchema.optional().refine(
      (m) => m === undefined || m.kind === "COUNTER",
      "only a COUNTER can be sent",
    ),
    idempotencyKey: Idem,
  })
  .strict()
  .refine(
    (d) =>
      (d.kind === "NEGOTIATION") ===
      (d.move !== undefined && d.negotiationId !== undefined),
    {
      message:
        "a NEGOTIATION message needs a move and a negotiationId, and only it may have them",
    },
  );
const NoteSchema = z
  .object({ note: z.string().trim().max(300).default("") })
  .strict();
const SendSchema = z.object({ idempotencyKey: Idem.optional() }).strict();
const InboundSchema = z
  .object({
    supplierId: z.string().regex(/^sup_[a-f0-9]{24}$/u),
    contactId: z
      .string()
      .regex(/^cnt_[a-f0-9]{24}$/u)
      .optional(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(150)
      .refine((s) => !/[\r\n]/u.test(s)),
    body: z.string().trim().min(1).max(4000),
    idempotencyKey: Idem,
  })
  .strict();
const ResolveSchema = z
  .object({
    outcome: z.enum(["SENT", "FAILED"]),
    note: z.string().trim().min(1).max(300),
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

export interface MessageView {
  readonly messageId: string;
  readonly missionId: string;
  readonly supplierId: string;
  readonly contactId: string | null;
  readonly direction: "OUTBOUND" | "INBOUND";
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly move: unknown;
  readonly negotiationId: string | null;
  readonly status: MessageStatus;
  readonly author: string;
  readonly channelRef: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  /** Anything a supplier wrote is data, never an instruction. */
  readonly trust: "OURS" | "UNTRUSTED_SUPPLIER_TEXT";
}
const toMessage = (r: Row): MessageView => ({
  messageId: String(r.message_id),
  missionId: String(r.mission_id),
  supplierId: String(r.supplier_id),
  contactId: (r.contact_id as string | null) ?? null,
  direction: r.direction as MessageView["direction"],
  kind: String(r.kind),
  subject: String(r.subject),
  body: String(r.body),
  move: r.move,
  negotiationId: (r.negotiation_id as string | null) ?? null,
  status: r.status as MessageStatus,
  author: `${String(r.authored_by_kind).toLowerCase()}:${String(r.authored_by)}`,
  channelRef: (r.channel_ref as string | null) ?? null,
  createdAt: iso(r.created_at),
  sentAt: r.sent_at ? iso(r.sent_at) : null,
  trust: r.direction === "INBOUND" ? "UNTRUSTED_SUPPLIER_TEXT" : "OURS",
});

export class CommunicationService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      negotiations: NegotiationService;
      ledger: LedgerService;
      channels: ChannelRegistry;
      now: () => string;
      sendTimeoutMs?: number;
    },
  ) {}

  private reader(t: Tenant): MissionCaller {
    return {
      organizationId: t.organizationId,
      environment: t.environment,
      id: "communication",
      kind: "MEMBER",
    };
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
        subjectKind: "MISSION_MESSAGE",
        subjectId,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }
  private async event(
    tx: Sql,
    id: string,
    from: string | null,
    to: string,
    actor: { kind: string; id: string },
    detail: Record<string, unknown>,
    now: string,
  ) {
    await tx`insert into mission_message_events (message_id, from_status, to_status, actor_kind, actor_id, detail, occurred_at)
      values (${id}, ${from}, ${to}, ${actor.kind}, ${actor.id}, ${tx.json(detail as never)}, ${now})`;
  }
  private async messageOf(t: Tenant, id: string): Promise<Row | null> {
    if (!/^msg_[a-f0-9]{24}$/u.test(id)) return null;
    const [m] = await this.deps
      .sql`select g.* from mission_messages g join missions x on x.mission_id = g.mission_id
      where g.message_id = ${id} and x.organization_id = ${t.organizationId} and x.environment = ${t.environment}`;
    return m ?? null;
  }
  /**
   * The counters already on file for this negotiation that still count toward its rounds (not rejected, not failed), earlier than
   * `self` (or all of them when the message is not stored yet). Rounds are counted here, not declared by the sender.
   */
  private async earlierCounters(
    sql: Sql,
    negotiationId: string,
    self: { seq: number } | null,
  ): Promise<OurCounter[]> {
    const rows =
      await sql`select message_id, move, status, created_at, timeline_seq from mission_messages
      where negotiation_id = ${negotiationId} and kind = 'NEGOTIATION' and status in ('PENDING_APPROVAL','APPROVED','SENDING','SENT','DELIVERY_UNKNOWN')
      and (${self?.seq ?? null}::bigint is null or timeline_seq < ${self?.seq ?? null}::bigint)
      order by timeline_seq`;
    return rows.map((r, i) => ({
      messageId: String(r.message_id),
      round: i + 1,
      totalMinor: Number((r.move as { totalMinor: number }).totalMinor),
      status: r.status as OurCounter["status"],
      at: iso(r.created_at),
      seq: Number(r.timeline_seq),
    }));
  }
  private async roundProblem(
    sql: Sql,
    negotiationId: string,
    move: { round: number; totalMinor: number },
    self: { seq: number } | null,
  ): Promise<string | null> {
    const earlier = await this.earlierCounters(sql, negotiationId, self);
    const want = expectedRound(earlier.length);
    if (move.round !== want) return `ROUND_MISMATCH:expected ${want}`;
    const prev = previousOffer(earlier);
    if (prev !== null && move.totalMinor < prev)
      return `OFFER_BELOW_PREVIOUS_OFFER:${prev}`;
    return null;
  }
  /** What an agent must not reveal, as known right now. */
  private async secretsFor(
    t: Tenant,
    missionId: string,
    supplierId: string,
    move: { totalMinor?: number } | null,
  ): Promise<Secrets | null> {
    const m = await this.deps.missions.get(t, missionId);
    if (!m.ok) return null;
    const contract = m.value.activeContract ?? m.value.latestContract;
    const amounts = new Set<number>([
      contract.totalBudgetMinor,
      contract.maxCommitmentMinor,
    ]);
    if (contract.approvalConditions.humanApprovalAboveMinor)
      amounts.add(contract.approvalConditions.humanApprovalAboveMinor);
    const led = await this.deps.ledger.overview(this.reader(t), missionId);
    if (led.ok) {
      amounts.add(led.value.summary.availableMinor);
      amounts.add(led.value.summary.ceilingMinor);
    }
    const negs = await this.deps
      .sql`select v.document from mission_negotiation_versions v join mission_negotiations n on n.negotiation_id = v.negotiation_id where n.mission_id = ${missionId}`;
    for (const n of negs) {
      const d = NegotiationDocSchema.parse(n.document);
      amounts.add(d.walkAwayMinor);
      amounts.add(d.targetTotalMinor);
    }
    const others = await this.deps
      .sql`select external_ref, display_name from mission_suppliers where mission_id = ${missionId} and supplier_id <> ${supplierId}`;
    return {
      amountsMinor: [...amounts].filter((a) => a > 0),
      allowedMinor: move?.totalMinor ? [move.totalMinor] : [],
      names: others.flatMap((o) => [
        String(o.external_ref),
        String(o.display_name),
      ]),
    };
  }
  /** Everything that must hold for a message to move toward sending. Run at draft, at approval and at send. */
  private async preconditions(
    t: Tenant,
    row: {
      missionId: string;
      supplierId: string;
      contactId: string;
      kind: string;
      subject: string;
      body: string;
      move: unknown;
      negotiationId: string | null;
      authorKind: string;
    },
    guardAs: MissionCaller,
    self: { seq: number } | null = null,
  ): Promise<CommResult<true>> {
    const [mission] = await this.deps
      .sql`select status from missions where mission_id = ${row.missionId}`;
    if (!mission || mission.status !== "ACTIVE")
      return { ok: false, refusal: "MISSION_NOT_ACTIVE" };
    const [c] = await this.deps
      .sql`select status from mission_supplier_contacts where contact_id = ${row.contactId} and supplier_id = ${row.supplierId}`;
    if (!c) return { ok: false, refusal: "NOT_FOUND", detail: "CONTACT" };
    if (c.status !== "ACTIVE")
      return {
        ok: false,
        refusal: "CONTACT_NOT_USABLE",
        detail: String(c.status),
      };
    if (row.kind === "NEGOTIATION") {
      const [done] = await this.deps
        .sql`select 1 from mission_acceptances where negotiation_id = ${row.negotiationId} and status = 'ACCEPTED'`;
      if (done)
        return {
          ok: false,
          refusal: "RULES_REFUSE",
          detail: "NEGOTIATION_CONCLUDED",
        };
      const g = await this.deps.negotiations.check(
        guardAs,
        row.negotiationId!,
        row.move,
      );
      if (!g.ok)
        return { ok: false, refusal: "RULES_REFUSE", detail: g.refusal };
      if (g.value.verdict.verdict !== "ALLOW")
        return {
          ok: false,
          refusal: "RULES_REFUSE",
          detail: (g.value.verdict.verdict === "REFUSE"
            ? g.value.verdict.reasons
            : g.value.verdict.reasons
          ).join(","),
        };
    }
    if (row.authorKind === "AGENT") {
      const s = await this.secretsFor(
        t,
        row.missionId,
        row.supplierId,
        row.move as { totalMinor?: number } | null,
      );
      if (!s) return { ok: false, refusal: "NOT_FOUND" };
      const found = leakFindings(`${row.subject}\n${row.body}`, s);
      if (found.length)
        return { ok: false, refusal: "LEAK_BLOCKED", detail: found.join(",") };
    }
    if (row.kind === "NEGOTIATION") {
      // Rounds are counted here, not declared by the sender, and our offers never go backwards.
      const p = await this.roundProblem(
        this.deps.sql,
        row.negotiationId!,
        row.move as { round: number; totalMinor: number },
        self,
      );
      if (p) return { ok: false, refusal: "RULES_REFUSE", detail: p };
    }
    return { ok: true, value: true };
  }

  // ---------------------------------------------------------------------------------------------------- contacts
  async addContact(
    caller: MissionCaller,
    supplierId: string,
    rawBody: unknown,
  ): Promise<CommResult<{ contactId: string; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ContactSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const [s] = await this.deps
      .sql`select s.supplier_id from mission_suppliers s join missions m on m.mission_id = s.mission_id
      where s.supplier_id = ${supplierId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!s) return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    const id = `cnt_${randomBytes(12).toString("hex")}`;
    const [made] = await this.deps
      .sql`insert into mission_supplier_contacts (contact_id, supplier_id, channel, address, basis, added_by, added_at)
      values (${id}, ${supplierId}, 'EMAIL', ${b.data.address}, ${b.data.basis}, ${caller.id}, ${now}) on conflict do nothing returning contact_id`;
    if (made) {
      await this.log(caller, "SUPPLIER_CONTACT_ADDED", id, {}, now);
      return { ok: true, value: { contactId: id, replayed: false } };
    }
    const [existing] = await this.deps
      .sql`select contact_id from mission_supplier_contacts where supplier_id = ${supplierId} and channel = 'EMAIL' and lower(address) = lower(${b.data.address})`;
    return {
      ok: true,
      value: { contactId: String(existing!.contact_id), replayed: true },
    };
  }
  async setContactStatus(
    caller: MissionCaller,
    contactId: string,
    status: "ACTIVE" | "DO_NOT_CONTACT",
  ): Promise<CommResult<{ contactId: string; status: string }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    if (!/^cnt_[a-f0-9]{24}$/u.test(contactId))
      return { ok: false, refusal: "NOT_FOUND" };
    const now = this.deps.now();
    const [u] = await this.deps
      .sql`update mission_supplier_contacts c set status = ${status}, status_by = ${caller.id}, status_at = ${now}
      from mission_suppliers s, missions m where c.contact_id = ${contactId} and s.supplier_id = c.supplier_id and m.mission_id = s.mission_id
      and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment} returning c.contact_id`;
    if (!u) return { ok: false, refusal: "NOT_FOUND" };
    await this.log(
      caller,
      status === "DO_NOT_CONTACT"
        ? "SUPPLIER_CONTACT_BLOCKED"
        : "SUPPLIER_CONTACT_RESTORED",
      contactId,
      {},
      now,
    );
    return { ok: true, value: { contactId, status } };
  }
  async contacts(caller: MissionCaller, missionId: string) {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return null;
    const rows = await this.deps
      .sql`select c.* from mission_supplier_contacts c join mission_suppliers s on s.supplier_id = c.supplier_id where s.mission_id = ${missionId} order by c.added_at, c.contact_id`;
    return rows.map((r) => ({
      contactId: String(r.contact_id),
      supplierId: String(r.supplier_id),
      channel: String(r.channel),
      address: String(r.address),
      basis: String(r.basis),
      status: String(r.status),
      addedBy: String(r.added_by),
    }));
  }

  // ---------------------------------------------------------------------------------------------------- draft
  async draft(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<CommResult<{ message: MessageView; replayed: boolean }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const b = DraftSchema.safeParse(rawBody);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") || i.message)
          .join(","),
      };
    const d = b.data;
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        d.kind === "NEGOTIATION" ? "NEGOTIATE" : "DRAFT",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const [sup] = await this.deps
      .sql`select supplier_id from mission_suppliers where supplier_id = ${d.supplierId} and mission_id = ${missionId}`;
    if (!sup) return { ok: false, refusal: "NOT_FOUND", detail: "SUPPLIER" };
    const [neg] = d.negotiationId
      ? await this.deps
          .sql`select supplier_id from mission_negotiations where negotiation_id = ${d.negotiationId} and mission_id = ${missionId}`
      : [undefined];
    if (d.negotiationId && (!neg || neg.supplier_id !== d.supplierId))
      return { ok: false, refusal: "NOT_FOUND", detail: "NEGOTIATION" };
    const pre = await this.preconditions(
      caller,
      {
        missionId,
        supplierId: d.supplierId,
        contactId: d.contactId,
        kind: d.kind,
        subject: d.subject,
        body: d.body,
        move: d.move ?? null,
        negotiationId: d.negotiationId ?? null,
        authorKind: caller.kind,
      },
      caller,
    );
    if (!pre.ok) return pre;
    const digest = sha({ missionId, ...d, idempotencyKey: undefined });
    const now = this.deps.now();
    const id = `msg_${randomBytes(12).toString("hex")}`;
    const out = await this.deps.sql.begin(
      async (tx): Promise<CommResult<{ row: Row; replayed: boolean }>> => {
        const [prior] =
          await tx`select * from mission_messages where mission_id = ${missionId} and authored_by = ${caller.id} and idempotency_key = ${d.idempotencyKey}`;
        if (prior)
          return prior.request_digest === digest
            ? { ok: true, value: { row: prior, replayed: true } }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        if (d.kind === "NEGOTIATION") {
          // Two drafts at once must not both take the same round: count again under a lock for this negotiation.
          await tx`select pg_advisory_xact_lock(hashtext(${"round|" + d.negotiationId!}))`;
          const p = await this.roundProblem(
            tx,
            d.negotiationId!,
            d.move!,
            null,
          );
          if (p) return { ok: false, refusal: "RULES_REFUSE", detail: p };
        }
        const [row] =
          await tx`insert into mission_messages (message_id, mission_id, supplier_id, contact_id, direction, kind, subject, body, move, negotiation_id, status,
          authored_by_kind, authored_by, idempotency_key, request_digest, created_at)
        values (${id}, ${missionId}, ${d.supplierId}, ${d.contactId}, 'OUTBOUND', ${d.kind}, ${d.subject}, ${d.body}, ${d.move ? tx.json(d.move) : null}, ${d.negotiationId ?? null},
          'PENDING_APPROVAL', ${caller.kind}, ${caller.id}, ${d.idempotencyKey}, ${digest}, ${now}) returning *`;
        await this.event(tx, id, null, "PENDING_APPROVAL", caller, {}, now);
        return { ok: true, value: { row: row!, replayed: false } };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(caller, "MESSAGE_DRAFTED", id, { kind: d.kind }, now);
    return {
      ok: true,
      value: {
        message: toMessage(out.value.row),
        replayed: out.value.replayed,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------- decide
  private async move(
    id: string,
    from: MessageStatus[],
    to: MessageStatus,
    actor: { kind: string; id: string },
    detail: Record<string, unknown>,
    extra: { channelRef?: string; sentAt?: string } = {},
  ): Promise<Row | null> {
    for (const f of from)
      if (!canMove(f, to)) throw new Error("ILLEGAL_TRANSITION_REQUESTED");
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      const [cur] =
        await tx`select status from mission_messages where message_id = ${id} for update`;
      if (!cur || !from.includes(cur.status as MessageStatus)) return null;
      const [u] =
        await tx`update mission_messages set status = ${to}, row_version = row_version + 1,
          channel_ref = coalesce(${extra.channelRef ?? null}, channel_ref), sent_at = coalesce(${extra.sentAt ?? null}::timestamptz, sent_at)
        where message_id = ${id} returning *`;
      await this.event(tx, id, String(cur.status), to, actor, detail, now);
      return u ?? null;
    });
  }
  async decide(
    caller: MissionCaller,
    messageId: string,
    decision: "APPROVED" | "REJECTED",
    rawBody: unknown,
  ): Promise<CommResult<{ messageId: string; status: string }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = NoteSchema.safeParse(rawBody ?? {});
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const row = await this.messageOf(caller, messageId);
    if (!row || row.direction !== "OUTBOUND")
      return { ok: false, refusal: "NOT_FOUND" };
    const status = row.status as MessageStatus;
    if (!canMove(status, decision))
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: `${status}->${decision}`,
      };
    if (decision === "APPROVED") {
      const pre = await this.preconditions(
        caller,
        {
          missionId: String(row.mission_id),
          supplierId: String(row.supplier_id),
          contactId: String(row.contact_id),
          kind: String(row.kind),
          subject: String(row.subject),
          body: String(row.body),
          move: row.move,
          negotiationId: (row.negotiation_id as string | null) ?? null,
          authorKind: String(row.authored_by_kind),
        },
        this.reader(caller),
        { seq: Number(row.timeline_seq) },
      );
      if (!pre.ok) return pre;
    }
    const u = await this.move(messageId, [status], decision, caller, {
      note: b.data.note,
    });
    if (!u)
      return { ok: false, refusal: "ILLEGAL_MOVE", detail: "STATE_CHANGED" };
    await this.log(
      caller,
      decision === "APPROVED" ? "MESSAGE_APPROVED" : "MESSAGE_REJECTED",
      messageId,
      {},
      this.deps.now(),
    );
    return { ok: true, value: { messageId, status: decision } };
  }

  // ---------------------------------------------------------------------------------------------------- send
  async send(
    caller: MissionCaller,
    messageId: string,
    rawBody: unknown,
  ): Promise<
    CommResult<{
      messageId: string;
      status: string;
      channelRef: string | null;
      note: string;
    }>
  > {
    if (!SendSchema.safeParse(rawBody ?? {}).success)
      return { ok: false, refusal: "MALFORMED" };
    const row = await this.messageOf(caller, messageId);
    if (!row || row.direction !== "OUTBOUND")
      return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(row.mission_id);
    if (caller.kind === "AGENT") {
      if (row.authored_by !== caller.id)
        return { ok: false, refusal: "NOT_THE_AUTHOR" };
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "COMMUNICATE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    if (
      row.status === "SENT" ||
      row.status === "DELIVERY_UNKNOWN" ||
      row.status === "SENDING"
    )
      return {
        ok: true,
        value: {
          messageId,
          status: String(row.status),
          channelRef: (row.channel_ref as string | null) ?? null,
          note: "ALREADY_SENT_OR_IN_FLIGHT",
        },
      };
    if (row.status !== "APPROVED")
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: `${String(row.status)}->SENDING`,
      };
    const [contact] = await this.deps
      .sql`select address from mission_supplier_contacts where contact_id = ${String(row.contact_id)}`;
    const adapter = this.deps.channels.for("EMAIL");
    if (
      !adapter ||
      (adapter.mode === "SANDBOX" && caller.environment === "PRODUCTION")
    )
      return {
        ok: false,
        refusal: "CHANNEL_UNAVAILABLE",
        detail: adapter ? "SANDBOX_CHANNEL_IN_PRODUCTION" : "NO_CHANNEL",
      };
    // Re-check the world at the moment of sending.
    const pre = await this.preconditions(
      caller,
      {
        missionId,
        supplierId: String(row.supplier_id),
        contactId: String(row.contact_id),
        kind: String(row.kind),
        subject: String(row.subject),
        body: String(row.body),
        move: row.move,
        negotiationId: (row.negotiation_id as string | null) ?? null,
        authorKind: String(row.authored_by_kind),
      },
      this.reader(caller),
      { seq: Number(row.timeline_seq) },
    );
    if (!pre.ok) return pre;
    const claimed = await this.move(
      messageId,
      ["APPROVED"],
      "SENDING",
      caller,
      {},
    );
    if (!claimed) {
      const [now] = await this.deps
        .sql`select status, channel_ref from mission_messages where message_id = ${messageId}`;
      return {
        ok: true,
        value: {
          messageId,
          status: String(now!.status),
          channelRef: (now!.channel_ref as string | null) ?? null,
          note: "ALREADY_SENT_OR_IN_FLIGHT",
        },
      };
    }
    // The channel runs with no transaction held, under a hard timeout. Uncertainty is never turned into success or failure.
    let outcome: "SENT" | "FAILED" | "DELIVERY_UNKNOWN" = "SENT";
    let ref: string | null = null;
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const sent = await Promise.race([
        adapter.send(
          {
            to: String(contact!.address),
            subject: String(row.subject),
            body: String(row.body),
            idempotencyKey: messageId,
          },
          ac.signal,
        ),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            ac.abort();
            rej(new Error("TIMEOUT"));
          }, this.deps.sendTimeoutMs ?? 5000);
        }),
      ]);
      ref = sent.ref;
    } catch (e) {
      outcome =
        e instanceof DefinitiveSendError ? "FAILED" : "DELIVERY_UNKNOWN";
    } finally {
      if (timer) clearTimeout(timer);
    }
    const now = this.deps.now();
    const done = await this.move(
      messageId,
      ["SENDING"],
      outcome,
      { kind: "SYSTEM", id: adapter.id },
      { channel: adapter.id },
      outcome === "SENT" ? { channelRef: ref!, sentAt: now } : {},
    );
    await this.log(
      caller,
      "MESSAGE_SEND_ATTEMPTED",
      messageId,
      { outcome },
      now,
    );
    return {
      ok: true,
      value: {
        messageId,
        status: (done?.status as string | undefined) ?? outcome,
        channelRef: ref,
        note:
          outcome === "DELIVERY_UNKNOWN"
            ? "DELIVERY_COULD_NOT_BE_CONFIRMED: a person must check and resolve it; it is never retried automatically"
            : "",
      },
    };
  }

  /** A person who has checked with the supplier or the provider settles a message whose delivery was unknown. */
  async resolve(
    caller: MissionCaller,
    messageId: string,
    rawBody: unknown,
  ): Promise<CommResult<{ messageId: string; status: string }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const b = ResolveSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const row = await this.messageOf(caller, messageId);
    if (!row) return { ok: false, refusal: "NOT_FOUND" };
    if (row.status !== "DELIVERY_UNKNOWN")
      return {
        ok: false,
        refusal: "ILLEGAL_MOVE",
        detail: `${String(row.status)}->${b.data.outcome}`,
      };
    const u = await this.move(
      messageId,
      ["DELIVERY_UNKNOWN"],
      b.data.outcome,
      caller,
      { note: b.data.note },
      b.data.outcome === "SENT" ? { sentAt: this.deps.now() } : {},
    );
    if (!u)
      return { ok: false, refusal: "ILLEGAL_MOVE", detail: "STATE_CHANGED" };
    await this.log(
      caller,
      "MESSAGE_DELIVERY_RESOLVED",
      messageId,
      { outcome: b.data.outcome },
      this.deps.now(),
    );
    return { ok: true, value: { messageId, status: b.data.outcome } };
  }

  // ---------------------------------------------------------------------------------------------------- inbound & read
  async recordInbound(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<CommResult<{ message: MessageView; replayed: boolean }>> {
    if (caller.kind !== "MEMBER") return { ok: false, refusal: "MEMBER_ONLY" };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    const b = InboundSchema.safeParse(rawBody);
    if (!b.success) return { ok: false, refusal: "MALFORMED" };
    const [sup] = await this.deps
      .sql`select supplier_id from mission_suppliers where supplier_id = ${b.data.supplierId} and mission_id = ${missionId}`;
    if (!sup) return { ok: false, refusal: "NOT_FOUND", detail: "SUPPLIER" };
    const digest = sha({ missionId, ...b.data, idempotencyKey: undefined });
    const now = this.deps.now();
    const id = `msg_${randomBytes(12).toString("hex")}`;
    const out = await this.deps.sql.begin(
      async (tx): Promise<CommResult<{ row: Row; replayed: boolean }>> => {
        const [prior] =
          await tx`select * from mission_messages where mission_id = ${missionId} and authored_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
        if (prior)
          return prior.request_digest === digest
            ? { ok: true, value: { row: prior, replayed: true } }
            : { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
        const [row] =
          await tx`insert into mission_messages (message_id, mission_id, supplier_id, contact_id, direction, kind, subject, body, status, authored_by_kind, authored_by, idempotency_key, request_digest, created_at)
        values (${id}, ${missionId}, ${b.data.supplierId}, ${b.data.contactId ?? null}, 'INBOUND', 'REPLY', ${b.data.subject}, ${b.data.body}, 'RECEIVED', 'MEMBER', ${caller.id}, ${b.data.idempotencyKey}, ${digest}, ${now}) returning *`;
        await this.event(
          tx,
          id,
          null,
          "RECEIVED",
          caller,
          { recordedByAPerson: true },
          now,
        );
        return { ok: true, value: { row: row!, replayed: false } };
      },
    );
    if (!out.ok) return out;
    if (!out.value.replayed)
      await this.log(caller, "MESSAGE_RECEIVED_RECORDED", id, {}, now);
    return {
      ok: true,
      value: {
        message: toMessage(out.value.row),
        replayed: out.value.replayed,
      },
    };
  }

  async list(
    caller: MissionCaller,
    missionId: string,
    filter: { supplierId?: string } = {},
  ): Promise<CommResult<{ messages: MessageView[] }>> {
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
    const rows = await this.deps
      .sql`select * from mission_messages where mission_id = ${missionId} and (${filter.supplierId ?? null}::text is null or supplier_id = ${filter.supplierId ?? null}) order by created_at, message_id`;
    return { ok: true, value: { messages: rows.map(toMessage) } };
  }
  async events(caller: MissionCaller, messageId: string) {
    const row = await this.messageOf(caller, messageId);
    if (!row) return null;
    const rows = await this.deps
      .sql`select seq, from_status, to_status, actor_kind, actor_id, detail, occurred_at from mission_message_events where message_id = ${messageId} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      from: (r.from_status as string | null) ?? null,
      to: String(r.to_status),
      by: `${String(r.actor_kind).toLowerCase()}:${String(r.actor_id)}`,
      detail: r.detail as unknown,
      at: iso(r.occurred_at),
    }));
  }
}
