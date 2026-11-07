import type { Credential, StatusList } from "../../verifier/src/authority.js";

/**
 * Client for the organization-member API of a PayFlow host: issuing, listing and revoking portable Authority
 * credentials. It uses a MEMBER token (never an agent credential, never the operator token): the server decides what the
 * member's role allows. The client sends a holder PUBLIC key and a narrowing request; it cannot ask for more than the
 * stored Authority allows, and a refusal is returned as data with the server's reason.
 */
export interface PayFlowMemberClientOptions {
  readonly baseUrl: string;
  readonly memberToken: string;
  readonly fetch?: typeof globalThis.fetch;
}
export interface IssueCredentialInput {
  /** The agent's Ed25519 public key (JWK). Never send a private key. */
  readonly holder: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** Retrying with the same key and request returns the same credential. 16-128 characters. */
  readonly idempotencyKey: string;
  readonly audience?: readonly string[];
  readonly counterpartyIds?: readonly string[];
  readonly maxAmountMinor?: number;
  readonly ttlSeconds?: number;
  readonly maxDepth?: number;
}
export type IssueCredentialResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly credentialId: string;
      readonly authorityId: string;
      readonly expiresAt: string;
      readonly credential: Credential;
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly recoverable: boolean;
    };
export interface DelegationView {
  readonly delegationId: string;
  readonly authorityId: string | null;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly depth: number;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  readonly status:
    "ACTIVE" | "REVOKED" | "EXPIRED" | "ANCESTOR_REVOKED" | "ANCESTOR_EXPIRED";
  readonly own: {
    readonly actionKinds: readonly string[];
    readonly currencies: readonly string[];
    readonly counterpartyIds: readonly string[];
    readonly maxAmountMinor: number;
    readonly spentMinor: number;
    readonly expiresAt: string;
  };
  /** What this agent can actually do: the intersection of every hop above it. */
  readonly effective: {
    readonly actionKinds: readonly string[];
    readonly currencies: readonly string[];
    readonly counterpartyIds: readonly string[];
    readonly perActionMaxMinor: number;
    readonly remainingBudgetMinor: number;
    readonly expiresAt: string;
  };
  readonly lineage: readonly {
    readonly delegationId: string;
    readonly childAgentId: string;
    readonly depth: number;
    readonly revoked: boolean;
  }[];
  readonly childIds: readonly string[];
}
export interface RootDelegationInput {
  readonly childAgentId: string;
  /** Cannot exceed the stored Authority's cumulative limit. Currency, action and merchants come from storage. */
  readonly budgetMinor: number;
  readonly counterpartyIds?: readonly string[];
  readonly ttlSeconds?: number;
  readonly idempotencyKey: string;
}
export interface HopDelegationInput {
  readonly childAgentId: string;
  /** Every field is optional and can only NARROW the parent; omitted fields inherit it. */
  readonly maxAmountMinor?: number;
  readonly counterpartyIds?: readonly string[];
  readonly currencies?: readonly string[];
  readonly actionKinds?: readonly string[];
  readonly ttlSeconds?: number;
  readonly idempotencyKey: string;
}
export type DelegationResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly delegationId: string;
      readonly delegation: DelegationView;
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly recoverable: boolean;
    };
const asDelegation = (
  status: number,
  json: Record<string, unknown>,
): DelegationResult =>
  status === 200 || status === 201
    ? {
        ok: true,
        replayed: json.replayed === true,
        delegationId: String(json.delegationId),
        delegation: json.delegation as DelegationView,
      }
    : {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        recoverable: json.recoverable === true,
      };

/**
 * A delegating AGENT's client: it authenticates with the agent's own credential and can extend only a delegation it
 * holds, and only by narrowing it.
 */
export class PayFlowAgentDelegationClient {
  private readonly doFetch: typeof globalThis.fetch;
  constructor(
    private readonly options: {
      baseUrl: string;
      agentToken: string;
      fetch?: typeof globalThis.fetch;
    },
  ) {
    this.doFetch = options.fetch ?? fetch;
  }
  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await this.doFetch(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.agentToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      json: (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >,
    };
  }
  async delegate(
    parentId: string,
    input: HopDelegationInput,
  ): Promise<DelegationResult> {
    const r = await this.call(
      "POST",
      `/v1/agent/delegations/${encodeURIComponent(parentId)}/hops`,
      input,
    );
    return asDelegation(r.status, r.json);
  }
  async inspect(delegationId: string): Promise<DelegationView | null> {
    const r = await this.call(
      "GET",
      `/v1/agent/delegations/${encodeURIComponent(delegationId)}`,
    );
    return r.status === 200 ? (r.json.delegation as DelegationView) : null;
  }
}

// ------------------------------------------------------------------------------------------------ missions (V3 M26)
export type MissionStatus =
  | "DRAFT"
  | "PENDING_OWNER_APPROVAL"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";
