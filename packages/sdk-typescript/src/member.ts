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

// -------------------------------------------------------------------------------------------------- plans (V3 M27)
export interface PlanTaskInput {
  readonly key: string;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly taskType: string;
  readonly requiredCapabilities: readonly MissionCapability[];
  readonly providerTypes?: readonly string[];
  readonly estimatedCostMinor?: number;
  /** An estimate is labelled; a planner can never claim VERIFIED_QUOTE. */
  readonly estimateSource?: "NONE" | "HUMAN_ESTIMATE" | "AI_ESTIMATE";
  readonly expectedDurationMinutes?: number;
  readonly requiredEvidence?: readonly string[];
  readonly assignedAgentId?: string;
  readonly priority?: "LOW" | "NORMAL" | "HIGH";
  readonly deadline?: string;
  readonly requiresOwnerApproval?: boolean;
  readonly dependsOn?: readonly {
    key: string;
    kind?: "HARD" | "CONDITIONAL";
  }[];
  readonly explanation: string;
}
export interface PlanDraftInput {
  readonly rationale?: string;
  readonly tasks: readonly PlanTaskInput[];
}
export type PlanTaskState =
  | "BLOCKED"
  | "READY"
  | "AWAITING_APPROVAL"
  | "IN_PROGRESS"
  | "HANDED_OFF"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "INVALIDATED";
export interface PlanTaskView {
  readonly taskId: string;
  readonly missionId?: string;
  readonly key: string;
  readonly planVersion: number;
  readonly title: string;
  readonly state: PlanTaskState;
  readonly blockReason: string | null;
  readonly readiness: "EXECUTABLE" | "PREPARED_HANDOFF" | "UNAVAILABLE";
  readonly readinessReason: string | null;
  readonly assignedAgentId: string | null;
  readonly requiresOwnerApproval: boolean;
  readonly estimatedCostMinor: number | null;
  readonly estimateSource: string;
  readonly requiredEvidence: readonly string[];
  readonly dependsOn: readonly { key: string; kind: string }[];
  readonly result: unknown;
}
export type PlanTaskResult =
  | { readonly ok: true; readonly task: PlanTaskView }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly detail?: string;
    };
const asTask = (
  status: number,
  json: Record<string, unknown>,
): PlanTaskResult =>
  status === 200 && json.task
    ? { ok: true, task: json.task as PlanTaskView }
    : {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        ...(typeof json.detail === "string" ? { detail: json.detail } : {}),
      };
export type PlanResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly plan: {
        planVersion: number;
        status: string;
        estimatedTotalMinor?: number;
        overBudget?: boolean;
      };
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly problems?: readonly { code: string }[];
    };
const asPlan = (status: number, json: Record<string, unknown>): PlanResult =>
  (status === 200 || status === 201 || status === 202) && json.plan
    ? { ok: true, replayed: status === 200, plan: json.plan as never }
    : {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        ...(Array.isArray(json.problems)
          ? { problems: json.problems as { code: string }[] }
          : {}),
      };

// ------------------------------------------------------------------------- commitment ledger (V3 M28)
export type LedgerStage =
  | "ESTIMATED"
  | "QUOTED"
  | "APPROVED"
  | "COMMITTED"
  | "RESERVED"
  | "IN_FLIGHT"
  | "SETTLED"
  | "UNKNOWN"
  | "REFUNDED"
  | "CANCELLED"
  | "RELEASED"
  | "FAILED";
export type LedgerEvidenceKind =
  | "NONE"
  | "AGENT_REPORTED"
  | "OWNER_REPORTED"
  | "PAYFLOW_AUTHORITY_RECEIPT"
  | "PAYFLOW_PROOF"
  | "PROVIDER_CONFIRMATION";
export interface LedgerItemInput {
  readonly kind:
    | "GOODS"
    | "SERVICE"
    | "SUBSCRIPTION"
    | "DEPOSIT"
    | "CONTRACTOR_MILESTONE"
    | "FEE"
    | "OTHER";
  readonly label: string;
  /** Integer minor units, in the mission's currency. No conversion ever happens. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly stage?: LedgerStage;
  readonly verification?: "OWNER_REPORTED" | "UNVERIFIED";
  readonly evidenceKind?: LedgerEvidenceKind;
  readonly evidence?: Record<string, string | number | boolean>;
  readonly idempotencyKey: string;
}
export interface LedgerTransitionInput {
  readonly to: LedgerStage;
  readonly amountMinor?: number;
  readonly refundMinor?: number;
  readonly evidenceKind?: LedgerEvidenceKind;
  readonly evidence?: Record<string, string | number | boolean>;
  readonly expectedRowVersion?: number;
  readonly idempotencyKey: string;
}
export interface LedgerItemView {
  readonly itemId: string;
  readonly stage: LedgerStage;
  readonly amountMinor: number;
  readonly refundedMinor: number;
  /** The budget this item holds right now. */
  readonly exposureMinor: number;
  readonly verification: string;
  readonly rowVersion: number;
}
export interface LedgerOverview {
  readonly summary: {
    readonly currency: string;
    readonly ceilingMinor: number;
    readonly exposureMinor: number;
    readonly availableMinor: number;
    readonly overCommittedMinor: number;
    readonly unverifiedExposureMinor: number;
    readonly unknownExposureMinor: number;
    readonly refundedMinor: number;
    readonly byStage: Record<string, { count: number; amountMinor: number }>;
  };
  readonly items: readonly LedgerItemView[];
}
export type LedgerResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly item: LedgerItemView;
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly detail?: string;
    };
