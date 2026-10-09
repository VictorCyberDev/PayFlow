import postgres, { type Sql } from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentPassportSchema,
  DecisionReceiptSchema,
  MandateSchema,
  TransactionProposalSchema,
  type AgentPassport,
  type DecisionReceipt,
  type Mandate,
  type Principal,
  type TransactionProposal,
} from "./domain.js";
import { mandateFingerprint } from "./canonical.js";

export const ReservationStatusSchema = z.enum([
  "PENDING",
  "AUTHORIZED",
  "EXECUTING",
  "COMMITTED",
  "RELEASED",
  "EXPIRED",
  "FAILED",
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;
const transitions: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  PENDING: ["AUTHORIZED", "RELEASED", "EXPIRED", "FAILED"],
  AUTHORIZED: ["EXECUTING", "RELEASED", "EXPIRED", "FAILED"],
  EXECUTING: ["COMMITTED", "RELEASED", "FAILED"],
  COMMITTED: [],
  RELEASED: [],
  EXPIRED: [],
  FAILED: [],
};
export function canTransitionReservation(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return transitions[from].includes(to);
}

export const ReservationSchema = z
  .object({
    id: z.string().min(1),
    mandateId: z.string().min(1),
    proposalId: z.string().min(1),
    receiptId: z.string().min(1),
    amountMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: ReservationStatusSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type Reservation = Readonly<z.infer<typeof ReservationSchema>>;
export const DurableApprovalSchema = z
  .object({
    id: z.string().min(1),
    receiptId: z.string().min(1),
    proposalId: z.string().min(1),
    principalId: z.string().min(1),
    status: z.enum(["APPROVED", "REVOKED", "EXPIRED"]),
    approvedAt: z.string().datetime(),
  })
  .strict();
export type DurableApproval = Readonly<z.infer<typeof DurableApprovalSchema>>;
export interface DurableEvidence {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
  readonly previousHash: string | null;
  readonly hash: string;
}
export interface AuthorityAccounting {
  readonly committedMinor: number;
  readonly activeReservedMinor: number;
  readonly consumedMinor: number;
  readonly availableMinor: number | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function evidenceHash(unsigned: Omit<DurableEvidence, "hash">): string {
  return createHash("sha256").update(canonical(unsigned)).digest("hex");
}
function asNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("MALFORMED_PERSISTED_MONEY");
  return n;
}
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object")
    throw new Error("MALFORMED_PERSISTED_ROW");
  return value as Record<string, unknown>;
}

export class PostgresTrustRepository {
  constructor(readonly sql: Sql) {}
  static connect(url: string): PostgresTrustRepository {
    return new PostgresTrustRepository(postgres(url, { max: 10 }));
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
  async migrate(sqlText: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
    });
  }
  async savePrincipal(p: Principal): Promise<void> {
    await this
      .sql`insert into principals(id,display_name) values(${p.id},${p.displayName}) on conflict(id) do update set display_name=excluded.display_name`;
  }
  async saveAgent(a: AgentPassport): Promise<void> {
    const v = AgentPassportSchema.parse(a);
    await this
      .sql`insert into agent_passports(id,principal_id,display_name,issued_at,expires_at,status,capabilities) values(${v.id},${v.principalId},${v.displayName},${v.issuedAt},${v.expiresAt},${v.status},${this.sql.json(v.capabilities)})`;
  }
  async getAgent(
    id: string,
    db: Sql = this.sql,
  ): Promise<AgentPassport | null> {
    const rows = await db`select * from agent_passports where id=${id}`;
    if (!rows[0]) return null;
    const r = row(rows[0]);
    return AgentPassportSchema.parse({
      id: r.id,
      principalId: r.principal_id,
      displayName: r.display_name,
      issuedAt: new Date(String(r.issued_at)).toISOString(),
      expiresAt: new Date(String(r.expires_at)).toISOString(),
      status: r.status,
      capabilities: r.capabilities,
    });
  }
  async saveMandate(m: Mandate): Promise<void> {
    const v = MandateSchema.parse(m);
    await this
      .sql`insert into mandates(id,principal_id,authorized_agent_id,fingerprint,document,nonce,cumulative_limit_minor,created_at,expires_at) values(${v.id},${v.principalId},${v.authorizedAgentId},${mandateFingerprint(v)},${this.sql.json(v)},${v.nonce},${v.cumulativeLimitMinor ?? null},${v.createdAt},${v.expiresAt})`;
  }
  async getMandate(
    id: string,
    db: Sql = this.sql,
    lock = false,
  ): Promise<Mandate | null> {
    const rows = lock
      ? await db`select document,fingerprint from mandates where id=${id} for update`
      : await db`select document,fingerprint from mandates where id=${id}`;
    if (!rows[0]) return null;
    const r = row(rows[0]);
    const m = MandateSchema.parse(r.document);
    if (mandateFingerprint(m) !== r.fingerprint)
      throw new Error("MALFORMED_PERSISTED_MANDATE");
    return m;
  }
  async saveProposal(p: TransactionProposal): Promise<void> {
    const v = TransactionProposalSchema.parse(p);
    await this
      .sql`insert into transaction_proposals(id,mandate_id,agent_id,nonce,amount_minor,currency,document,proposed_at) values(${v.id},${v.mandateId},${v.agentId},${v.nonce},${v.amount.minor},${v.amount.currency},${this.sql.json(v)},${v.proposedAt})`;
  }
  async getProposal(
    id: string,
    db: Sql = this.sql,
  ): Promise<TransactionProposal | null> {
    const rows =
      await db`select document,amount_minor,currency from transaction_proposals where id=${id}`;
    if (!rows[0]) return null;
    const r = row(rows[0]);
    const p = TransactionProposalSchema.parse(r.document);
    if (
      p.amount.minor !== asNumber(r.amount_minor) ||
      p.amount.currency !== r.currency
    )
      throw new Error("MALFORMED_PERSISTED_PROPOSAL");
    return p;
  }
  async claimReplay(
    scope: string,
    key: string,
    db: Sql = this.sql,
  ): Promise<boolean> {
    const r =
      await db`insert into replay_keys(scope,replay_key) values(${scope},${key}) on conflict do nothing returning replay_key`;
    return r.length === 1;
  }
  async saveReceipt(r: DecisionReceipt, db: Sql = this.sql): Promise<void> {
    const v = DecisionReceiptSchema.parse(r);
    await db`insert into decision_receipts(id,proposal_id,mandate_id,agent_id,decision,document,evaluated_at) values(${v.receiptId},${v.proposalId},${v.mandateId},${v.agentId},${v.decision},${db.json(v)},${v.evaluatedAt})`;
  }
  async getReceipt(
    id: string,
    db: Sql = this.sql,
  ): Promise<DecisionReceipt | null> {
    const rows =
      await db`select document from decision_receipts where id=${id}`;
    if (!rows[0]) return null;
    return DecisionReceiptSchema.parse(row(rows[0]).document);
  }
  async saveApproval(a: DurableApproval, db: Sql = this.sql): Promise<void> {
    const v = DurableApprovalSchema.parse(a);
    const rows =
      await db`select m.principal_id,d.proposal_id from decision_receipts d join mandates m on m.id=d.mandate_id where d.id=${v.receiptId}`;
    if (
      !rows[0] ||
      row(rows[0]).principal_id !== v.principalId ||
      row(rows[0]).proposal_id !== v.proposalId
    )
      throw new Error("APPROVAL_BINDING_MISMATCH");
    await db`insert into approvals(id,receipt_id,proposal_id,principal_id,status,approved_at) values(${v.id},${v.receiptId},${v.proposalId},${v.principalId},${v.status},${v.approvedAt})`;
  }
  async getApprovalByReceipt(
    receiptId: string,
    db: Sql = this.sql,
  ): Promise<DurableApproval | null> {
    const rows =
      await db`select id,receipt_id,proposal_id,principal_id,status,approved_at from approvals where receipt_id=${receiptId}`;
    if (!rows[0]) return null;
    const r = row(rows[0]);
    return DurableApprovalSchema.parse({
      id: r.id,
      receiptId: r.receipt_id,
      proposalId: r.proposal_id,
      principalId: r.principal_id,
      status: r.status,
      approvedAt: new Date(String(r.approved_at)).toISOString(),
    });
  }
  async createReservation(r: Reservation, db: Sql = this.sql): Promise<void> {
    const v = ReservationSchema.parse(r);
    await db`insert into authorization_reservations(id,mandate_id,proposal_id,receipt_id,amount_minor,currency,status,expires_at) values(${v.id},${v.mandateId},${v.proposalId},${v.receiptId},${v.amountMinor},${v.currency},${v.status},${v.expiresAt})`;
  }
  async getReservationByProposal(
    proposalId: string,
    db: Sql = this.sql,
  ): Promise<Reservation | null> {
    const rows =
      await db`select id,mandate_id,proposal_id,receipt_id,amount_minor,currency,status,expires_at from authorization_reservations where proposal_id=${proposalId}`;
    if (!rows[0]) return null;
    const r = row(rows[0]);
    return ReservationSchema.parse({
      id: r.id,
      mandateId: r.mandate_id,
      proposalId: r.proposal_id,
      receiptId: r.receipt_id,
      amountMinor: asNumber(r.amount_minor),
      currency: r.currency,
      status: r.status,
      expiresAt: new Date(String(r.expires_at)).toISOString(),
    });
  }
  async authorityAccounting(
    mandateId: string,
    cumulativeLimitMinor: number | undefined,
    db: Sql = this.sql,
  ): Promise<AuthorityAccounting> {
    const rows =
      await db`select coalesce(sum(amount_minor) filter (where status='COMMITTED'),0) committed, coalesce(sum(amount_minor) filter (where status in ('AUTHORIZED','EXECUTING')),0) reserved from authorization_reservations where mandate_id=${mandateId}`;
    const r = row(rows[0]);
    const committedMinor = asNumber(r.committed);
    const activeReservedMinor = asNumber(r.reserved);
    const consumedMinor = committedMinor + activeReservedMinor;
    return Object.freeze({
      committedMinor,
      activeReservedMinor,
      consumedMinor,
      availableMinor:
        cumulativeLimitMinor === undefined
          ? null
          : Math.max(0, cumulativeLimitMinor - consumedMinor),
    });
  }
  async transitionReservation(
    id: string,
    to: ReservationStatus,
  ): Promise<void> {
    ReservationStatusSchema.parse(to);
    await this.sql.begin(async (tx) => {
      const rows =
        await tx`select status from authorization_reservations where id=${id} for update`;
      if (!rows[0]) throw new Error("RESERVATION_NOT_FOUND");
      const from = ReservationStatusSchema.parse(row(rows[0]).status);
      if (!canTransitionReservation(from, to))
        throw new Error("INVALID_RESERVATION_TRANSITION");
      await tx`update authorization_reservations set status=${to},updated_at=now() where id=${id}`;
    });
  }
  async expireStaleReservations(now: string): Promise<number> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_EXPIRY_TIME");
    const rows = await this
      .sql`update authorization_reservations set status='EXPIRED',updated_at=${now} where status in ('PENDING','AUTHORIZED') and expires_at<=${now} returning id`;
    return rows.length;
  }
  async appendEvidence(
    type: string,
    data: DurableEvidence["data"],
    occurredAt: string,
  ): Promise<DurableEvidence> {
    return this.sql.begin((tx) =>
      this.appendEvidenceInTransaction(tx, type, data, occurredAt),
    );
  }
  async appendEvidenceInTransaction(
    db: Sql,
    type: string,
    data: DurableEvidence["data"],
    occurredAt: string,
  ): Promise<DurableEvidence> {
    await db`select pg_advisory_xact_lock(731991)`;
    const rows =
      await db`select sequence,hash from evidence_events order by sequence desc limit 1`;
    const last = rows[0] ? row(rows[0]) : null;
    const sequence = last ? asNumber(last.sequence) + 1 : 1;
    const unsigned = {
      id: randomUUID(),
      sequence,
      type,
      occurredAt,
      data: Object.freeze({ ...data }),
      previousHash: last ? String(last.hash) : null,
    };
    const hash = evidenceHash(unsigned);
    await db`insert into evidence_events(id,type,occurred_at,data,previous_hash,hash) values(${unsigned.id},${type},${occurredAt},${db.json(data)},${unsigned.previousHash},${hash})`;
    return Object.freeze({ ...unsigned, hash });
  }
  async evidence(): Promise<readonly DurableEvidence[]> {
    const rows = await this
      .sql`select sequence,id,type,occurred_at,data,previous_hash,hash from evidence_events order by sequence`;
    return rows.map((value) => {
      const r = row(value);
      const data = z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()]),
        )
        .parse(r.data);
      return Object.freeze({
        sequence: asNumber(r.sequence),
        id: z.string().min(1).parse(r.id),
        type: z.string().min(1).parse(r.type),
        occurredAt: z
          .string()
          .datetime()
          .parse(new Date(String(r.occurred_at)).toISOString()),
        data,
        previousHash:
          r.previous_hash === null
            ? null
            : z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(r.previous_hash),
        hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(r.hash),
      });
    });
  }
  static verifyEvidence(entries: readonly DurableEvidence[]): boolean {
    let previous: string | null = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || e.sequence !== i + 1 || e.previousHash !== previous)
        return false;
      const { hash, ...unsigned } = e;
      if (evidenceHash(unsigned) !== hash) return false;
      previous = hash;
    }
    return true;
  }
}