export type MissionCapability =
  | "SEARCH"
  | "READ"
  | "COMPARE"
  | "DRAFT"
  | "COMMUNICATE"
  | "NEGOTIATE"
  | "REQUEST_APPROVAL"
  | "RESERVE"
  | "CONTRACT"
  | "PURCHASE"
  | "REFUND_REQUEST"
  | "STATUS"
  | "VERIFY";
/** The Mission Contract v1 document. Money is an integer count of minor units. */
export interface MissionContractInput {
  readonly objective: string;
  readonly description?: string;
  readonly intendedOutcome: string;
  readonly successCriteria: readonly string[];
  readonly businessContext?: string;
  readonly country?: string;
  readonly currency: string;
  readonly totalBudgetMinor: number;
  readonly maxCommitmentMinor: number;
  readonly spendingCategories?: readonly string[];
  readonly approvedProviderTypes?: readonly string[];
  readonly merchantRestrictions?:
    | { mode: "NONE_ALLOWED" }
    | { mode: "ANY" }
    | { mode: "ONLY"; ids: readonly string[] };
  readonly agents?: readonly {
    agentId: string;
    capabilities: readonly MissionCapability[];
  }[];
  readonly approvalConditions?: {
    humanApprovalAboveMinor?: number;
    requireApprovalToNegotiate?: boolean;
    requireApprovalToContract?: boolean;
  };
  readonly priority?: "LOW" | "NORMAL" | "HIGH";
  readonly riskTier?: "LOW" | "MEDIUM" | "HIGH";
  readonly expiresAt: string;
}
export interface MissionView {
  readonly missionId: string;
  readonly status: MissionStatus;
  readonly latestVersion: number;
  readonly activeVersion: number | null;
  readonly pendingVersion: number | null;
  readonly rowVersion: number;
  readonly activeContract: MissionContractInput | null;
  readonly pendingContract: MissionContractInput | null;
  readonly pendingReasons: readonly string[];
  readonly latestContract: MissionContractInput;
}
export type MissionResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly mission: MissionView;
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly detail?: string;
    };
const asMission = (
  status: number,
  json: Record<string, unknown>,
): MissionResult =>
  status >= 200 && status < 300 && json.mission
    ? {
        ok: true,
        replayed: status === 200,
        mission: json.mission as MissionView,
      }
    : {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        ...(typeof json.detail === "string" ? { detail: json.detail } : {}),
      };
export interface AgentMissionView {
  readonly missionId: string;
  readonly version: number;
  readonly objective: string;
  readonly intendedOutcome: string;
  readonly successCriteria: readonly string[];
  readonly currency: string;
  readonly expiresAt: string;
  /** The capabilities THIS agent holds on this mission, and nothing about anyone else's. */
  readonly myCapabilities: readonly MissionCapability[];
}

/** An agent's view of its missions. It can read what it is assigned and PROPOSE a revision; it can never approve one. */
export class PayFlowAgentMissionClient {
  private readonly doFetch: typeof globalThis.fetch;
  constructor(
    private readonly options: {
      baseUrl: string;
      agentToken: string;
      fetch?: typeof globalThis.fetch;
    },
  ) {
    this.doFetch = options.fetch ?? fetch;
  }
  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await this.doFetch(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.agentToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      json: (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >,
    };
  }
  async list(): Promise<readonly AgentMissionView[]> {
    const r = await this.call("GET", "/v1/agent/missions");
    return (r.json.missions ?? []) as AgentMissionView[];
  }
  async get(missionId: string): Promise<AgentMissionView | null> {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}`,
    );
    return r.status === 200 ? (r.json.mission as AgentMissionView) : null;
  }
  /** Always waits for an owner; the result's `applied` is false. */
  async propose(
    missionId: string,
    input: {
      baseVersion: number;
      contract: MissionContractInput;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/revisions`,
      input,
    );
    return asMission(r.status, r.json);
  }
}

export interface CredentialSummary {
  readonly credentialId: string;
  readonly authorityId: string;
  readonly agentId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED" | "AUTHORITY_REVOKED";
  readonly audience: readonly string[] | null;
  readonly maxAmountMinor: number;
}

