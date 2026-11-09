import type { MissionCaller, MissionService } from "./service.js";
import {
  ServiceNeedSchema,
  assessPackage,
  parsePackages,
  rankPackages,
  type ServiceAssessment,
  type ServicePackage,
} from "./service-market.js";
import type { ServiceSource } from "./service-market-sources.js";
import { z } from "zod";

export type SmRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "MISSION_NOT_ACTIVE"
  | "PROVIDER_TYPE_NOT_APPROVED"
  | "CURRENCY_MISMATCH"
  | "PRICE_ABOVE_COMMITMENT"
  | "UNKNOWN_SOURCE"
  | "SOURCE_NOT_ALLOWED_HERE"
  | "SOURCE_FAILED";
export type SmResult<T> =
  { ok: true; value: T } | { ok: false; refusal: SmRefusal; detail?: string };

const NOTICE =
  "These are observations from a source, not quotes, engagements or purchases. Nothing has been bought, paid or signed, and no provider has been contacted.";
const Body = z
  .object({ sourceId: z.string().min(1).max(128), need: ServiceNeedSchema })
  .strict();
const TIMEOUT_MS = 5_000;

export interface ServiceSearchView {
  readonly sourceId: string;
  readonly sourceKind: ServiceSource["kind"];
  readonly rejected: number;
  readonly truncated: boolean;
  readonly results: {
    package: ServicePackage;
    assessment: ServiceAssessment;
  }[];
  readonly notice: string;
}

/** Looks only. A search stores nothing, reserves nothing and contacts no one; it is a read through an untrusted source. */
export class ServiceMarketService {
  constructor(
    private readonly deps: {
      missions: MissionService;
      sources: ReadonlyMap<string, ServiceSource>;
    },
  ) {}
  sources(caller: Pick<MissionCaller, "environment">) {
    return [...this.deps.sources.values()]
      .filter(
        (s) => !(s.mode === "SANDBOX" && caller.environment === "PRODUCTION"),
      )
      .map((s) => ({ id: s.id, displayName: s.displayName, kind: s.kind }));
  }
  async search(
    caller: MissionCaller,
    missionId: string,
    raw: unknown,
  ): Promise<SmResult<ServiceSearchView>> {
    const b = Body.safeParse(raw);
    if (!b.success)
      return {
        ok: false,
        refusal: "MALFORMED",
        detail: b.error.issues
          .slice(0, 2)
          .map((i) => i.path.join("."))
          .join(","),
      };
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "SEARCH",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    if (m.value.status !== "ACTIVE")
      return {
        ok: false,
        refusal: "MISSION_NOT_ACTIVE",
        detail: m.value.status,
      };
    const c = m.value.activeContract!;
    if (!c.approvedProviderTypes.includes("PROFESSIONAL_SERVICES"))
      return { ok: false, refusal: "PROVIDER_TYPE_NOT_APPROVED" };
    if (b.data.need.currency !== c.currency)
      return { ok: false, refusal: "CURRENCY_MISMATCH" };
    if (b.data.need.maxPriceMinor > c.maxCommitmentMinor)
      return { ok: false, refusal: "PRICE_ABOVE_COMMITMENT" };
    const src = this.deps.sources.get(b.data.sourceId);
    if (!src) return { ok: false, refusal: "UNKNOWN_SOURCE" };
    if (
      (src.mode === "SANDBOX" && caller.environment === "PRODUCTION") ||
      src.credential !== "NONE"
    )
      return { ok: false, refusal: "SOURCE_NOT_ALLOWED_HERE" };
    let out: unknown;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      out = await Promise.race([
        src.search({ category: b.data.need.category }, ctl.signal),
        new Promise<never>((_r, rej) =>
          ctl.signal.addEventListener("abort", () => rej(new Error("TIMEOUT"))),
        ),
      ]);
    } catch {
      return { ok: false, refusal: "SOURCE_FAILED" };
    } finally {
      clearTimeout(timer);
    }
    const parsed = parsePackages(out);
    const assessed = parsed.packages.map((p) => ({
      p,
      a: assessPackage(p, b.data.need),
    }));
    const order = rankPackages(assessed.map((x) => x.a));
    const byId = new Map(assessed.map((x) => [x.p.packageId, x]));
    return {
      ok: true,
      value: {
        sourceId: src.id,
        sourceKind: src.kind,
        rejected: parsed.rejected,
        truncated: parsed.truncated,
        results: order.map((a) => ({
          package: byId.get(a.packageId)!.p,
          assessment: a,
        })),
        notice: NOTICE,
      },
    };
  }
}
