import { z } from "zod";
import { channel3ProductConnector } from "./channel3-provider.js";
import { demoCommerceCatalog } from "../demo-commerce-catalog.js";
import { PROVIDER_TYPES, type ProviderType } from "./contract.js";

/**
 * V3 M31 — connector definitions. A connector is a governed, READ-ONLY way for a mission's agent to observe the outside world.
 *
 * What a connector may do is fixed here, in code, not by configuration:
 *  - it can only observe (search, read, compare, status, verify). Capabilities that move money, send messages or sign are not
 *    in `OBSERVE_CAPABILITIES`, so no definition can claim them and nothing can invoke them through this framework;
 *  - whatever an adapter returns is untrusted: it is bounded, parsed against `ConnectorResultSchema` and labelled an observation
 *    ("not a quote, not a commitment") before anyone sees it;
 *  - a SANDBOX connector can never be installed in PRODUCTION, and a LIVE connector must say what credential it needs.
 */
export const OBSERVE_CAPABILITIES = [
  "SEARCH",
  "READ",
  "COMPARE",
  "STATUS",
  "VERIFY",
] as const;
export type ObserveCapability = (typeof OBSERVE_CAPABILITIES)[number];
export const isObserveCapability = (c: string): c is ObserveCapability =>
  (OBSERVE_CAPABILITIES as readonly string[]).includes(c);

export interface ConnectorLimits {
  readonly maxRecords: number;
  readonly maxResultBytes: number;
  readonly timeoutMs: number;
  /** Calls per mission per connector per rolling hour. */
  readonly callsPerHour: number;
}
export interface ConnectorAdapter {
  /** Whatever it returns is UNTRUSTED. It must stop when `signal` aborts. */
  observe(
    request: { capability: ObserveCapability; query: ConnectorQuery },
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface ConnectorDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly providerTypes: readonly ProviderType[];
  /** SANDBOX connectors reach only fictional/sandbox data and are refused in PRODUCTION. */
  readonly mode: "SANDBOX" | "LIVE";
  readonly capabilities: readonly ObserveCapability[];
  /** REQUIRED: the install must carry a credential reference before it can be used. */
  readonly credential: "NONE" | "REQUIRED";
  /** What the data may be used for, in plain words. Shown to the owner before enabling. */
  readonly dataUse: string;
  readonly limits: ConnectorLimits;
  readonly adapter: ConnectorAdapter;
}

export const ConnectorQuerySchema = z
  .object({
    text: z.string().trim().min(1).max(512).optional(),
    recordId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict()
  .refine((q) => q.text !== undefined || q.recordId !== undefined, {
    message: "text or recordId is required",
  });
export type ConnectorQuery = z.infer<typeof ConnectorQuerySchema>;

const Claim = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
export const ConnectorRecordSchema = z
  .object({
    recordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    kind: z.enum(["OFFER", "PRODUCT", "PROVIDER", "STATUS"]),
    title: z.string().min(1).max(200),
    priceObservation: z
      .object({
        minor: z.number().int().safe().min(0).max(1_000_000_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/u),
      })
      .strict()
      .nullable(),
    availableQuantity: z.number().int().safe().min(0).max(1_000_000).nullable(),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password;
      })
      .nullable(),
    observedAt: z.string().datetime(),
    claims: z
      .record(z.string().max(64), Claim)
      .refine((c) => Object.keys(c).length <= 16, "at most 16 claims"),
  })
  .strict();
export type ConnectorRecord = z.infer<typeof ConnectorRecordSchema>;
export const ConnectorResultSchema = z
  .object({ records: z.array(ConnectorRecordSchema).max(50) })
  .strict();

/** What the framework hands back for a successful call. The label is part of the data, not decoration. */
export interface ConnectorObservation {
  readonly connectorId: string;
  readonly mode: "SANDBOX" | "LIVE";
  readonly capability: ObserveCapability;
  readonly trust: "UNTRUSTED_OBSERVATION";
  readonly notice: string;
  readonly records: readonly ConnectorRecord[];
}
export const OBSERVATION_NOTICE =
  "Observed data from a connector. It is not a quote, not a commitment and not verified by PayFlow.";

export function validateDefinition(d: ConnectorDefinition): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(d.id)) problems.push("BAD_ID");
  if (d.displayName.trim().length === 0 || d.displayName.length > 80)
    problems.push("BAD_NAME");
  if (d.providerTypes.length === 0) problems.push("NO_PROVIDER_TYPE");
  if (d.providerTypes.some((t) => !PROVIDER_TYPES.includes(t)))
    problems.push("UNKNOWN_PROVIDER_TYPE");
  if (d.capabilities.length === 0) problems.push("NO_CAPABILITY");
  if (
    (d.capabilities as readonly string[]).some((c) => !isObserveCapability(c))
  )
    problems.push("NOT_OBSERVE_ONLY");
  if (d.dataUse.trim().length < 10) problems.push("DATA_USE_UNSTATED");
  const l = d.limits;
  if (!(
    l.maxRecords >= 1 &&
    l.maxRecords <= 50 &&
    l.maxResultBytes >= 1024 &&
    l.maxResultBytes <= 262_144 &&
    l.timeoutMs >= 100 &&
    l.timeoutMs <= 30_000 &&
    l.callsPerHour >= 1 &&
    l.callsPerHour <= 10_000
  ))
    problems.push("BAD_LIMITS");
  return problems;
}

