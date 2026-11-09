import type { WorkspaceListing } from "./workspace.js";

/**
 * V3 M51 — where workspace listings come from. A source only OBSERVES. What it returns is untrusted and parsed by `parseListings`.
 * The only source that ships is a SANDBOX fixture of FICTIONAL workspaces; it is refused in PRODUCTION and is labelled as such everywhere
 * it is shown. A live provider is a reviewed code change plus the owner's credential — never configuration — and until one exists
 * the honest answer to "real availability and price" is "no live source is connected".
 */
export interface WorkspaceSource {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "SANDBOX_FIXTURE" | "LIVE_PROVIDER";
  readonly mode: "SANDBOX" | "LIVE";
  readonly credential: "NONE" | "REQUIRED";
  readonly dataUse: string;
  search(
    query: { country: string; city: string; text?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class WorkspaceSourceRegistry {
  private readonly m = new Map<string, WorkspaceSource>();
  register(s: WorkspaceSource): this {
    this.m.set(s.id, s);
    return this;
  }
  get(id: string): WorkspaceSource | undefined {
    return this.m.get(id);
  }
  all(): WorkspaceSource[] {
    return [...this.m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

const prov = (url: string | null = null): WorkspaceListing["provenance"] => ({
  sourceId: "sandbox-workspaces",
  observedAt: "2026-11-01T09:00:00.000Z",
  evidence: "DOCUMENT_REF",
  url,
});
const open = [
  { start: "2026-12-01T00:00:00.000Z", end: "2027-03-31T00:00:00.000Z" },
];
/** Fictional. Includes deliberately incomplete records (unknown deposit, unknown availability) so the UNKNOWN paths are exercised. */
const FIXTURE: WorkspaceListing[] = [
  {
    listingId: "sbx-harbour-office",
    kind: "PRIVATE_OFFICE",
    name: "Harbour Studio (fictional)",
    locality: { country: "GB", city: "Bristol" },
    capacity: 8,
    rate: { basis: "DAILY", minor: 12_000, currency: "GBP" },
    depositMinor: 50_000,
    feesMinor: 2_500,
    minTermDays: 7,
    cancellation: {
      policy: "FREE_UNTIL",
      freeHoursBeforeStart: 48,
      penaltyBps: 5_000,
    },
    amenities: ["Wi-Fi", "Kitchen", "Meeting room access"],
    availableWindows: open,
    provenance: prov(),
  },
  {
    listingId: "sbx-castle-desks",
    kind: "DESK",
    name: "Castle Desks (fictional)",
    locality: { country: "GB", city: "Bristol" },
    capacity: 20,
    rate: { basis: "MONTHLY", minor: 28_000, currency: "GBP" },
    depositMinor: 28_000,
    feesMinor: 0,
    minTermDays: 30,
    cancellation: { policy: "NON_REFUNDABLE" },
    amenities: ["Wi-Fi", "Printing"],
    availableWindows: open,
    provenance: prov(),
  },
  {
    listingId: "sbx-quay-room",
    kind: "MEETING_ROOM",
    name: "Quay Meeting Room (fictional)",
    locality: { country: "GB", city: "Bristol" },
    capacity: 10,
    rate: { basis: "HOURLY", minor: 4_500, currency: "GBP" },
    depositMinor: 0,
    feesMinor: 0,
    minTermDays: 0,
    cancellation: {
      policy: "FREE_UNTIL",
      freeHoursBeforeStart: 24,
      penaltyBps: 10_000,
    },
    amenities: ["Wi-Fi", "Screen"],
    availableWindows: open,
    provenance: prov(),
  },
  {
    listingId: "sbx-mill-office",
    kind: "PRIVATE_OFFICE",
    name: "Mill Offices (fictional)",
    locality: { country: "GB", city: "Bristol" },
    capacity: 6,
    rate: { basis: "DAILY", minor: 9_000, currency: "GBP" },
    depositMinor: null,
    feesMinor: null,
    minTermDays: null,
    cancellation: { policy: "UNKNOWN" },
    amenities: ["Wi-Fi"],
    availableWindows: null,
    provenance: prov(),
  },
  {
    listingId: "sbx-leeds-office",
    kind: "PRIVATE_OFFICE",
    name: "Leeds Loft (fictional)",
    locality: { country: "GB", city: "Leeds" },
    capacity: 6,
    rate: { basis: "DAILY", minor: 8_000, currency: "GBP" },
    depositMinor: 20_000,
    feesMinor: 0,
    minTermDays: 1,
    cancellation: { policy: "NON_REFUNDABLE" },
    amenities: ["Wi-Fi"],
    availableWindows: open,
    provenance: prov(),
  },
];
export const sandboxWorkspaceSource: WorkspaceSource = {
  id: "sandbox-workspaces",
  displayName: "Sandbox workspaces (fictional)",
  kind: "SANDBOX_FIXTURE",
  mode: "SANDBOX",
  credential: "NONE",
  dataUse:
    "Fictional listings for testing. Not real spaces, prices or availability.",
  search: (q) =>
    Promise.resolve(
      FIXTURE.filter(
        (l) =>
          l.locality.country === q.country &&
          l.locality.city.toLowerCase() === q.city.toLowerCase(),
      ),
    ),
};
export const builtinWorkspaceSources = () =>
  new WorkspaceSourceRegistry().register(sandboxWorkspaceSource);