export class PayFlowMemberClient {
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: PayFlowMemberClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await this.request(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.options.memberToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  readonly credentials = {
    /** Issue a credential from a STORED Authority. The server reads the Authority; the request can only narrow it. */
    issue: async (
      authorityId: string,
      input: IssueCredentialInput,
    ): Promise<IssueCredentialResult> => {
      const { status, json } = await this.call(
        "POST",
        `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/credentials`,
        input,
      );
      if (status === 200 || status === 201)
        return {
          ok: true,
          replayed: json.replayed === true,
          credentialId: String(json.credentialId),
          authorityId: String(json.authorityId),
          expiresAt: String(json.expiresAt),
          credential: json.credential as Credential,
        };
      return {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        recoverable: json.recoverable === true,
      };
    },
    list: async (
      authorityId?: string,
    ): Promise<readonly CredentialSummary[]> => {
      const { json } = await this.call(
        "GET",
        authorityId
          ? `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/credentials`
          : "/v1/admin/org/credentials",
      );
      return (json.credentials ?? []) as CredentialSummary[];
    },
    revoke: async (
      credentialId: string,
      reason: string,
    ): Promise<{ found: boolean; alreadyRevoked: boolean }> => {
      const { status, json } = await this.call(
        "POST",
        `/v1/admin/org/credentials/${encodeURIComponent(credentialId)}/revoke`,
        { reason },
      );
      return {
        found: status === 200,
        alreadyRevoked: json.alreadyRevoked === true,
      };
    },
  };

  readonly delegations = {
    /** Root a delegation chain in a STORED Authority. The budget can never exceed what the Authority already allows. */
    createRoot: async (
      authorityId: string,
      input: RootDelegationInput,
    ): Promise<DelegationResult> => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/delegations`,
        input,
      );
      return asDelegation(r.status, r.json);
    },
    /** Extend a delegation on behalf of the organization. Narrowing only. */
    delegate: async (
      parentId: string,
      input: HopDelegationInput,
    ): Promise<DelegationResult> => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/delegations/${encodeURIComponent(parentId)}/hops`,
        input,
      );
      return asDelegation(r.status, r.json);
    },
    inspect: async (delegationId: string): Promise<DelegationView | null> => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/delegations/${encodeURIComponent(delegationId)}`,
      );
      return r.status === 200 ? (r.json.delegation as DelegationView) : null;
    },
    list: async (authorityId: string): Promise<readonly DelegationView[]> => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/delegations`,
      );
      return (r.json.delegations ?? []) as DelegationView[];
    },
    revoke: async (
      delegationId: string,
      reason: string,
    ): Promise<{ found: boolean; alreadyRevoked: boolean }> => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/delegations/${encodeURIComponent(delegationId)}/revoke`,
        { reason },
      );
      return {
        found: r.status === 200,
        alreadyRevoked: r.json.alreadyRevoked === true,
      };
    },
  };

  readonly missions = {
    create: async (
      contract: MissionContractInput,
      idempotencyKey: string,
    ): Promise<MissionResult> => {
      const r = await this.call("POST", "/v1/admin/org/missions", {
        contract,
        idempotencyKey,
      });
      return asMission(r.status, r.json);
    },
    get: async (missionId: string): Promise<MissionView | null> => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}`,
      );
      return r.status === 200
        ? ((r.json.mission as MissionView) ?? null)
        : null;
    },
    list: async (
      filter: { status?: MissionStatus; limit?: number; after?: string } = {},
    ) => {
      const q = new URLSearchParams();
      if (filter.status) q.set("status", filter.status);
      if (filter.limit) q.set("limit", String(filter.limit));
      if (filter.after) q.set("after", filter.after);
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions${q.size ? `?${q}` : ""}`,
      );
      return {
        missions: (r.json.missions ?? []) as MissionView[],
        next: (r.json.next as string | null) ?? null,
      };
    },
    /** `baseVersion` is the newest version you saw; a stale one is refused. Anything wider than the version in force waits for an owner. */
    revise: async (
      missionId: string,
      input: {
        baseVersion: number;
        contract: MissionContractInput;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/revisions`,
        input,
      );
      return asMission(r.status, r.json);
    },
    approve: async (missionId: string, version: number, reason?: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/approve`,
        { version, ...(reason ? { reason } : {}) },
      );
      return asMission(r.status, r.json);
    },
    reject: async (missionId: string, version: number, reason?: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/reject`,
        { version, ...(reason ? { reason } : {}) },
      );
      return asMission(r.status, r.json);
    },
    control: async (
      missionId: string,
      op: "submit" | "pause" | "resume" | "cancel" | "revoke" | "complete",
      options: { reason?: string; expectedRowVersion?: number } = {},
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/${op}`,
        options,
      );
      return asMission(r.status, r.json);
    },
    history: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/history`,
      );
      return r.json as { transitions: unknown[]; versions: unknown[] };
    },
  };
}

/** The issuer's signed revocation list. Public: no token. Verify its signature before trusting it. */
export async function fetchIssuerStatus(
  baseUrl: string,
  fetcher: typeof globalThis.fetch = fetch,
): Promise<StatusList> {
  const response = await fetcher(new URL("/v1/issuer/status", baseUrl));
  if (!response.ok) throw new Error(`ISSUER_STATUS_${response.status}`);
  return (await response.json()) as StatusList;
}
