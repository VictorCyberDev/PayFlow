import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { reviewHash, type HumanActionBinding } from "./intent-activation.js";
import type {
  ConsoleLogin,
  ConsoleRequest,
  ConsoleSessionPort,
} from "./console-session.js";

const digest = (s: string) => createHash("sha256").update(s).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const token = () => randomBytes(32).toString("base64url");
const SESSION_MS = 900000;
const WINDOW_SECONDS = 60;

/** Domain-separated keys derived from the operator bootstrap secret. The bootstrap secret
 * itself is never stored; derived keys never leave the server process. */
export function deriveHostKeys(bootstrapKey: string) {
  const derive = (info: string) =>
    Buffer.from(
      hkdfSync("sha256", bootstrapKey, "payflow.m5e-host.v1", info, 32),
    );
  return {
    csrf: derive("csrf"),
    pending: derive("pending-challenge"),
    paymentInstrument: derive("m6-payment-instrument"),
  };
}

type Handle = {
  readonly key: string;
  readonly principalId: string;
  readonly csrf: string;
  readonly expires: number;
};

/** NON-PRODUCTION fixed-identity demo sessions persisted in PostgreSQL so that any host
 * instance (including serverless invocations) can serve any request. Same guarantees as the
 * process-local ConsoleSessions: opaque 256-bit token (only its SHA-256 is stored), fixed
 * server-configured principal, HttpOnly/SameSite cookie (Secure + __Host- on HTTPS), explicit
 * 15-minute expiry, CSRF synchronizer value, exact origin/host audience, bounded login and
 * mutation traffic, logout revocation. No identity-provider claim.
 *
 * `bootstrapKey` remains the cryptographic root for CSRF and all host-derived keys. `accessCode`
 * is an optional human-entered demo login credential only; when absent, historical M5 behavior
 * is preserved by falling back to the bootstrap key. */
