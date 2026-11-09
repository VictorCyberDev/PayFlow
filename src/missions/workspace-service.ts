import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuditLog } from "../network/ops-controls.js";
import type { MissionCaller, MissionService } from "./service.js";
import {
  StaySchema,
  WorkspaceNeedSchema,
  assess,
  parseListings,
  rank,
  type Assessment,
  type WorkspaceListing,
} from "./workspace.js";
import type { WorkspaceSourceRegistry } from "./workspace-sources.js";

/**
 * V3 M51/M52 — searching a workspace source for a mission and comparing what comes back. A search observes; it books nothing, reserves
 * nothing and contacts no one. What a source returns is untrusted, parsed and stored append-only. Assessments are computed on read.
 */
export type WsRefusal =
  | "MALFORMED"
  | "NOT_FOUND"
  | "CAPABILITY_REFUSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "MISSION_NOT_ACTIVE"
  | "PROVIDER_TYPE_NOT_APPROVED"
  | "CURRENCY_MISMATCH"
  | "EXPOSURE_ABOVE_COMMITMENT"
  | "UNKNOWN_SOURCE"
  | "SOURCE_NOT_ALLOWED_HERE"
  | "SOURCE_FAILED";
export type WsResult<T> =
  { ok: true; value: T } | { ok: false; refusal: WsRefusal; detail?: string };

const Idem = z.string().min(16).max(128);
export const SearchSchema = z
  .object({
    sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
    need: WorkspaceNeedSchema,
    stay: StaySchema,
    /** When the owner might cancel: the liability calculator prices cancellation at this moment. */
    cancelAt: z.string().datetime(),
    idempotencyKey: Idem,
  })
  .strict();
const SOURCE_TIMEOUT_MS = 5000;
const sha = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Row = Record<string, unknown>;
const iso = (v: unknown) => new Date(v as string).toISOString();

export const NOTICE =
  "These are observations from a source, not quotes, bookings or reservations. Nothing has been reserved, paid or signed, and no one has been contacted.";

export interface SearchView {
  readonly searchId: string;
  readonly missionId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly searchedAt: string;
  readonly rejected: number;
  readonly truncated: boolean;
  readonly results: readonly {
    listing: WorkspaceListing;
    assessment: Assessment;
  }[];
  readonly notice: string;
}

export class WorkspaceService {
  constructor(
    private readonly deps: {
      sql: Sql;
      audit: AuditLog;
      missions: MissionService;
      sources: WorkspaceSourceRegistry;
      now: () => string;
    },
  ) {}

  sources(caller: Pick<MissionCaller, "environment">) {
    return this.deps.sources.all().map((s) => ({
      id: s.id,
      displayName: s.displayName,
      kind: s.kind,
      mode: s.mode,
      credential: s.credential,
      dataUse: s.dataUse,
      available:
        !(s.mode === "SANDBOX" && caller.environment === "PRODUCTION") &&
        s.credential === "NONE",
    }));
  }

  private async log(
    c: MissionCaller,
    action: string,
    id: string,
    detail: Record<string, string | number>,
    now: string,
  ) {
    await this.deps.audit
      .append({
        organizationId: c.organizationId,
        environment: c.environment,
        actorKind: c.kind === "MEMBER" ? "MEMBER" : "AGENT_CREDENTIAL",
        actorId: c.id,
        action,
        subjectKind: "MISSION_WORKSPACE_SEARCH",
        subjectId: id,
        detail,
        occurredAt: now,
      })
      .catch(() => undefined);
  }

  private view(s: Row, listings: Row[]): SearchView {
    const need = WorkspaceNeedSchema.parse(s.need);
    const stay = StaySchema.parse(s.stay);
    const cancelAt = iso(s.cancel_at);
    const byId = new Map(
      listings.map((r) => [
        String(r.listing_id),
        r.document as WorkspaceListing,
      ]),
    );
    const ranked = rank(
      [...byId.values()].map((l) => assess(l, need, stay, cancelAt)),
    );
    return {
      searchId: String(s.search_id),
      missionId: String(s.mission_id),
      sourceId: String(s.source_id),
      sourceKind: String(s.source_kind),
      searchedAt: iso(s.searched_at),
      rejected: Number(s.rejected),
      truncated: Boolean(s.truncated),
      results: ranked.map((a) => ({
        listing: byId.get(a.listingId)!,
        assessment: a,
      })),
      notice: NOTICE,
    };
  }

