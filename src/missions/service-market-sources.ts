import type { ServicePackage } from "./service-market.js";

/**
 * V3 M54 — where service packages come from. A source only OBSERVES. The only source that ships is a SANDBOX fixture of FICTIONAL
 * providers; it is refused in PRODUCTION. A live marketplace is a reviewed code change plus the owner's credential, never configuration.
 */
export interface ServiceSource {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "SANDBOX_FIXTURE" | "LIVE_PROVIDER";
  readonly mode: "SANDBOX" | "LIVE";
  readonly credential: "NONE" | "REQUIRED";
  search(query: { category: string }, signal: AbortSignal): Promise<unknown>;
}
const prov = {
  sourceId: "sandbox-services",
  observedAt: "2026-11-01T09:00:00.000Z",
  evidence: "DOCUMENT_REF" as const,
};
const FIXTURE: ServicePackage[] = [
  {
    packageId: "sbx-logo-basic",
    category: "DESIGN",
    providerName: "Northlight Studio (fictional)",
    title: "Logo and one-page style sheet",
    deliverables: ["Logo files", "Colour and type sheet"],
    priceMinor: 90_000,
    currency: "GBP",
    deliveryDays: 10,
    revisionsIncluded: 2,
    refundBeforeStartBps: 10_000,
    provenance: prov,
  },
  {
    packageId: "sbx-logo-premium",
    category: "DESIGN",
    providerName: "Brightfield Design (fictional)",
    title: "Brand identity pack",
    deliverables: ["Logo files", "Style guide", "Social templates"],
    priceMinor: 240_000,
    currency: "GBP",
    deliveryDays: 21,
    revisionsIncluded: 4,
    refundBeforeStartBps: 5_000,
    provenance: prov,
  },
  {
    packageId: "sbx-logo-quick",
    category: "DESIGN",
    providerName: "Pixel Barn (fictional)",
    title: "Logo in three days",
    deliverables: ["Logo files"],
    priceMinor: 40_000,
    currency: "GBP",
    deliveryDays: 3,
    revisionsIncluded: 0,
    refundBeforeStartBps: 0,
    provenance: prov,
  },
  {
    // deliberately incomplete: no price, delivery or refund terms
    packageId: "sbx-logo-vague",
    category: "DESIGN",
    providerName: "Ghost Atelier (fictional)",
    title: "Custom identity (contact us)",
    deliverables: ["Identity work"],
    priceMinor: null,
    currency: "GBP",
    deliveryDays: null,
    revisionsIncluded: null,
    refundBeforeStartBps: null,
    provenance: prov,
  },
  {
    packageId: "sbx-books-month",
    category: "BOOKKEEPING",
    providerName: "Ledgerly (fictional)",
    title: "Monthly bookkeeping",
    deliverables: ["Reconciled accounts"],
    priceMinor: 30_000,
    currency: "GBP",
    deliveryDays: 5,
    revisionsIncluded: 1,
    refundBeforeStartBps: 10_000,
    provenance: prov,
  },
];
export const sandboxServiceSource: ServiceSource = {
  id: "sandbox-services",
  displayName: "Sandbox services (fictional)",
  kind: "SANDBOX_FIXTURE",
  mode: "SANDBOX",
  credential: "NONE",
  search: (q) =>
    Promise.resolve(FIXTURE.filter((p) => p.category === q.category)),
};
