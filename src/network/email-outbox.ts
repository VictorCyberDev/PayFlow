import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";

/**
 * A durable outbox for the account emails. A message is queued in the same flow that creates its token, then sent by a drain that can run any
 * number of times. The one rule that matters: a send whose outcome we cannot see (timeout, dropped connection) is UNKNOWN and is NEVER sent again,
 * because a second email is a second effect. A message that was certainly refused is FAILED. The body (which carries the token link) is erased on SENT.
 */
export type SendResult =
  | { outcome: "SENT" }
  /** Certainly not sent, and never will be. */
  | { outcome: "REFUSED"; note: string }
  /** Certainly not sent, but the provider asked us to come back later (rate limit). The message goes back in the queue. */
  | { outcome: "DEFER"; note: string }
  | { outcome: "UNKNOWN"; note: string };
export interface EmailSender {
  send(m: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<SendResult>;
}

/** A worker that claims a message holds it for this long; after that the message is treated as lost, not as slow. */
export const SEND_LEASE_MS = 2 * 60_000;
/** A message that is still being deferred after this many tries is given up on (FAILED), so a link is not retried for ever. */
export const MAX_ATTEMPTS = 5;

export interface Tx {
  <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T[]>;
}

export class EmailOutbox {
  constructor(private readonly deps: { sql: Sql; now: () => string }) {}