  async search(
    caller: MissionCaller,
    missionId: string,
    rawBody: unknown,
  ): Promise<WsResult<{ search: SearchView; replayed: boolean }>> {
    const b = SearchSchema.safeParse(rawBody);
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
    const sql = this.deps.sql;
    const digest = sha(b.data);
    const [prior] =
      await sql`select * from mission_workspace_searches where mission_id = ${missionId} and searched_by = ${caller.id} and idempotency_key = ${b.data.idempotencyKey}`;
    if (prior) {
      if (prior.request_digest !== digest)
        return { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
      const ls =
        await sql`select * from mission_workspace_listings where search_id = ${String(prior.search_id)}`;
      return {
        ok: true,
        value: { search: this.view(prior, ls), replayed: true },
      };
    }
    if (m.value.status !== "ACTIVE")
      return {
        ok: false,
        refusal: "MISSION_NOT_ACTIVE",
        detail: m.value.status,
      };
    const contract = m.value.activeContract!;
    if (!contract.approvedProviderTypes.includes("WORKSPACE_PROVIDER"))
      return { ok: false, refusal: "PROVIDER_TYPE_NOT_APPROVED" };
    if (b.data.need.currency !== contract.currency)
      return { ok: false, refusal: "CURRENCY_MISMATCH" };
    // The owner's per-workspace exposure limit may not exceed what the mission may commit at once.
    if (b.data.need.maxExposureMinor > contract.maxCommitmentMinor)
      return { ok: false, refusal: "EXPOSURE_ABOVE_COMMITMENT" };
    const src = this.deps.sources.get(b.data.sourceId);
    if (!src) return { ok: false, refusal: "UNKNOWN_SOURCE" };
    if (
      (src.mode === "SANDBOX" && caller.environment === "PRODUCTION") ||
      src.credential !== "NONE"
    )
      return { ok: false, refusal: "SOURCE_NOT_ALLOWED_HERE" };
    let raw: unknown;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SOURCE_TIMEOUT_MS);
    try {
      raw = await Promise.race([
        src.search(
          { country: b.data.need.country, city: b.data.need.city },
          ctl.signal,
        ),
        new Promise<never>((_r, rej) =>
          ctl.signal.addEventListener("abort", () => rej(new Error("TIMEOUT"))),
        ),
      ]);
    } catch {
      return { ok: false, refusal: "SOURCE_FAILED" };
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseListings(raw);
    const now = this.deps.now();
    const id = `wsq_${randomBytes(12).toString("hex")}`;
    // The search and its listings are one transaction: a search never exists without all the listings it parsed.
    const stored = await sql.begin(async (tx) => {
      const [row] = await tx`insert into mission_workspace_searches
        (search_id, mission_id, source_id, source_kind, need, stay, cancel_at, rejected, truncated, searched_by_kind, searched_by, idempotency_key, request_digest, searched_at)
        values (${id}, ${missionId}, ${src.id}, ${src.kind}, ${tx.json(b.data.need)}, ${tx.json(b.data.stay)}, ${b.data.cancelAt}, ${parsed.rejected}, ${parsed.truncated},
          ${caller.kind}, ${caller.id}, ${b.data.idempotencyKey}, ${digest}, ${now})
        on conflict do nothing returning *`;
      if (!row) return null;
      const ls: Row[] = [];
      for (const l of parsed.listings) {
        const [lr] =
          await tx`insert into mission_workspace_listings (search_id, listing_id, document, document_digest, observed_at)
          values (${id}, ${l.listingId}, ${tx.json(l)}, ${sha(l)}, ${l.provenance.observedAt}) returning *`;
        ls.push(lr!);
      }
      return { row, ls };
    });
    if (!stored) return { ok: false, refusal: "IDEMPOTENCY_KEY_REUSED" };
    await this.log(
      caller,
      "WORKSPACE_SEARCHED",
      id,
      { found: parsed.listings.length, rejected: parsed.rejected },
      now,
    );
    return {
      ok: true,
      value: { search: this.view(stored.row, stored.ls), replayed: false },
    };
  }

  /** The newest searches of a mission with their listings and live assessments. */
  async list(
    caller: MissionCaller,
    missionId: string,
  ): Promise<WsResult<{ searches: SearchView[] }>> {
    const m = await this.deps.missions.get(caller, missionId);
    if (!m.ok) return { ok: false, refusal: "NOT_FOUND" };
    if (caller.kind === "AGENT") {
      const a = await this.deps.missions.authorizeCapability(
        caller,
        missionId,
        caller.id,
        "READ",
      );
      if (!a.allowed)
        return { ok: false, refusal: "CAPABILITY_REFUSED", detail: a.reason };
    }
    const rows = await this.deps
      .sql`select * from mission_workspace_searches where mission_id = ${missionId} order by searched_at desc, search_id limit 10`;
    const out: SearchView[] = [];
    for (const s of rows) {
      const ls = await this.deps
        .sql`select * from mission_workspace_listings where search_id = ${String(s.search_id)}`;
      out.push(this.view(s, ls));
    }
    return { ok: true, value: { searches: out } };
  }
}