export class ConnectorRegistry {
  private readonly defs = new Map<string, ConnectorDefinition>();
  register(d: ConnectorDefinition): this {
    const problems = validateDefinition(d);
    if (problems.length)
      throw new Error(`CONNECTOR_INVALID:${problems.join(",")}`);
    if (this.defs.has(d.id)) throw new Error("CONNECTOR_DUPLICATE");
    this.defs.set(d.id, Object.freeze({ ...d }));
    return this;
  }
  get(id: string): ConnectorDefinition | undefined {
    return this.defs.get(id);
  }
  list(): ConnectorDefinition[] {
    return [...this.defs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

/**
 * The sandbox catalogue that ships with PayFlow (fictional keyboards from the demo merchant). It is real in the sense that it is
 * the same catalogue the sandbox checkout sells from, and fictional in the sense that no real merchant stands behind it. It is
 * labelled SANDBOX and refused in PRODUCTION.
 */
export const DEMO_CATALOG_CONNECTOR_ID = "payflow-demo-catalog";
export function demoCatalogConnector(now: () => string): ConnectorDefinition {
  return {
    id: DEMO_CATALOG_CONNECTOR_ID,
    displayName: "PayFlow demo catalogue (sandbox)",
    providerTypes: ["COMMERCE_MARKETPLACE"],
    mode: "SANDBOX",
    capabilities: ["SEARCH", "READ", "COMPARE"],
    credential: "NONE",
    dataUse:
      "Fictional sandbox products for testing agent workflows. Prices and stock are not real and cannot be bought from a real merchant.",
    limits: {
      maxRecords: 20,
      maxResultBytes: 65_536,
      timeoutMs: 2_000,
      callsPerHour: 120,
    },
    adapter: {
      observe: (request) => {
        const observedAt = now();
        const words = (request.query.text ?? "")
          .toLowerCase()
          .split(/\s+/u)
          .filter(Boolean);
        const records = demoCommerceCatalog()
          .offers.filter((o) => {
            if (request.query.recordId !== undefined)
              return o.offerId === request.query.recordId;
            const hay =
              `${o.title} ${o.sku} ${o.variant.switchType} ${o.variant.finish} ${o.condition}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          })
          .slice(0, request.query.limit)
          .map((o) => ({
            recordId: o.offerId,
            kind: "OFFER" as const,
            title: o.title,
            priceObservation: {
              minor: o.unitPrice.minor,
              currency: o.unitPrice.currency,
            },
            availableQuantity: o.availableQuantity,
            url: null,
            observedAt,
            claims: {
              sku: o.sku,
              condition: o.condition,
              switchType: o.variant.switchType,
              finish: o.variant.finish,
              layout: o.variant.layout,
              merchantId: o.merchantId,
            },
          }));
        return Promise.resolve({ records });
      },
    },
  };
}

export function builtinRegistry(
  now: () => string,
  channel3ApiKey?: string,
): ConnectorRegistry {
  const registry = new ConnectorRegistry().register(demoCatalogConnector(now));
  // The operator's own API key is never sent to a browser or stored as a customer credential.
  // Installing a connector still requires the organization's explicit acknowledgement of data use.
  if (channel3ApiKey)
    registry.register(channel3ProductConnector(channel3ApiKey, now));
  return registry;
}
