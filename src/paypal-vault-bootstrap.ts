import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { ConsoleRequest, ConsoleSessionPort } from "./console-session.js";
import { PayPalOAuthClient } from "./paypal.js";

const BASE = "https://api-m.sandbox.paypal.com";
const vaultIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const setupSchema = z.object({
  id: z.string().min(1).max(255),
  links: z.array(
    z.object({ href: z.string().url().max(4000), rel: z.string().min(1).max(64) }),
  ),
});
const tokenSchema = z.object({ id: vaultIdSchema });

async function jsonBody(r: Response, maximum = 65536): Promise<unknown> {
  const text = await r.text();
  if (Buffer.byteLength(text, "utf8") > maximum) throw new Error("PAYPAL_BODY_LIMIT");
  return JSON.parse(text) as unknown;
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
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`payflow.m6.paypal|${principalId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(vaultId, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
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
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv as Uint8Array));
    decipher.setAAD(Buffer.from(`payflow.m6.paypal|${principalId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(row.auth_tag as Uint8Array));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext as Uint8Array)),
      decipher.final(),
    ]).toString("utf8");
    return vaultIdSchema.parse(plaintext);
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
    return { version: "payflow.paypal-vault-status.v1", connected: await this.store.has(principal) };
  }
  async start(req: ConsoleRequest, raw: unknown) {
    z.object({}).strict().parse(raw);
    const context = await this.sessions.mutation(req, true);
    await this.sessions.requirePrincipal(context);
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
              return_url: `${this.origin}/authorities/?paypal=approved`,
              cancel_url: `${this.origin}/authorities/?paypal=cancelled`,
            },
          },
        },
      }),
    });
    if (!r.ok) throw new Error("PAYPAL_VAULT_SETUP_REJECTED");
    const parsed = setupSchema.parse(await jsonBody(r));
    const approvalUrl = parsed.links.find((x) => x.rel === "approve")?.href;
    if (!approvalUrl || new URL(approvalUrl).hostname !== "www.sandbox.paypal.com")
      throw new Error("PAYPAL_VAULT_APPROVAL_URL_INVALID");
    return { version: "payflow.paypal-vault-start.v1", setupTokenId: parsed.id, approvalUrl };
  }
  async complete(req: ConsoleRequest, raw: unknown) {
    const body = z.object({ setupTokenId: z.string().min(1).max(255) }).strict().parse(raw);
    const context = await this.sessions.mutation(req, true);
    const principal = await this.sessions.requirePrincipal(context);
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
        payment_source: { token: { id: body.setupTokenId, type: "SETUP_TOKEN" } },
      }),
    });
    if (!r.ok) throw new Error("PAYPAL_VAULT_EXCHANGE_REJECTED");
    const parsed = tokenSchema.parse(await jsonBody(r));
    await this.store.put(principal, parsed.id);
    return { version: "payflow.paypal-vault-complete.v1", connected: true };
  }
}
