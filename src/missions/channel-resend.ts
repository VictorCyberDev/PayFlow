import {
  DefinitiveSendError,
  type ChannelAdapter,
  type OutgoingMessage,
} from "./channels.js";

/**
 * R2 — a real email channel adapter for Resend (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Status: IMPLEMENTED + contract-tested against a local server that reproduces Resend's documented request and error shapes.
 * It has NEVER been run against Resend: that needs an API key and a verified sending domain from the owner. It is not registered
 * anywhere by default; turning it on is a reviewed code change (see `channels.ts`), exactly like any live channel.
 *
 * Delivery semantics (the contract `ChannelAdapter` demands):
 *  - 2xx with an `id`            -> accepted by the provider; the id is the reference.
 *  - 400/401/403/404/422/429     -> the provider refused before sending: `DefinitiveSendError` (nothing was sent).
 *  - 409 (idempotency conflict)  -> UNKNOWN: a concurrent request with the same key may be sending it right now.
 *  - 5xx, timeout, reset, abort, an unreadable or oversized reply, a redirect -> UNKNOWN. PayFlow records DELIVERY_UNKNOWN and a
 *    person resolves it; the adapter never retries and the same `Idempotency-Key` makes a person's retry safe at the provider.
 * The API key is held in a closure and never appears in an error message.
 */
const MAX_REPLY_BYTES = 16 * 1024;
const DEFINITIVE = new Set([400, 401, 403, 404, 422, 429]);

export interface ResendOptions {
  readonly apiKey: string;
  /** A sender on a domain the owner has verified with Resend, e.g. `PayFlow <notices@example.com>`. */
  readonly from: string;
  /** Defaults to the public API. Must be https. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function resendEmailChannel(o: ResendOptions): ChannelAdapter {
  if (!/^re_[A-Za-z0-9_]{8,}$/u.test(o.apiKey))
    throw new Error("RESEND_API_KEY_INVALID");
  if (!o.from || o.from.length > 200 || /[\r\n]/u.test(o.from))
    throw new Error("RESEND_FROM_INVALID");
  const base = new URL(o.baseUrl ?? "https://api.resend.com");
  if (base.protocol !== "https:" && !isLoopback(base.hostname))
    throw new Error("RESEND_BASE_URL_MUST_BE_HTTPS");
  const doFetch = o.fetch ?? globalThis.fetch;
  const apiKey = o.apiKey;
  return {
    id: "resend-email",
    channel: "EMAIL",
    mode: "LIVE",
    async send(m: OutgoingMessage, signal: AbortSignal) {
      assertSendable(m);
      let res: Response;
      try {
        res = await doFetch(new URL("/emails", base), {
          method: "POST",
          redirect: "manual", // a redirect could carry the key elsewhere: it is an unknown outcome, never followed
          signal,
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
        });
      } catch {
        // The request may have left. Say nothing about the cause: it could echo headers in some runtimes.
        throw new Error("RESEND_SEND_OUTCOME_UNKNOWN");
      }
      if (DEFINITIVE.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        throw new DefinitiveSendError(`RESEND_REFUSED_${res.status}`);
      }
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`RESEND_SEND_OUTCOME_UNKNOWN_${res.status}`);
      }
      const text = await readCapped(res);
      let id: unknown;
      try {
        id = (JSON.parse(text) as { id?: unknown }).id;
      } catch {
        id = undefined;
      }
      // A 2xx we cannot read still may have sent the message: unknown, not failed.
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(id))
        throw new Error("RESEND_REPLY_UNREADABLE");
      return { ref: `resend:${id}` };
    },
  };
}

function assertSendable(m: OutgoingMessage): void {
  // Header-injection and provider limits are checked BEFORE anything leaves, so these are definitive.
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(m.to))
    throw new DefinitiveSendError("RECIPIENT_INVALID");
  if (
    /[\r\n]/u.test(m.subject) ||
    m.subject.length === 0 ||
    m.subject.length > 200
  )
    throw new DefinitiveSendError("SUBJECT_INVALID");
  if (m.body.length === 0 || m.body.length > 20_000)
    throw new DefinitiveSendError("BODY_INVALID");
  if (m.idempotencyKey.length < 8 || m.idempotencyKey.length > 256)
    throw new DefinitiveSendError("IDEMPOTENCY_KEY_INVALID");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("RESEND_REPLY_UNREADABLE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isLoopback = (h: string) =>
  h === "127.0.0.1" || h === "localhost" || h === "[::1]";
