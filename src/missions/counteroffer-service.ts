import type { Sql } from "postgres";
import type { NResult, NegotiationService } from "./negotiation-service.js";
import type { QuoteService } from "./quote-service.js";
import {
  recommend,
  type OurCounter,
  type Recommendation,
  type TheirOffer,
} from "./counteroffers.js";
import type { MissionCaller, MissionService } from "./service.js";

/**
 * V3 M38 — the negotiation timeline and what to do next. It joins what we have sent (counters, with system-counted rounds) with what
 * the supplier has stated (their quotes, newest first), and applies the approved rules to say: review an offer for acceptance, send a
 * next counter, wait, or walk away. It changes nothing; a counter still needs a person's approval and acceptance is a person's.
 */
const iso = (v: unknown) => new Date(v as string).toISOString();

export interface TimelineEntry {
  readonly at: string;
  readonly side: "OURS" | "THEIRS";
  readonly kind: "COUNTER" | "QUOTE";
  readonly id: string;
  readonly totalMinor: number | null;
  readonly round?: number;
  readonly status: string;
}

export class CounterofferService {
  constructor(
    private readonly deps: {
      sql: Sql;
      missions: MissionService;
      negotiations: NegotiationService;
      quotes: QuoteService;
    },
  ) {}

  async timeline(
    caller: MissionCaller,
    negotiationId: string,
  ): Promise<
    NResult<{
      negotiationId: string;
      status: string;
      entries: TimelineEntry[];
      recommendation: Recommendation | { action: "ESCALATE"; why: string };
      notice: string;
    }>
  > {
    const [n] = await this.deps
      .sql`select n.mission_id, n.supplier_id from mission_negotiations n join missions m on m.mission_id = n.mission_id
      where n.negotiation_id = ${negotiationId} and m.organization_id = ${caller.organizationId} and m.environment = ${caller.environment}`;
    if (!n) return { ok: false, refusal: "NOT_FOUND" };
    const missionId = String(n.mission_id);
    const reader: MissionCaller = {
      organizationId: caller.organizationId,
      environment: caller.environment,
      id: "counteroffers",
      kind: "MEMBER",
    };
    const list = await this.deps.negotiations.list(reader, missionId);
    const view = list.ok
      ? list.value.negotiations.find((x) => x.negotiationId === negotiationId)
      : undefined;
    if (!view) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "NEGOTIATE",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
      const named = (view.inForce ?? view.pending ?? view.versions.at(-1))
        ?.document.negotiatorAgentId;
      if (named !== caller.id)
        return { ok: false, refusal: "NOT_THE_NEGOTIATOR" };
    }
    const msgs = await this.deps
      .sql`select message_id, move, status, created_at, timeline_seq from mission_messages
      where negotiation_id = ${negotiationId} and kind = 'NEGOTIATION' and status in ('PENDING_APPROVAL','APPROVED','SENDING','SENT','DELIVERY_UNKNOWN') order by timeline_seq`;
    const ours: OurCounter[] = msgs.map((m, i) => ({
      messageId: String(m.message_id),
      round: i + 1,
      totalMinor: Number((m.move as { totalMinor: number }).totalMinor),
      status: m.status as OurCounter["status"],
      at: iso(m.created_at),
      seq: Number(m.timeline_seq),
    }));
    const ql = await this.deps.quotes.list(reader, missionId);
    const seqs = new Map(
      (
        await this.deps
          .sql`select quote_id, timeline_seq from mission_quotes where mission_id = ${missionId}`
      ).map((r) => [String(r.quote_id), Number(r.timeline_seq)]),
    );
    const quotes = ql.ok
      ? ql.value.quotes.filter((q) => q.supplierId === String(n.supplier_id))
      : [];
    const theirs: TheirOffer[] = quotes.map((q) => ({
      quoteId: q.quoteId,
      totalMinor: q.landed.totalMinor,
      complete: q.landed.complete,
      current: q.status === "CURRENT",
      currency: q.currency,
      terms: {
        ...(q.document.terms.warrantyMonths !== undefined
          ? { warrantyMonths: q.document.terms.warrantyMonths }
          : {}),
        ...(q.document.terms.returnWindowDays !== undefined
          ? { returnWindowDays: q.document.terms.returnWindowDays }
          : {}),
        ...(q.document.terms.deliveryDays !== undefined
          ? { deliveryDays: q.document.terms.deliveryDays }
          : {}),
      },
      at: q.recordedAt,
      seq: seqs.get(q.quoteId) ?? 0,
    }));
    const entries: (TimelineEntry & { seq: number })[] = [
      ...ours.map((o) => ({
        at: o.at,
        seq: o.seq,
        side: "OURS" as const,
        kind: "COUNTER" as const,
        id: o.messageId,
        totalMinor: o.totalMinor,
        round: o.round,
        status: o.status,
      })),
      ...quotes.map((q) => ({
        at: q.recordedAt,
        seq: seqs.get(q.quoteId) ?? 0,
        side: "THEIRS" as const,
        kind: "QUOTE" as const,
        id: q.quoteId,
        totalMinor: q.landed.totalMinor,
        status: q.status,
      })),
    ].sort((a, b) => a.seq - b.seq);
    const doc = view.inForce?.document;
    const recommendation = doc
      ? recommend({ doc, ours, theirs })
      : {
          action: "ESCALATE" as const,
          why: `No negotiation rules are in force (${view.status}); a person must approve them first.`,
        };
    return {
      ok: true,
      value: {
        negotiationId,
        status: view.status,
        entries,
        recommendation,
        notice:
          "A recommendation only. A counter still needs a person's approval and passes the negotiation rules; accepting is a person's decision.",
      },
    };
  }
}
