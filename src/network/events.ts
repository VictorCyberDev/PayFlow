import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

export const PayFlowEventSchema = z
  .object({
    version: z.literal("payflow-event/v1"),
    id: z.string().min(1),
    type: z.enum([
      "authority.created",
      "authority.activated",
      "authority.suspended",
      "authority.revoked",
      "action.decision",
      "action.unknown",
      "action.reconciled",
      "proof.available",
    ]),
    organizationId: z.string().min(1),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    occurredAt: z.string().datetime(),
    subjectId: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PayFlowEvent = Readonly<z.infer<typeof PayFlowEventSchema>>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function eventPayloadBytes(event: PayFlowEvent): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(event)), "utf8");
}

export interface SignedWebhookDelivery {
  readonly deliveryId: string;
  readonly timestamp: string;
  readonly bodyDigest: string;
  readonly signature: string;
}

function signingMessage(
  deliveryId: string,
  timestamp: string,
  bodyDigest: string,
): string {
  return [deliveryId, timestamp, bodyDigest].join("\n");
}

export function signWebhookDelivery(
  event: PayFlowEvent,
  secret: string | Buffer,
  deliveryId: string,
  timestamp: string,
): SignedWebhookDelivery {
  const parsed = PayFlowEventSchema.parse(event);
  const bodyDigest = createHash("sha256")
    .update(eventPayloadBytes(parsed))
    .digest("hex");
  const signature = createHmac("sha256", secret)
    .update(signingMessage(deliveryId, timestamp, bodyDigest), "utf8")
    .digest("base64url");
  return { deliveryId, timestamp, bodyDigest, signature };
}

export function verifyWebhookDelivery(
  event: PayFlowEvent,
  signed: SignedWebhookDelivery,
  secret: string | Buffer,
  now: string,
  maxClockSkewSeconds = 300,
): boolean {
  const parsed = PayFlowEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const deliveryTime = Date.parse(signed.timestamp);
  const currentTime = Date.parse(now);
  if (!Number.isFinite(deliveryTime) || !Number.isFinite(currentTime)) return false;
  if (Math.abs(currentTime - deliveryTime) > maxClockSkewSeconds * 1000) {
    return false;
  }
  const bodyDigest = createHash("sha256")
    .update(eventPayloadBytes(parsed.data))
    .digest("hex");
  if (bodyDigest !== signed.bodyDigest) return false;
  const expected = createHmac("sha256", secret)
    .update(
      signingMessage(signed.deliveryId, signed.timestamp, signed.bodyDigest),
      "utf8",
    )
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signed.signature, "base64url");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export interface WebhookReplayStore {
  claimDelivery(deliveryId: string, expiresAt: string): Promise<boolean>;
}

export async function acceptWebhookDeliveryOnce(
  event: PayFlowEvent,
  signed: SignedWebhookDelivery,
  secret: string | Buffer,
  now: string,
  store: WebhookReplayStore,
): Promise<"ACCEPTED" | "DUPLICATE" | "INVALID"> {
  if (!verifyWebhookDelivery(event, signed, secret, now)) return "INVALID";
  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  return (await store.claimDelivery(signed.deliveryId, expiresAt))
    ? "ACCEPTED"
    : "DUPLICATE";
}
