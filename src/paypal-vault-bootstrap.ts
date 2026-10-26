import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { ConsoleRequest, ConsoleSessionPort } from "./console-session.js";
import type { PayPalOAuthClient } from "./paypal.js";

const BASE = "https://api-m.sandbox.paypal.com";
const vaultIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const callbackStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const setupSchema = z.object({
  id: z.string().min(1).max(255),
  links: z.array(
    z.object({
      href: z.string().url().max(4000),
      rel: z.string().min(1).max(64),
    }),
  ),
});
const tokenSchema = z.object({ id: vaultIdSchema });
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function jsonBody(r: Response, maximum = 65536): Promise<unknown> {
  const text = await r.text();
  if (Buffer.byteLength(text, "utf8") > maximum)
    throw new Error("PAYPAL_BODY_LIMIT");
  return JSON.parse(text) as unknown;
}

function protect(raw: string, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(raw, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function unprotect(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  authTag: Uint8Array,
  key: Buffer,
  aad: string,
) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(authTag));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export class PayPalVaultStore {
  constructor(
    private readonly sql: Sql,
    private readonly key: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (key.length !== 32) throw new Error("PAYMENT_INSTRUMENT_KEY_INVALID");
  }
  async has(principalId: string): Promise<boolean> {
    const [row] = await this.sql`
      select 1 from console_demo_payment_instruments
      where principal_id=${principalId} and provider='PAYPAL_SANDBOX'`;
    return Boolean(row);
  }
  async put(principalId: string, rawVaultId: string): Promise<void> {
    const vaultId = vaultIdSchema.parse(rawVaultId);
    const { ciphertext, iv, authTag } = protect(
      vaultId,
      this.key,
      `payflow.m6.paypal|${principalId}`,
    );
    const now = this.clock();
    await this.sql`
      insert into console_demo_payment_instruments
        (principal_id, provider, ciphertext, iv, auth_tag, created_at, updated_at)
      values (${principalId}, 'PAYPAL_SANDBOX', ${ciphertext}, ${iv}, ${authTag}, ${now}, ${now})
      on conflict (principal_id) do update set
        provider='PAYPAL_SANDBOX', ciphertext=${ciphertext}, iv=${iv}, auth_tag=${authTag}, updated_at=${now}`;
  }
  async get(principalId: string): Promise<string | null> {
    const [row] = await this.sql`
      select ciphertext, iv, auth_tag from console_demo_payment_instruments
      where principal_id=${principalId} and provider='PAYPAL_SANDBOX'`;
    if (!row) return null;
    return vaultIdSchema.parse(
      unprotect(
        row.ciphertext as Uint8Array,
        row.iv as Uint8Array,
        row.auth_tag as Uint8Array,
        this.key,
        `payflow.m6.paypal|${principalId}`,
      ),
    );
  }

  /** Persist a one-time setup token without exposing it to the browser. */
  async putSetup(input: {
    principalId: string;
    ownerSessionRef: string;
    state: string;
    setupTokenId: string;
  }): Promise<void> {
    const state = callbackStateSchema.parse(input.state);
    const setupTokenId = z.string().min(1).max(255).parse(input.setupTokenId);
    if (!/^[a-f0-9]{64}$/.test(input.ownerSessionRef))
      throw new Error("SESSION_REFERENCE_INVALID");
    const { ciphertext, iv, authTag } = protect(
      setupTokenId,
      this.key,
      `payflow.m6.paypal.setup|${input.principalId}|${input.ownerSessionRef}|${digest(state)}`,
    );
    const now = this.clock();
    const expires = new Date(now.getTime() + 10 * 60 * 1000);
    await this.sql`
      delete from console_demo_paypal_vault_setups
      where expires_at <= ${now} or claimed_at is not null`;
    await this.sql`
      insert into console_demo_paypal_vault_setups
        (state_hash, owner_session_hash, principal_id, setup_ciphertext, iv, auth_tag, created_at, expires_at)
      values (
        ${digest(state)}, ${input.ownerSessionRef}, ${input.principalId}, ${ciphertext}, ${iv},
        ${authTag}, ${now}, ${expires}
      )`;
  }

  /** Claim exactly one setup for this authenticated session. Failed/ambiguous exchange is fail-closed. */
  async claimSetup(input: {
    principalId: string;
    ownerSessionRef: string;
    state: string;
  }): Promise<string> {
    const state = callbackStateSchema.parse(input.state);
    const now = this.clock();
    const [row] = await this.sql`
      update console_demo_paypal_vault_setups
      set claimed_at=${now}
      where state_hash=${digest(state)}
        and owner_session_hash=${input.ownerSessionRef}
        and principal_id=${input.principalId}
        and claimed_at is null
        and expires_at > ${now}
      returning setup_ciphertext, iv, auth_tag`;
    if (!row) throw new Error("PAYPAL_VAULT_SETUP_STATE_INVALID");
    return z.string().min(1).max(255).parse(
      unprotect(
        row.setup_ciphertext as Uint8Array,
        row.iv as Uint8Array,
        row.auth_tag as Uint8Array,
        this.key,
        `payflow.m6.paypal.setup|${input.principalId}|${input.ownerSessionRef}|${digest(state)}`,
      ),
    );
  }
}

/** One-time Sandbox payer-present bootstrap. This service does not create, capture, or retry orders. */
export class ConsolePayPalVaultBootstrap {
  constructor(
    private readonly sessions: ConsoleSessionPort,
    private readonly oauth: PayPalOAuthClient,
    private readonly store: PayPalVaultStore,
    private readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async status(req: ConsoleRequest) {
    const context = await this.sessions.read(req);
    const principal = await this.sessions.requirePrincipal(context);
    return {
      version: "payflow.paypal-vault-status.v1",
      connected: await this.store.has(principal),
    };
  }
  async start(req: ConsoleRequest, raw: unknown) {
    z.object({}).strict().parse(raw);
    const context = await this.sessions.mutation(req, true);
    const principal = await this.sessions.requirePrincipal(context);
    const ownerSessionRef = this.sessions.ownerRef(context);
    const state = randomBytes(32).toString("base64url");
    const returnUrl = new URL("/authorities/", this.origin);
    returnUrl.searchParams.set("paypal", "approved");
    returnUrl.searchParams.set("state", state);
    const cancelUrl = new URL("/authorities/", this.origin);
    cancelUrl.searchParams.set("paypal", "cancelled");
    const access = await this.oauth.accessToken();
    const r = await this.fetcher(`${BASE}/v3/vault/setup-tokens`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": randomUUID(),
      },
      body: JSON.stringify({
        payment_source: {
          paypal: {
            description: "PayFlow delegated Sandbox commerce",
            permit_multiple_payment_tokens: false,
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            experience_context: {
              brand_name: "PayFlow",
              shipping_preference: "NO_SHIPPING",
              user_action: "SETUP_NOW",
              return_url: returnUrl.toString(),
              cancel_url: cancelUrl.toString(),
            },
          },
        },
      }),
    });
    if (!r.ok) throw new Error("PAYPAL_VAULT_SETUP_REJECTED");
    const parsed = setupSchema.parse(await jsonBody(r));
    const approvalUrl = parsed.links.find((x) => x.rel === "approve")?.href;
    if (
      !approvalUrl ||
      new URL(approvalUrl).hostname !== "www.sandbox.paypal.com"
    )
      throw new Error("PAYPAL_VAULT_APPROVAL_URL_INVALID");
    await this.store.putSetup({
      principalId: principal,
      ownerSessionRef,
      state,
      setupTokenId: parsed.id,
    });
    return {
      version: "payflow.paypal-vault-start.v2",
      approvalUrl,
    };
  }
  async complete(req: ConsoleRequest, raw: unknown) {
    const body = z
      .object({ state: callbackStateSchema })
      .strict()
      .parse(raw);
    const context = await this.sessions.mutation(req, true);
    const principal = await this.sessions.requirePrincipal(context);
    const ownerSessionRef = this.sessions.ownerRef(context);
    const setupTokenId = await this.store.claimSetup({
      principalId: principal,
      ownerSessionRef,
      state: body.state,
    });
    const access = await this.oauth.accessToken();
    const r = await this.fetcher(`${BASE}/v3/vault/payment-tokens`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": randomUUID(),
      },
      body: JSON.stringify({
        payment_source: {
          token: { id: setupTokenId, type: "SETUP_TOKEN" },
        },
      }),
    });
    if (!r.ok) throw new Error("PAYPAL_VAULT_EXCHANGE_REJECTED");
    const parsed = tokenSchema.parse(await jsonBody(r));
    await this.store.put(principal, parsed.id);
    return {
      version: "payflow.paypal-vault-complete.v2",
      connected: true,
    };
  }
}
