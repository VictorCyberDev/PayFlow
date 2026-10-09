import postgres, { type Sql } from "postgres";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentPassportSchema,
  MandateSchema,
  TransactionProposalSchema,
  type AgentPassport,
  type DecisionReceipt,
  type Mandate,
  type Principal,
  type TransactionProposal,
} from "./domain.js";
import { mandateFingerprint } from "./canonical.js";

export type ReservationStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "EXECUTING"
  | "COMMITTED"
  | "RELEASED"
  | "EXPIRED"
  | "FAILED";
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

export interface Reservation {
  id: string;
  mandateId: string;
  proposalId: string;
  receiptId: string;
  amountMinor: number;
  currency: string;
  status: ReservationStatus;
  expiresAt: string;
}
export interface DurableApproval {
  id: string;
  receiptId: string;
  proposalId: string;
  principalId: string;
  status: "APPROVED" | "REVOKED" | "EXPIRED";
  approvedAt: string;
}
export interface DurableEvidence {
  id: string;
  sequence: number;
  type: string;
  occurredAt: string;
  data: Readonly<Record<string, string | number | boolean | null>>;
  previousHash: string | null;
  hash: string;
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

export class PostgresTrustRepository {
  constructor(readonly sql: Sql) {}
  static connect(url: string): PostgresTrustRepository {
    return new PostgresTrustRepository(postgres(url, { max: 10 }));
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
  async migrate(sqlText: string): Promise<void> {
    await this.sql.unsafe(sqlText);
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
  async getAgent(id: string): Promise<AgentPassport | null> {
    const r = await this.sql`select * from agent_passports where id=${id}`;
    if (!r[0]) return null;
    return AgentPassportSchema.parse({
      id: r[0].id,
      principalId: r[0].principal_id,
      displayName: r[0].display_name,
      issuedAt: new Date(r[0].issued_at as string).toISOString(),
      expiresAt: new Date(r[0].expires_at as string).toISOString(),
      status: r[0].status,
      capabilities: r[0].capabilities,
    });
  }
  async saveMandate(m: Mandate): Promise<void> {
    const v = MandateSchema.parse(m);
    await this
      .sql`insert into mandates(id,principal_id,authorized_agent_id,fingerprint,document,nonce,cumulative_limit_minor,created_at,expires_at) values(${v.id},${v.principalId},${v.authorizedAgentId},${mandateFingerprint(v)},${this.sql.json(v)},${v.nonce},${v.cumulativeLimitMinor ?? null},${v.createdAt},${v.expiresAt})`;
  }
  async getMandate(id: string): Promise<Mandate | null> {
    const r = await this
      .sql`select document,fingerprint from mandates where id=${id}`;
    if (!r[0]) return null;
    const m = MandateSchema.parse(r[0].document);
    if (mandateFingerprint(m) !== r[0].fingerprint)
      throw new Error("MALFORMED_PERSISTED_MANDATE");
    return m;
  }
  async saveProposal(p: TransactionProposal): Promise<void> {
    const v = TransactionProposalSchema.parse(p);
    await this
      .sql`insert into transaction_proposals(id,mandate_id,agent_id,nonce,amount_minor,currency,document,proposed_at) values(${v.id},${v.mandateId},${v.agentId},${v.nonce},${v.amount.minor},${v.amount.currency},${this.sql.json(v)},${v.proposedAt})`;
  }
  async getProposal(id: string): Promise<TransactionProposal | null> {
    const r = await this
      .sql`select document,amount_minor,currency from transaction_proposals where id=${id}`;
    if (!r[0]) return null;
    const p = TransactionProposalSchema.parse(r[0].document);
    if (
      p.amount.minor !== asNumber(r[0].amount_minor) ||
      p.amount.currency !== r[0].currency
    )
      throw new Error("MALFORMED_PERSISTED_PROPOSAL");
    return p;
  }
  async claimReplay(scope: string, key: string): Promise<boolean> {
    const r = await this
      .sql`insert into replay_keys(scope,replay_key) values(${scope},${key}) on conflict do nothing returning replay_key`;
    return r.length === 1;
  }
  async saveReceipt(r: DecisionReceipt): Promise<void> {
    await this
      .sql`insert into decision_receipts(id,proposal_id,mandate_id,agent_id,decision,document,evaluated_at) values(${r.receiptId},${r.proposalId},${r.mandateId},${r.agentId},${r.decision},${this.sql.json(r)},${r.evaluatedAt})`;
  }
  async getReceipt(id: string): Promise<DecisionReceipt | null> {
    const r = await this
      .sql`select document from decision_receipts where id=${id}`;
    return (r[0]?.document as DecisionReceipt | undefined) ?? null;
  }
  async saveApproval(a: DurableApproval): Promise<void> {
    const receipt = await this
      .sql`select m.principal_id from decision_receipts d join mandates m on m.id=d.mandate_id where d.id=${a.receiptId}`;
    if (!receipt[0] || receipt[0].principal_id !== a.principalId)
      throw new Error("APPROVAL_PRINCIPAL_MISMATCH");
    await this
      .sql`insert into approvals(id,receipt_id,proposal_id,principal_id,status,approved_at) values(${a.id},${a.receiptId},${a.proposalId},${a.principalId},${a.status},${a.approvedAt})`;
  }
  async createReservation(r: Reservation): Promise<void> {
    await this
      .sql`insert into authorization_reservations(id,mandate_id,proposal_id,receipt_id,amount_minor,currency,status,expires_at) values(${r.id},${r.mandateId},${r.proposalId},${r.receiptId},${r.amountMinor},${r.currency},${r.status},${r.expiresAt})`;
  }
  async transitionReservation(
    id: string,
    to: ReservationStatus,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows =
        await tx`select status from authorization_reservations where id=${id} for update`;
      if (!rows[0]) throw new Error("RESERVATION_NOT_FOUND");
      const from = rows[0].status as ReservationStatus;
      if (!canTransitionReservation(from, to))
        throw new Error("INVALID_RESERVATION_TRANSITION");
      await tx`update authorization_reservations set status=${to},updated_at=now() where id=${id}`;
    });
  }
  async appendEvidence(
    type: string,
    data: DurableEvidence["data"],
    occurredAt: string,
  ): Promise<DurableEvidence> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(731991)`;
      const last =
        await tx`select sequence,hash from evidence_events order by sequence desc limit 1`;
      const sequence = last[0] ? asNumber(last[0].sequence) + 1 : 1;
      const unsigned = {
        id: randomUUID(),
        sequence,
        type,
        occurredAt,
        data: Object.freeze({ ...data }),
        previousHash: (last[0]?.hash as string | undefined) ?? null,
      };
      const hash = evidenceHash(unsigned);
      await tx`insert into evidence_events(id,type,occurred_at,data,previous_hash,hash) values(${unsigned.id},${type},${occurredAt},${tx.json(data)},${unsigned.previousHash},${hash})`;
      return Object.freeze({ ...unsigned, hash });
    });
  }
  async evidence(): Promise<readonly DurableEvidence[]> {
    const rows = await this
      .sql`select sequence,id,type,occurred_at,data,previous_hash,hash from evidence_events order by sequence`;
    return rows.map((r) =>
      Object.freeze({
        sequence: asNumber(r.sequence),
        id: String(r.id),
        type: String(r.type),
        occurredAt: new Date(r.occurred_at as string).toISOString(),
        data: r.data as DurableEvidence["data"],
        previousHash: r.previous_hash as string | null,
        hash: String(r.hash),
      }),
    );
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