  /**
   * Queue a message. Pass the open transaction of the flow that made the token, so the token and the message are one commit: there is never a
   * live link with no message, and never a message for a link that was rolled back.
   */
  async enqueue(
    m: {
      to: string;
      template: "VERIFY_EMAIL" | "RESET_PASSWORD";
      subject: string;
      body: string;
      /** SHA-256 hex digest of the token the body carries (never the token). */
      tokenHash?: string;
      expiresAt?: string;
    },
    tx?: Tx,
  ): Promise<string> {
    const id = `out_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    const q = (tx ?? this.deps.sql) as unknown as Sql;
    await q`insert into email_outbox (outbox_id, to_email, template, subject, body, state, token_hash, expires_at, created_at, updated_at)
      values (${id}, ${m.to}, ${m.template}, ${m.subject.slice(0, 200)}, ${m.body.slice(0, 4000)}, 'QUEUED', ${m.tokenHash ?? null}, ${m.expiresAt ?? null}, ${now}, ${now})`;
    return id;
  }

  /**
   * Housekeeping, safe to repeat:
   *  - a message still SENDING after its lease is UNKNOWN (a worker died somewhere between claiming it and recording the answer: the provider
   *    may or may not have it). It is never sent again.
   *  - a message that expired before it was sent is FAILED, and its body is erased.
   *  - the body of any other message whose link has expired is erased: a dead link is not worth keeping readable.
   */
  async sweep(): Promise<{ lost: number; expired: number; erased: number }> {
    const now = this.deps.now();
    const sql = this.deps.sql;
    const lost =
      await sql`update email_outbox set state = 'UNKNOWN', note = 'the worker was lost while sending; delivery cannot be confirmed', updated_at = ${now}
      where state = 'SENDING' and lease_until is not null and lease_until < ${now} returning 1`;
    const expired =
      await sql`update email_outbox set state = 'FAILED', body = null, note = 'expired before it was sent', updated_at = ${now}
      where state = 'QUEUED' and expires_at is not null and expires_at < ${now} returning 1`;
    const erased =
      await sql`update email_outbox set body = null, updated_at = ${now}
      where state in ('UNKNOWN','FAILED') and body is not null and expires_at is not null and expires_at < ${now} returning 1`;
    return {
      lost: lost.length,
      expired: expired.length,
      erased: erased.length,
    };
  }

  /** Take ownership of up to `limit` queued messages. Concurrent claims never overlap. */
  async claim(limit = 20): Promise<
    {
      outboxId: string;
      to: string;
      subject: string;
      body: string;
      expiresAt: string | null;
    }[]
  > {
    const now = this.deps.now();
    const lease = new Date(Date.parse(now) + SEND_LEASE_MS).toISOString();
    const rows = await this.deps
      .sql`update email_outbox set state = 'SENDING', attempts = attempts + 1, lease_until = ${lease}, updated_at = ${now}
      where outbox_id in (select outbox_id from email_outbox where state = 'QUEUED' and (expires_at is null or expires_at > ${now}) order by created_at limit ${limit} for update skip locked)
      returning outbox_id, to_email, subject, body, expires_at`;
    return rows.map((r) => ({
      outboxId: String(r.outbox_id),
      to: String(r.to_email),
      subject: String(r.subject),
      body: String(r.body),
      expiresAt: r.expires_at
        ? new Date(r.expires_at as string | Date).toISOString()
        : null,
    }));
  }

  /** Record what the provider said. Only a message still SENDING (or already UNKNOWN, which a late answer may settle) can change. */
  async settle(outboxId: string, res: SendResult): Promise<void> {
    const now = this.deps.now();
    const sql = this.deps.sql;
    if (res.outcome === "SENT")
      await sql`update email_outbox set state = 'SENT', body = null, note = null, lease_until = null, updated_at = ${now}
        where outbox_id = ${outboxId} and state in ('SENDING','UNKNOWN')`;
    else if (res.outcome === "REFUSED")
      await sql`update email_outbox set state = 'FAILED', body = null, note = ${res.note.slice(0, 300)}, lease_until = null, updated_at = ${now}
        where outbox_id = ${outboxId} and state in ('SENDING','UNKNOWN')`;
    else if (res.outcome === "DEFER")
      await sql`update email_outbox set state = case when attempts >= ${MAX_ATTEMPTS} then 'FAILED' else 'QUEUED' end,
          body = case when attempts >= ${MAX_ATTEMPTS} then null else body end, note = ${res.note.slice(0, 300)}, lease_until = null, updated_at = ${now}
        where outbox_id = ${outboxId} and state = 'SENDING'`;
    else
      await sql`update email_outbox set state = 'UNKNOWN', note = ${res.note.slice(0, 300)}, lease_until = null, updated_at = ${now}
        where outbox_id = ${outboxId} and state = 'SENDING'`;
  }

  /** Send queued messages once each. Concurrent drains never take the same message. */
  async drain(
    sender: EmailSender,
    limit = 20,
  ): Promise<{
    sent: number;
    failed: number;
    unknown: number;
    deferred: number;
  }> {
    const out = { sent: 0, failed: 0, unknown: 0, deferred: 0 };
    for (const m of await this.claim(limit)) {
      let res: SendResult;
      try {
        res = await sender.send({
          to: m.to,
          subject: m.subject,
          body: m.body,
          idempotencyKey: m.outboxId,
        });
      } catch {
        res = {
          outcome: "UNKNOWN",
          note: "the sender threw; delivery cannot be confirmed",
        };
      }
      await this.settle(m.outboxId, res);
      if (res.outcome === "SENT") out.sent++;
      else if (res.outcome === "REFUSED") out.failed++;
      else if (res.outcome === "DEFER") out.deferred++;
      else out.unknown++;
    }
    return out;
  }

  /**
   * What an operator may see: counts and the messages needing attention. Never a body, never a token digest, and recipients are masked,
   * so the screen cannot be used to read someone's recovery link or address list.
   */
  async summary(): Promise<{
    counts: Record<string, number>;
    needsAttention: {
      outboxId: string;
      template: string;
      to: string;
      state: string;
      attempts: number;
      note: string | null;
      createdAt: string;
    }[];
    oldestQueuedSeconds: number | null;
  }> {
    const sql = this.deps.sql;
    const counts: Record<string, number> = {};
    for (const r of await sql`select state, count(*)::int n from email_outbox group by state`)
      counts[String(r.state)] = Number(r.n);
    const rows =
      await sql`select outbox_id, template, to_email, state, attempts, note, created_at from email_outbox
      where state in ('UNKNOWN','SENDING') or (state = 'FAILED' and updated_at > ${new Date(Date.parse(this.deps.now()) - 86_400_000).toISOString()})
      order by created_at desc limit 50`;
    const [oldest] =
      await sql`select min(created_at) t from email_outbox where state = 'QUEUED'`;
    return {
      counts,
      needsAttention: rows.map((r) => ({
        outboxId: String(r.outbox_id),
        template: String(r.template),
        to: maskEmail(String(r.to_email)),
        state: String(r.state),
        attempts: Number(r.attempts),
        note: r.note ? String(r.note) : null,
        createdAt: new Date(r.created_at as string | Date).toISOString(),
      })),
      oldestQueuedSeconds: oldest?.t
        ? Math.max(
            0,
            Math.round(
              (Date.parse(this.deps.now()) -
                new Date(oldest.t as string | Date).getTime()) /
                1000,
            ),
          )
        : null,
    };
  }
}

export function maskEmail(e: string): string {
  const [l = "", d = ""] = e.split("@");
  return `${l.slice(0, 1)}***@${d.slice(0, 1)}***${d.includes(".") ? d.slice(d.lastIndexOf(".")) : ""}`;
}

/**
 * Resend over HTTPS. A 4xx is a certain refusal; 429 is a certain "not sent, later"; anything else we cannot see is UNKNOWN. Needs an API key and a
 * verified sender from the owner. Redirects are never followed (a redirect could carry the key elsewhere) and the reply is never read beyond its status,
 * so nothing the provider says can reach a log or a customer.
 */
export function resendSender(o: {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}): EmailSender {
  if (!/^re_[A-Za-z0-9_]{8,}$/u.test(o.apiKey))
    throw new Error("RESEND_API_KEY_INVALID");
  if (!o.from || o.from.length > 200 || /[\r\n]/u.test(o.from))
    throw new Error("RESEND_FROM_INVALID");
  const base = new URL(o.baseUrl ?? "https://api.resend.com");
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error("RESEND_BASE_URL_MUST_BE_HTTPS");
  const f = o.fetchImpl ?? fetch;
  const apiKey = o.apiKey;
  return {
    async send(m) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
      try {
        const res = await f(new URL("/emails", base), {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": m.idempotencyKey,
          },
          body: JSON.stringify({
            from: o.from,
            to: [m.to],
            subject: m.subject,
            text: m.body,
          }),
          signal: ctl.signal,
        });
        if (res.status >= 200 && res.status < 300) return { outcome: "SENT" };
        if (res.status === 429)
          return { outcome: "DEFER", note: "the provider asked us to wait" };
        if (
          res.status >= 400 &&
          res.status < 500 &&
          res.status !== 408 &&
          res.status !== 409
        )
          return {
            outcome: "REFUSED",
            note: `provider refused (${res.status})`,
          };
        return { outcome: "UNKNOWN", note: `provider answered ${res.status}` };
      } catch {
        return { outcome: "UNKNOWN", note: "no answer from the provider" };
      } finally {
        clearTimeout(t);
      }
    },
  };
}
