import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";

/**
 * A durable outbox for the account emails. A message is queued in the same flow that creates its token, then sent by a drain that can run any
 * number of times. The one rule that matters: a send whose outcome we cannot see (timeout, dropped connection) is UNKNOWN and is NEVER sent again,
 * because a second email is a second effect. A message that was certainly refused is FAILED. The body (which carries the token link) is erased on SENT.
 */
export type SendResult =
  | { outcome: "SENT" }
  | { outcome: "REFUSED"; note: string }
  | { outcome: "UNKNOWN"; note: string };
export interface EmailSender {
  send(m: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<SendResult>;
}

export class EmailOutbox {
  constructor(private readonly deps: { sql: Sql; now: () => string }) {}

  async enqueue(m: {
    to: string;
    template: "VERIFY_EMAIL" | "RESET_PASSWORD";
    subject: string;
    body: string;
  }): Promise<string> {
    const id = `out_${randomBytes(12).toString("hex")}`;
    const now = this.deps.now();
    await this.deps
      .sql`insert into email_outbox (outbox_id, to_email, template, subject, body, state, created_at, updated_at)
      values (${id}, ${m.to}, ${m.template}, ${m.subject.slice(0, 200)}, ${m.body.slice(0, 4000)}, 'QUEUED', ${now}, ${now})`;
    return id;
  }

  /** Send queued messages once each. Concurrent drains never take the same message. */
  async drain(
    sender: EmailSender,
    limit = 20,
  ): Promise<{ sent: number; failed: number; unknown: number }> {
    const out = { sent: 0, failed: 0, unknown: 0 };
    const rows = await this.deps
      .sql`update email_outbox set state = 'SENDING', attempts = attempts + 1, updated_at = ${this.deps.now()}
      where outbox_id in (select outbox_id from email_outbox where state = 'QUEUED' order by created_at limit ${limit} for update skip locked)
      returning outbox_id, to_email, subject, body`;
    for (const r of rows) {
      let res: SendResult;
      try {
        res = await sender.send({
          to: String(r.to_email),
          subject: String(r.subject),
          body: String(r.body),
          idempotencyKey: String(r.outbox_id),
        });
      } catch {
        res = {
          outcome: "UNKNOWN",
          note: "the sender threw; delivery cannot be confirmed",
        };
      }
      const now = this.deps.now();
      if (res.outcome === "SENT") {
        await this.deps
          .sql`update email_outbox set state = 'SENT', body = null, note = null, updated_at = ${now} where outbox_id = ${String(r.outbox_id)}`;
        out.sent++;
      } else if (res.outcome === "REFUSED") {
        await this.deps
          .sql`update email_outbox set state = 'FAILED', body = null, note = ${res.note.slice(0, 300)}, updated_at = ${now} where outbox_id = ${String(r.outbox_id)}`;
        out.failed++;
      } else {
        await this.deps
          .sql`update email_outbox set state = 'UNKNOWN', note = ${res.note.slice(0, 300)}, updated_at = ${now} where outbox_id = ${String(r.outbox_id)}`;
        out.unknown++;
      }
    }
    return out;
  }
}

/** Resend over HTTPS. A 4xx is a certain refusal; anything else we cannot see is UNKNOWN. Needs an API key and a verified sender from the owner. */
export function resendSender(o: {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EmailSender {
  const f = o.fetchImpl ?? fetch;
  return {
    async send(m) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
      try {
        const res = await f("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${o.apiKey}`,
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
        if (res.ok) return { outcome: "SENT" };
        if (
          res.status >= 400 &&
          res.status < 500 &&
          res.status !== 408 &&
          res.status !== 429
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