const asLedger = (
  status: number,
  json: Record<string, unknown>,
): LedgerResult =>
  (status === 200 || status === 201) && json.item
    ? {
        ok: true,
        replayed: (json.item as { replayed?: boolean }).replayed === true,
        item: json.item as LedgerItemView,
      }
    : {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        ...(typeof json.detail === "string" ? { detail: json.detail } : {}),
      };

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
  /** The tasks assigned to this agent on missions in force (BLOCKED tasks are listed so the agent can see what it waits for). */
  async tasks(): Promise<readonly PlanTaskView[]> {
    const r = await this.call("GET", "/v1/agent/tasks");
    return (r.json.tasks ?? []) as PlanTaskView[];
  }
  /** Claim a READY task. Re-sending the same `runKey` is a replay, never a second claim. */
  async claim(taskId: string, runKey: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/claim`,
      { runKey },
    );
    return asTask(r.status, r.json);
  }
  /** Report completion with the evidence the task requires. The result is recorded as AGENT_REPORTED, not provider-confirmed. */
  async complete(
    taskId: string,
    input: {
      runKey: string;
      summary?: string;
      evidence?: readonly { kind: string; ref: string }[];
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/complete`,
      input,
    );
    return asTask(r.status, r.json);
  }
  async fail(taskId: string, input: { runKey: string; reason: string }) {
    const r = await this.call(
      "POST",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/fail`,
      input,
    );
    return asTask(r.status, r.json);
  }
  /** Hand the task to a person (a step no connected provider can do). */
  async handoff(taskId: string, input: { runKey: string; note: string }) {
    const r = await this.call(
      "POST",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/handoff`,
      input,
    );
    return asTask(r.status, r.json);
  }
  /** Propose a plan (labelled MODEL). It stays inert until a member activates it. */
  async proposePlan(
    missionId: string,
    input: {
      draft: PlanDraftInput;
      sourceLabel?: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/plans`,
      { source: "MODEL", ...input },
    );
    return asPlan(r.status, r.json);
  }
  /** An agent may only ESTIMATE or QUOTE. Approval, commitment, reservation and money are never an agent's. */
  async ledgerAdd(missionId: string, input: LedgerItemInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/ledger/items`,
      input,
    );
    return asLedger(r.status, r.json);
  }
  async ledgerView(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/ledger`,
    );
    return r.json as unknown as {
      summary: LedgerOverview["summary"];
      items: LedgerItemView[];
    };
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

  readonly plans = {
    /** A member's plan is active at once. `TEMPLATE` derives it from the contract alone (no prices, no suppliers). */
    create: async (
      missionId: string,
      input:
        | { source: "TEMPLATE"; idempotencyKey: string }
        | { source: "HUMAN"; draft: PlanDraftInput; idempotencyKey: string },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/plans`,
        input,
      );
      return asPlan(r.status, r.json);
    },
    current: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/plans`,
      );
      return r.json as {
        plans: unknown[];
        activePlanVersion: number | null;
        tasks: PlanTaskView[];
        progress: Record<string, number>;
        estimatedTotalMinor: number;
      };
    },
    activate: async (missionId: string, planVersion: number) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/plans/${planVersion}/activate`,
        {},
      );
      return asPlan(r.status, r.json);
    },
    reject: async (missionId: string, planVersion: number) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/plans/${planVersion}/reject`,
        {},
      );
      return asPlan(r.status, r.json);
    },
  };
  readonly tasks = {
    /** Owner approval of a task that needs one. */
    approve: async (taskId: string) =>
      asTask(...(await this.taskCall(taskId, "approve", {}))),
    /** A person confirms a handed-off task with evidence. Recorded as OWNER_REPORTED. */
    confirmHandoff: async (
      taskId: string,
      input: {
        summary?: string;
        evidence: readonly { kind: string; ref: string }[];
      },
    ) => asTask(...(await this.taskCall(taskId, "confirm-handoff", input))),
    skip: async (taskId: string, reason?: string) =>
      asTask(
        ...(await this.taskCall(taskId, "skip", reason ? { reason } : {})),
      ),
    invalidate: async (taskId: string, reason?: string) =>
      asTask(
        ...(await this.taskCall(
          taskId,
          "invalidate",
          reason ? { reason } : {},
        )),
      ),
    retry: async (taskId: string, reason?: string) =>
      asTask(
        ...(await this.taskCall(taskId, "retry", reason ? { reason } : {})),
      ),
  };
  private async taskCall(
    taskId: string,
    op: string,
    body: unknown,
  ): Promise<[number, Record<string, unknown>]> {
    const r = await this.call(
      "POST",
      `/v1/admin/org/tasks/${encodeURIComponent(taskId)}/${op}`,
      body,
    );
    return [r.status, r.json];
  }

  readonly ledger = {
    overview: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/ledger`,
      );
      return r.json as unknown as LedgerOverview;
    },
    createItem: async (missionId: string, input: LedgerItemInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/ledger/items`,
        input,
      );
      return asLedger(r.status, r.json);
    },
    /** Move an item between stages. Moves that assert what happened outside need Proof or a provider confirmation. */
    transition: async (itemId: string, input: LedgerTransitionInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/ledger/items/${encodeURIComponent(itemId)}/transition`,
        input,
      );
      return asLedger(r.status, r.json);
    },
    history: async (itemId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/ledger/items/${encodeURIComponent(itemId)}/history`,
      );
      return (r.json.entries ?? []) as unknown[];
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
