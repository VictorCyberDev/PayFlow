/**
 * V3 M37 — how a message leaves PayFlow. A channel adapter sends ONE message and says what happened:
 *  - it returns a reference when the provider accepted it;
 *  - it throws `DefinitiveSendError` only when it is certain nothing was sent;
 *  - anything else (a timeout, a dropped connection, an error after the request left) means "unknown", and PayFlow records
 *    DELIVERY_UNKNOWN rather than guess. A person resolves it.
 * The only channel that ships is the SANDBOX one, which sends nothing anywhere. A live provider needs the owner to choose it and
 * supply its credential (a code change and review, never configuration).
 */
export interface OutgoingMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** The message id: the provider must treat a repeat of it as the same message. */
  readonly idempotencyKey: string;
}
export class DefinitiveSendError extends Error {}
export interface ChannelAdapter {
  readonly id: string;
  readonly channel: "EMAIL";
  readonly mode: "SANDBOX" | "LIVE";
  send(message: OutgoingMessage, signal: AbortSignal): Promise<{ ref: string }>;
}
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  register(a: ChannelAdapter): this {
    if (this.adapters.has(a.channel)) throw new Error("CHANNEL_DUPLICATE");
    this.adapters.set(a.channel, a);
    return this;
  }
  for(channel: string): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }
}
/** Sends nothing to anyone; used to exercise the whole flow in a sandbox. Refused in PRODUCTION. */
export const sandboxEmailChannel: ChannelAdapter = {
  id: "sandbox-email",
  channel: "EMAIL",
  mode: "SANDBOX",
  send: (m) => Promise.resolve({ ref: `sandbox:${m.idempotencyKey}` }),
};
export const builtinChannels = () =>
  new ChannelRegistry().register(sandboxEmailChannel);