export class DurableConsoleSessions implements ConsoleSessionPort {
  readonly #handles = new WeakMap<object, Handle>();
  readonly #actions = new WeakMap<
    object,
    { session: Handle; hash: string; expires: number }
  >();
  readonly #accessHash: Buffer;
  readonly #principal: string;
  readonly #origin: string;
  readonly #host: string;
  readonly #secure: boolean;
  readonly #csrfKey: Buffer;
  constructor(
    private readonly sql: Sql,
    config: {
      principalId: string;
      origin: string;
      bootstrapKey: string;
      accessCode?: string;
    },
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#principal = z.string().min(1).max(128).parse(config.principalId);
    const u = new URL(config.origin);
    if (
      u.origin !== config.origin ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        ))
    )
      throw new Error("INVALID_HOST_ORIGIN");
    if (config.bootstrapKey.length < 32 || config.bootstrapKey.length > 256)
      throw new Error("BOOTSTRAP_CONFIGURATION_REQUIRED");
    const accessCode = config.accessCode ?? config.bootstrapKey;
    if (accessCode.length < 16 || accessCode.length > 256)
      throw new Error("DEMO_ACCESS_CONFIGURATION_REQUIRED");
    this.#origin = u.origin;
    this.#host = u.host;
    this.#secure = u.protocol === "https:";
    this.#accessHash = digest(accessCode);
    this.#csrfKey = deriveHostKeys(config.bootstrapKey).csrf;
  }
  #csrf(key: string) {
    return createHmac("sha256", this.#csrfKey)
      .update("csrf|" + key)
      .digest("base64url");
  }
  #cookieName() {
    return (this.#secure ? "__Host-" : "") + "payflow_session";
  }
  checkOrigin(req: ConsoleRequest) {
    if (req.origin !== this.#origin || req.host !== this.#host)
      throw new Error("ORIGIN_REJECTED");
  }
  /** Authoritative durable check: exists, not revoked, not expired, fixed principal. */
  async #valid(h: Handle): Promise<Handle> {
    const now = this.clock();
    const [row] = await this.sql`
      select principal_id from console_demo_sessions
      where session_hash=${h.key} and revoked_at is null and expires_at > ${now}`;
    if (
      !row ||
      row.principal_id !== this.#principal ||
      now.getTime() >= h.expires
    )
      throw new Error("SESSION_REQUIRED");
    return h;
  }
  async login(req: ConsoleRequest, raw: unknown): Promise<ConsoleLogin> {
    this.checkOrigin(req);
    const parsed = z
      .object({ bootstrapCode: z.string().min(1).max(256) })
      .strict()
      .parse(raw);
    const now = this.clock();
    // One shared, atomic guessing window for every host instance.
    const [w] = await this.sql`
      update console_demo_login_window set
        attempts = case when ${now}::timestamptz - window_started_at >= ${WINDOW_SECONDS} * interval '1 second' then 1 else attempts + 1 end,
        window_started_at = case when ${now}::timestamptz - window_started_at >= ${WINDOW_SECONDS} * interval '1 second' then ${now}::timestamptz else window_started_at end
      where id = 1 returning attempts`;
    if (
      !w ||
      Number(w.attempts) > 5 ||
      !timingSafeEqual(this.#accessHash, digest(parsed.bootstrapCode))
    )
      throw new Error("SESSION_REQUIRED");
    await this
      .sql`delete from console_demo_sessions where expires_at <= ${now}`;
    const rawToken = token(),
      key = digest(rawToken).toString("hex"),
      expires = new Date(now.getTime() + SESSION_MS);
    const inserted = await this.sql`
      insert into console_demo_sessions
        (session_hash, principal_id, created_at, expires_at, window_started_at, window_requests)
      select ${key}, ${this.#principal}, ${now}, ${expires}, ${now}, 0
      where (select count(*) from console_demo_sessions where revoked_at is null and expires_at > ${now}) < 128
      returning session_hash`;
    if (!inserted.length) throw new Error("SESSION_LIMIT");
    return {
      cookie: `${this.#cookieName()}=${rawToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${this.#secure ? "; Secure" : ""}`,
      view: {
        mode: "NON_PRODUCTION_DEMO" as const,
        authenticated: true as const,
        csrfToken: this.#csrf(key),
        expiresAt: expires.toISOString(),
      },
    };
  }
  async read(req: ConsoleRequest): Promise<object> {
    if (req.host !== this.#host) throw new Error("SESSION_REQUIRED");
    const name = this.#cookieName();
    const found = (req.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + "="));
    if (found.length !== 1) throw new Error("SESSION_REQUIRED");
    const rawToken = found[0]!.slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken))
      throw new Error("SESSION_REQUIRED");
    const key = digest(rawToken).toString("hex");
    const now = this.clock();
    const [row] = await this.sql`
      select principal_id, expires_at from console_demo_sessions
      where session_hash=${key} and revoked_at is null and expires_at > ${now}`;
    if (!row || row.principal_id !== this.#principal)
      throw new Error("SESSION_REQUIRED");
    const handle: Handle = Object.freeze({
      key,
      principalId: this.#principal,
      csrf: this.#csrf(key),
      expires: (row.expires_at as Date).getTime(),
    });
    const context = Object.freeze({ kind: "HOST_SESSION" });
    this.#handles.set(context, handle);
    return context;
  }
  #handle(context: unknown): Handle {
    const h =
      typeof context === "object" && context !== null
        ? this.#handles.get(context)
        : undefined;
    if (!h) throw new Error("SESSION_REQUIRED");
    return h;
  }
  view(context: unknown) {
    const h = this.#handle(context);
    if (this.clock().getTime() >= h.expires)
      throw new Error("SESSION_REQUIRED");
    return {
      mode: "NON_PRODUCTION_DEMO" as const,
      authenticated: true as const,
      csrfToken: h.csrf,
      expiresAt: new Date(h.expires).toISOString(),
    };
  }
  async requirePrincipal(context: unknown): Promise<string> {
    return (await this.#valid(this.#handle(context))).principalId;
  }
  ownerRef(context: unknown) {
    return this.#handle(context).key;
  }
  async mutation(req: ConsoleRequest, charge = false): Promise<object> {
    this.checkOrigin(req);
    const context = await this.read(req),
      h = this.#handle(context);
    if (!req.csrf || !equal(req.csrf, h.csrf)) throw new Error("CSRF_REJECTED");
    if (charge) {
      const now = this.clock();
      const [r] = await this.sql`
        update console_demo_sessions set
          window_requests = case when ${now}::timestamptz - window_started_at >= ${WINDOW_SECONDS} * interval '1 second' then 1 else window_requests + 1 end,
          window_started_at = case when ${now}::timestamptz - window_started_at >= ${WINDOW_SECONDS} * interval '1 second' then ${now}::timestamptz else window_started_at end
        where session_hash=${h.key} and revoked_at is null and expires_at > ${now}
        returning window_requests`;
      if (!r) throw new Error("SESSION_REQUIRED");
      if (Number(r.window_requests) > 30) throw new Error("SESSION_RATE_LIMIT");
    }
    return context;
  }
  /** Seal and verify happen inside one request/invocation: the proof object is a request-local,
   * one-use, 60-second, exact-binding assertion and never crosses a request boundary. All
   * cross-request state (session, pending confirmation) is durable. */
  async seal(req: ConsoleRequest, binding: HumanActionBinding) {
    if (
      !["CREATE_INTENT_REVIEW", "CONFIRM_EXACT_TERMS"].includes(binding.action)
    )
      throw new Error("ACTION_REJECTED");
    const h = this.#handle(await this.mutation(req));
    const proof = Object.freeze({ kind: "SEALED_HOST_ACTION" });
    this.#actions.set(proof, {
      session: h,
      hash: reviewHash(binding),
      expires: Math.min(h.expires, this.clock().getTime() + 60000),
    });
    return proof;
  }
  async verify(
    assertion: unknown,
    binding: HumanActionBinding,
  ): Promise<unknown> {
    const proof =
      typeof assertion === "object" && assertion !== null
        ? this.#actions.get(assertion)
        : undefined;
    if (typeof assertion === "object" && assertion !== null)
      this.#actions.delete(assertion);
    if (
      !proof ||
      proof.hash !== reviewHash(binding) ||
      this.clock().getTime() >= proof.expires
    )
      throw new Error("AUTHENTICATION_REQUIRED");
    const s = await this.#valid(proof.session),
      now = this.clock().getTime();
    return {
      principalId: s.principalId,
      actor: "HUMAN",
      authenticatedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(s.expires, now + 300000)).toISOString(),
    };
  }
  async logout(req: ConsoleRequest): Promise<string> {
    const h = this.#handle(await this.mutation(req));
    await this
      .sql`update console_demo_sessions set revoked_at=${this.clock()} where session_hash=${h.key} and revoked_at is null`;
    return `${this.#cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.#secure ? "; Secure" : ""}`;
  }
}
