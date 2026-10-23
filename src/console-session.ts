import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  reviewHash,
  type HumanActionAuthenticator,
  type HumanActionBinding,
} from "./intent-activation.js";

export interface ConsoleRequest {
  cookie?: string | undefined;
  origin?: string | undefined;
  csrf?: string | undefined;
  host?: string | undefined;
}
type Session = {
  principalId: string;
  csrf: string;
  expires: number;
  key: string;
  requests: number;
  window: number;
};
const digest = (s: string) => createHash("sha256").update(s).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const token = () => randomBytes(32).toString("base64url");
/** NON-PRODUCTION fixed-identity bootstrap, opaque in-memory sessions. No identity
 * provider claim. Bootstrap key must be configured privately by the operator. */
export class ConsoleSessions implements HumanActionAuthenticator {
  readonly #sessions = new Map<string, Session>();
  readonly #handles = new WeakMap<object, Session>();
  readonly #actions = new WeakMap<
    object,
    { session: Session; hash: string; expires: number }
  >();
  readonly #bootstrapHash: Buffer;
  readonly #principal: string;
  readonly #origin: string;
  readonly #host: string;
  readonly #secure: boolean;
  #attempts = 0;
  #window = 0;
  constructor(
    config: { principalId: string; origin: string; bootstrapKey: string },
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
    this.#origin = u.origin;
    this.#host = u.host;
    this.#secure = u.protocol === "https:";
    this.#bootstrapHash = digest(config.bootstrapKey);
  }
  checkOrigin(req: ConsoleRequest) {
    if (req.origin !== this.#origin || req.host !== this.#host)
      throw new Error("ORIGIN_REJECTED");
  }
  #valid(s: Session) {
    if (this.#sessions.get(s.key) !== s || this.clock().getTime() >= s.expires)
      throw new Error("SESSION_REQUIRED");
    return s;
  }
  login(req: ConsoleRequest, raw: unknown) {
    this.checkOrigin(req);
    const parsed = z
      .object({ bootstrapCode: z.string().min(1).max(256) })
      .strict()
      .parse(raw);
    const now = this.clock().getTime();
    if (now - this.#window >= 60000) {
      this.#window = now;
      this.#attempts = 0;
    }
    if (
      ++this.#attempts > 5 ||
      !timingSafeEqual(this.#bootstrapHash, digest(parsed.bootstrapCode))
    )
      throw new Error("SESSION_REQUIRED");
    for (const [k, s] of this.#sessions)
      if (now >= s.expires) this.#sessions.delete(k);
    if (this.#sessions.size >= 128) throw new Error("SESSION_LIMIT");
    const rawToken = token(),
      key = digest(rawToken).toString("hex");
    const s: Session = {
      key,
      principalId: this.#principal,
      csrf: token(),
      expires: now + 900000,
      requests: 0,
      window: now,
    };
    this.#sessions.set(key, s);
    return {
      cookie: `${this.#secure ? "__Host-" : ""}payflow_session=${rawToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${this.#secure ? "; Secure" : ""}`,
      view: {
        mode: "NON_PRODUCTION_DEMO" as const,
        authenticated: true as const,
        csrfToken: s.csrf,
        expiresAt: new Date(s.expires).toISOString(),
      },
    };
  }
  read(req: ConsoleRequest): object {
    if (req.host !== this.#host) throw new Error("SESSION_REQUIRED");
    const name = this.#secure ? "__Host-payflow_session" : "payflow_session";
    const found = (req.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + "="));
    if (found.length !== 1) throw new Error("SESSION_REQUIRED");
    const raw = found[0]!.slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error("SESSION_REQUIRED");
    const s = this.#sessions.get(digest(raw).toString("hex"));
    if (!s) throw new Error("SESSION_REQUIRED");
    const handle = Object.freeze({ kind: "HOST_SESSION" });
    this.#handles.set(handle, this.#valid(s));
    return handle;
  }
  #session(context: unknown): Session {
    const s =
      typeof context === "object" && context !== null
        ? this.#handles.get(context)
        : undefined;
    if (!s) throw new Error("SESSION_REQUIRED");
    return this.#valid(s);
  }
  view(context: unknown) {
    const s = this.#session(context);
    return {
      mode: "NON_PRODUCTION_DEMO" as const,
      authenticated: true as const,
      csrfToken: s.csrf,
      expiresAt: new Date(s.expires).toISOString(),
    };
  }
  requirePrincipal(context: unknown): Promise<string> {
    return Promise.resolve(this.#session(context).principalId);
  }
  sameSession(a: unknown, b: unknown) {
    return this.#session(a) === this.#session(b);
  }
  mutation(req: ConsoleRequest, charge = false) {
    this.checkOrigin(req);
    const handle = this.read(req),
      s = this.#session(handle);
    if (!req.csrf || !equal(req.csrf, s.csrf)) throw new Error("CSRF_REJECTED");
    if (charge) {
      const now = this.clock().getTime();
      if (now - s.window >= 60000) {
        s.window = now;
        s.requests = 0;
      }
      if (++s.requests > 30) throw new Error("SESSION_RATE_LIMIT");
    }
    return handle;
  }
  seal(req: ConsoleRequest, binding: HumanActionBinding) {
    if (
      !["CREATE_INTENT_REVIEW", "CONFIRM_EXACT_TERMS"].includes(binding.action)
    )
      throw new Error("ACTION_REJECTED");
    const handle = this.mutation(req),
      s = this.#session(handle);
    const proof = Object.freeze({ kind: "SEALED_HOST_ACTION" });
    this.#actions.set(proof, {
      session: s,
      hash: reviewHash(binding),
      expires: Math.min(s.expires, this.clock().getTime() + 60000),
    });
    return proof;
  }
  verify(assertion: unknown, binding: HumanActionBinding): Promise<unknown> {
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
    const s = this.#valid(proof.session),
      now = this.clock().getTime();
    return Promise.resolve({
      principalId: s.principalId,
      actor: "HUMAN",
      authenticatedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(s.expires, now + 300000)).toISOString(),
    });
  }
  logout(req: ConsoleRequest) {
    const s = this.#session(this.mutation(req));
    this.#sessions.delete(s.key);
    return `${this.#secure ? "__Host-" : ""}payflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.#secure ? "; Secure" : ""}`;
  }
}
