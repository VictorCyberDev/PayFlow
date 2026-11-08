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

// ------------------------------------------------------------------------- communication (V3 M37)
export interface MessageDraft {
  supplierId: string;
  contactId: string;
  kind: "INQUIRY" | "NEGOTIATION" | "NOTICE";
  subject: string;
  body: string;
  negotiationId?: string;
  move?: NegotiationMove;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------- negotiation (V3 M36)
export interface NegotiationProposal {
  supplierId: string;
  document: {
    baselineQuoteId?: string;
    currency: string;
    targetTotalMinor: number;
    walkAwayMinor: number;
    terms?: {
      minWarrantyMonths?: number;
      minReturnWindowDays?: number;
      maxDeliveryDays?: number;
      acceptablePaymentTerms?: string[];
    };
    concessions?: {
      maxQuantityIncreasePercent?: number;
      mayExtendDeliveryDays?: number;
    };
    rounds: { maxRounds: number };
    negotiatorAgentId: string;
    disclosure?: { competingQuotes?: boolean; deadline?: boolean };
    acceptanceRule?: "PERSON_ALWAYS" | "AGENT_WITHIN_LIMITS";
    expiresAt: string;
  };
  idempotencyKey: string;
}
export interface NegotiationMove {
  kind: "COUNTER" | "ACCEPT";
  round: number;
  currency: string;
  totalMinor: number;
  terms?: {
    warrantyMonths?: number;
    returnWindowDays?: number;
    deliveryDays?: number;
    paymentTerms?: string;
  };
  quantityIncreasePercent?: number;
  disclosing?: (
    "BUDGET" | "OTHER_SUPPLIERS_IDENTITY" | "COMPETING_QUOTES" | "DEADLINE"
  )[];
}

// ------------------------------------------------------------------------- sourcing (V3 M35)
export interface SourcingRunInput {
  demand: { sku: string; quantity: number }[];
  quoteIds?: string[];
  maxSurplusUnits?: number;
  allowExtras?: boolean;
  requireQualified?: boolean;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------- quotes (V3 M34)
export type QuoteMoney =
  { basis: "STATED" | "ESTIMATED"; minor: number } | { basis: "UNKNOWN" };
export interface QuoteInput {
  supplierId: string;
  currency: string;
  validUntil: string;
  document: {
    lines: {
      description: string;
      sku?: string;
      quantity: number;
      unitPrice: QuoteMoney;
    }[];
    shipping: QuoteMoney;
    tax: QuoteMoney;
    duties: QuoteMoney;
    fees: QuoteMoney;
    discount: QuoteMoney;
    terms?: {
      paymentTerms?: string;
      deliveryDays?: number;
      returnWindowDays?: number;
      warrantyMonths?: number;
    };
  };
  source: {
    kind:
      "CONNECTOR_CALL" | "DOCUMENT_REF" | "SUPPLIER_STATED" | "OWNER_REPORTED";
    ref?: string;
  };
  supersedes?: string;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------- supplier qualification (V3 M33)
export interface SupplierFactInput {
  criterion: string;
  status: "CLAIMED" | "VERIFIED" | "FAILED" | "UNKNOWN";
  value?: Record<string, string | number | boolean>;
  evidenceKind?:
    "NONE" | "CONNECTOR_CALL" | "DOCUMENT_REF" | "OWNER_ATTESTATION";
  evidenceRef?: string;
  note?: string;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------- discovery (V3 M32)
export interface DiscoverInput {
  connectorId: string;
  query: { text?: string; recordId?: string; limit?: number };
  requirements?: {
    maxUnitPriceMinor?: number;
    currency?: string;
    minQuantity?: number;
    maxAgeMinutes?: number;
    claims?: Record<string, string | number | boolean>;
  };
  idempotencyKey: string;
}
export interface CandidateMarkInput {
  decision: "SHORTLIST" | "REJECT" | "CLEAR";
  reason?: string;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------- connectors (V3 M31)
export interface ConnectorSummary {
  connectorId: string;
  displayName: string;
  providerTypes: string[];
  mode: "SANDBOX" | "LIVE";
  capabilities: string[];
  dataUse: string;
  status: string;
}
export interface ConnectorInvokeInput {
  connectorId: string;
  capability: "SEARCH" | "READ" | "COMPARE" | "STATUS" | "VERIFY";
  query: { text?: string; recordId?: string; limit?: number };
  idempotencyKey: string;
}

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
  /** What connectors exist and which are usable now. No installation details. */
  async connectors() {
    const r = await this.call("GET", "/v1/agent/connectors");
    return (r.json.connectors ?? []) as unknown as ConnectorSummary[];
  }
  /**
   * Observe through a connector. Read-only by construction: the capability must be one of SEARCH, READ, COMPARE, STATUS or VERIFY,
   * the mission must grant it, and the answer is an observation, never a quote or a commitment. Reuse the key to replay.
   */
  async observe(missionId: string, input: ConnectorInvokeInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/connectors/invoke`,
      input,
    );
    return [r.status, r.json] as const;
  }
  /**
   * Search through a connector and keep what was observed as candidates, ranked against the requirements you state.
   * Observations are never quotes. Reuse the key to replay without searching again.
   */
  async discover(missionId: string, input: DiscoverInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/discovery/search`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async candidates(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/candidates`,
    );
    return r.json;
  }
  async compareCandidates(missionId: string, candidateIds: string[]) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/candidates/compare`,
      { candidateIds },
    );
    return [r.status, r.json] as const;
  }
  /** SHORTLIST, REJECT or CLEAR a candidate. A working note, not an approval. */
  async markCandidate(candidateId: string, input: CandidateMarkInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/candidates/${encodeURIComponent(candidateId)}/mark`,
      input,
    );
    return [r.status, r.json] as const;
  }
  /** Add a supplier to the mission's qualification list (needs READ). Idempotent by merchant reference. */
  async addSupplier(
    missionId: string,
    input: {
      externalRef?: string;
      displayName?: string;
      fromCandidateId?: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/suppliers`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async suppliers(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/suppliers`,
    );
    return r.json;
  }
  /**
   * Record a CLAIMED, UNKNOWN or FAILED fact about a supplier (needs VERIFY). An agent can never mark a fact VERIFIED, attest,
   * or weaken a person's verification.
   */
  async recordSupplierFact(supplierId: string, input: SupplierFactInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/suppliers/${encodeURIComponent(supplierId)}/facts`,
      input,
    );
    return [r.status, r.json] as const;
  }
  /**
   * Record what a supplier STATED (needs COMPARE). Each money part is STATED, ESTIMATED or UNKNOWN; the total is only claimed
   * when nothing is unknown. A quote is not an acceptance and PayFlow cannot make it binding.
   */
  async recordQuote(missionId: string, input: QuoteInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/quotes`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async quotes(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/quotes`,
    );
    return r.json;
  }
  async compareQuotes(missionId: string, quoteIds?: string[]) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/quotes/compare`,
      quoteIds ? { quoteIds } : {},
    );
    return [r.status, r.json] as const;
  }
  /** Put a current, complete quote in the budget as ONE QUOTED item (holds nothing until a person approves it). Idempotent. */
  async quoteToLedger(quoteId: string, idempotencyKey: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/quotes/${encodeURIComponent(quoteId)}/ledger`,
      { idempotencyKey },
    );
    return [r.status, r.json] as const;
  }
  /**
   * Ask which recorded quotes to rely on to cover a demand at the least landed cost (needs COMPARE). A recommendation only:
   * optimal for the quotes on file and the constraints given, and it commits nothing.
   */
  async sourcingRun(missionId: string, input: SourcingRunInput) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/sourcing/runs`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async sourcingRuns(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/sourcing/runs`,
    );
    return r.json;
  }
  /**
   * Propose the rules you will negotiate under (needs NEGOTIATE; only for yourself). They wait for the owner. Nothing is sent
   * to a supplier and nothing is accepted by this call.
   */
  async proposeNegotiation(missionId: string, input: NegotiationProposal) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/negotiations`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async negotiations(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/negotiations`,
    );
    return r.json;
  }
  /** Check one intended move against the rules in force right now. ALLOW, REQUIRES_PERSON or REFUSE with reasons. */
  async checkNegotiationMove(negotiationId: string, move: NegotiationMove) {
    const r = await this.call(
      "POST",
      `/v1/agent/negotiations/${encodeURIComponent(negotiationId)}/check`,
      move,
    );
    return [r.status, r.json] as const;
  }
  /**
   * Draft a message to a supplier's registered contact (needs DRAFT, or NEGOTIATE for a counteroffer). It waits for a person; nothing
   * is sent. A counteroffer carries a structured move that must pass the negotiation rules, and your text is scanned so it does not
   * reveal the budget, the limits or other suppliers.
   */
  async draftMessage(missionId: string, input: MessageDraft) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/messages`,
      input,
    );
    return [r.status, r.json] as const;
  }
  async messages(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/messages`,
    );
    return r.json;
  }
  /** Send YOUR message once a person has approved it (needs COMMUNICATE). A delivery that cannot be confirmed is DELIVERY_UNKNOWN and is never retried automatically. */
  async sendMessage(messageId: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/messages/${encodeURIComponent(messageId)}/send`,
      {},
    );
    return [r.status, r.json] as const;
  }
  /** The negotiation so far (our counters, the supplier's quotes) and what to do next. A recommendation only. Only the named negotiator. */
  async negotiationTimeline(negotiationId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/negotiations/${encodeURIComponent(negotiationId)}/timeline`,
    );
    return [r.status, r.json] as const;
  }
  /**
   * Issue the purchase order for an accepted quote (needs PURCHASE; you are the buyer). It is an instruction, not a payment: pay through
   * the usual path under the order's Authority, then reconcile.
   */
  async issuePurchaseOrder(
    acceptanceId: string,
    body: {
      category: string;
      purpose: string;
      costCenter?: string;
      invoiceRef?: string;
      ttlMinutes?: number;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/acceptances/${encodeURIComponent(acceptanceId)}/purchase-order`,
      body,
    );
    return [r.status, r.json] as const;
  }
  /** Ask PayFlow to compare your payment (its proposal id) to the order. PayFlow reads its own trace; your report is not believed. */
  async reconcilePurchaseOrder(poId: string, proposalId: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/purchase-orders/${encodeURIComponent(poId)}/reconcile`,
      { proposalId },
    );
    return [r.status, r.json] as const;
  }
  /** Import candidates for a role from a talent source (needs SEARCH). What a source returns is a claim; nothing is contacted. */
  async importTalentCandidates(
    missionId: string,
    body: {
      sourceId: string;
      roleId: string;
      text?: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/talent-candidates/import`,
      body,
    );
    return [r.status, r.json] as const;
  }
  /** Candidates, optionally for one role (needs READ). */
  async talentCandidates(missionId: string, roleId?: string) {
    const q = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/talent-candidates${q}`,
    );
    return [r.status, r.json] as const;
  }
  /** Propose a talent scope (needs DRAFT). It takes effect only when the owner approves it. */
  async proposeTalentScope(
    missionId: string,
    document: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/talent-scopes`,
      { document, idempotencyKey },
    );
    return [r.status, r.json] as const;
  }
  /** Talent scope versions and the one in force (needs READ). */
  async talentScopes(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/talent-scopes`,
    );
    return [r.status, r.json] as const;
  }
  /** The multi-vendor view: spend by supplier, concentration, trouble per supplier and close-out blockers. Needs READ. */
  async portfolio(missionId: string, maxShareBps?: number) {
    const q = maxShareBps === undefined ? "" : `?maxShareBps=${maxShareBps}`;
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/portfolio${q}`,
    );
    return [r.status, r.json] as const;
  }
  /** Add a reminder (a renewal, a payment due, or a note with a date). It moves no money; a person closes it. Needs READ. */
  async addObligation(
    missionId: string,
    obligation: {
      kind?: "CUSTOM" | "RENEWAL" | "PAYMENT_DUE";
      title: string;
      dueDate: string;
      amountMinor?: number;
      orderId?: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/obligations`,
      obligation,
    );
    return [r.status, r.json] as const;
  }
  /** Obligations with computed urgency (overdue, due soon, upcoming). Needs READ. */
  async obligations(missionId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/obligations`,
    );
    return [r.status, r.json] as const;
  }
  /** Open a dispute on your order. The ground must be one the computed fulfillment outcome supports; a person resolves it. */
  async openDispute(
    orderId: string,
    dispute: {
      ground:
        | "DAMAGED"
        | "WRONG_ITEM"
        | "SHORT_DELIVERY"
        | "OVER_DELIVERY"
        | "NOT_DELIVERED_LATE";
      claimedMinor: number;
      reason: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/orders/${encodeURIComponent(orderId)}/disputes`,
      dispute,
    );
    return [r.status, r.json] as const;
  }
  /** Record what the supplier said about a dispute. It is a claim and resolves nothing. */
  async addDisputeEvent(
    disputeId: string,
    event: {
      kind: "SUPPLIER_RESPONSE" | "NOTE";
      text: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/disputes/${encodeURIComponent(disputeId)}/events`,
      event,
    );
    return [r.status, r.json] as const;
  }
  /** Report a shipment for your order (a claim; a person verifies it). */
  async reportShipment(
    orderId: string,
    shipment: {
      carrier: string;
      trackingRef: string;
      expectedDelivery?: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/orders/${encodeURIComponent(orderId)}/shipments`,
      shipment,
    );
    return [r.status, r.json] as const;
  }
  /** What has arrived, the computed outcome and the dispute grounds it supports. Read-only. */
  async fulfillment(orderId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/orders/${encodeURIComponent(orderId)}/fulfillment`,
    );
    return [r.status, r.json] as const;
  }
  /** Create the order for a purchase PayFlow reconciled as settled (needs PURCHASE; you must be the order's buyer). */
  async createOrder(poId: string, idempotencyKey: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/purchase-orders/${encodeURIComponent(poId)}/order`,
      { idempotencyKey },
    );
    return [r.status, r.json] as const;
  }
  /**
   * Report something about an order (status, supplier reference, delivery date, note). It is recorded as a CLAIM and never moves the
   * order's status: a person verifies with evidence.
   */
  async reportOrderEvent(
    orderId: string,
    event: {
      kind: "STATUS" | "REFERENCE" | "DELIVERY_DATE" | "NOTE";
      status?:
        | "PLACED"
        | "CONFIRMED"
        | "SHIPPED"
        | "DELIVERED"
        | "CANCELLED"
        | "IN_DISPUTE";
      value?: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/orders/${encodeURIComponent(orderId)}/events`,
      event,
    );
    return [r.status, r.json] as const;
  }
  /** What would stop (or allow) accepting this quote, check by check, and who may. Read-only. */
  async acceptanceCheck(quoteId: string) {
    const r = await this.call(
      "GET",
      `/v1/agent/quotes/${encodeURIComponent(quoteId)}/acceptance-check`,
    );
    return [r.status, r.json] as const;
  }
  /**
   * Accept a quote (needs CONTRACT). You accept on your own authority only when the approved negotiation rules allow it, the mission lets
   * an agent contract, you are the named negotiator and every check holds; otherwise the result is outcome ESCALATED and a person decides.
   * Accepting commits budget inside PayFlow; it does not tell the supplier or pay anyone.
   */
  async acceptQuote(quoteId: string, idempotencyKey: string) {
    const r = await this.call(
      "POST",
      `/v1/agent/quotes/${encodeURIComponent(quoteId)}/accept`,
      { idempotencyKey },
    );
    return [r.status, r.json] as const;
  }
  /** Hand a decision to a person: ask to accept a quote, or to walk away from a negotiation (needs NEGOTIATE). */
  async escalate(
    missionId: string,
    input: {
      kind: "ACCEPTANCE_REQUEST" | "WALK_AWAY_REQUEST";
      quoteId?: string;
      negotiationId?: string;
      reason: string;
      idempotencyKey: string;
    },
  ) {
    const r = await this.call(
      "POST",
      `/v1/agent/missions/${encodeURIComponent(missionId)}/escalations`,
      input,
    );
    return [r.status, r.json] as const;
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

  /** Install, enable, disable and suspend connectors. The installation never returns a credential reference. */
  readonly connectors = {
    list: async () => {
      const r = await this.call("GET", "/v1/admin/org/connectors");
      return (r.json.connectors ?? []) as unknown[];
    },
    install: async (
      connectorId: string,
      input: { acknowledgedDataUse: true; credentialRef?: string },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/connectors/${encodeURIComponent(connectorId)}/install`,
        input,
      );
      return [r.status, r.json] as const;
    },
    enable: async (
      connectorId: string,
      input: { acknowledgedDataUse?: true; expectedRowVersion?: number } = {},
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/connectors/${encodeURIComponent(connectorId)}/enable`,
        input,
      );
      return [r.status, r.json] as const;
    },
    disable: async (connectorId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/connectors/${encodeURIComponent(connectorId)}/disable`,
        {},
      );
      return [r.status, r.json] as const;
    },
    suspend: async (connectorId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/connectors/${encodeURIComponent(connectorId)}/suspend`,
        {},
      );
      return [r.status, r.json] as const;
    },
    calls: async (missionId?: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/connector-calls${missionId ? `?missionId=${encodeURIComponent(missionId)}` : ""}`,
      );
      return (r.json.calls ?? []) as unknown[];
    },
  };

  /** Discovered candidates: ranked against requirements passed as query parameters, compared, and marked by people. */
  readonly discovery = {
    candidates: async (
      missionId: string,
      requirements: {
        maxUnitPriceMinor?: number;
        currency?: string;
        minQuantity?: number;
        maxAgeMinutes?: number;
        claims?: Record<string, string>;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const k of [
        "maxUnitPriceMinor",
        "currency",
        "minQuantity",
        "maxAgeMinutes",
      ] as const)
        if (requirements[k] !== undefined) q.set(k, String(requirements[k]));
      for (const [k, v] of Object.entries(requirements.claims ?? {}))
        q.set(`claim.${k}`, v);
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/candidates${q.size ? `?${q}` : ""}`,
      );
      return r.json;
    },
    compare: async (missionId: string, candidateIds: string[]) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/candidates/compare`,
        { candidateIds },
      );
      return [r.status, r.json] as const;
    },
    mark: async (candidateId: string, input: CandidateMarkInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/candidates/${encodeURIComponent(candidateId)}/mark`,
        input,
      );
      return [r.status, r.json] as const;
    },
  };

  /** Supplier dossiers. Only a person's VERIFIED fact on acceptable evidence qualifies a supplier. */
  readonly suppliers = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/suppliers`,
      );
      return r.json;
    },
    add: async (
      missionId: string,
      input: {
        externalRef?: string;
        displayName?: string;
        fromCandidateId?: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/suppliers`,
        input,
      );
      return [r.status, r.json] as const;
    },
    recordFact: async (supplierId: string, input: SupplierFactInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/suppliers/${encodeURIComponent(supplierId)}/facts`,
        input,
      );
      return [r.status, r.json] as const;
    },
    history: async (supplierId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/suppliers/${encodeURIComponent(supplierId)}/facts`,
      );
      return (r.json.facts ?? []) as unknown[];
    },
    /** Which criteria a supplier must meet (the contract check is always included). */
    setPolicy: async (
      missionId: string,
      required: string[],
      idempotencyKey: string,
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/qualification-policy`,
        { required, idempotencyKey },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Supplier quotes and landed cost. */
  readonly quotes = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/quotes`,
      );
      return r.json;
    },
    record: async (missionId: string, input: QuoteInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/quotes`,
        input,
      );
      return [r.status, r.json] as const;
    },
    compare: async (missionId: string, quoteIds?: string[]) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/quotes/compare`,
        quoteIds ? { quoteIds } : {},
      );
      return [r.status, r.json] as const;
    },
    toLedger: async (quoteId: string, idempotencyKey: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/quotes/${encodeURIComponent(quoteId)}/ledger`,
        { idempotencyKey },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Sourcing runs: recommendations, and a person's adoption of one. */
  readonly sourcing = {
    run: async (missionId: string, input: SourcingRunInput) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/sourcing/runs`,
        input,
      );
      return [r.status, r.json] as const;
    },
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/sourcing/runs`,
      );
      return r.json;
    },
    get: async (runId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/sourcing/runs/${encodeURIComponent(runId)}`,
      );
      return r.json;
    },
    /** Put the chosen quotes in the budget as QUOTED items. Idempotent; recorded as adopted only when every quote went in. */
    adopt: async (runId: string, idempotencyKey: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/sourcing/runs/${encodeURIComponent(runId)}/adopt`,
        { idempotencyKey },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Negotiation rulebooks: propose, decide (owner), revoke, and dry-run a move. */
  readonly negotiations = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/negotiations`,
      );
      return r.json;
    },
    propose: async (missionId: string, input: NegotiationProposal) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/negotiations`,
        input,
      );
      return [r.status, r.json] as const;
    },
    /** Owner only. Approval re-checks the world: qualified supplier, limits inside the mission and the budget, deadline inside the mission's. */
    decide: async (
      negotiationId: string,
      version: number,
      decision: "approve" | "reject",
      reason = "",
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/negotiations/${encodeURIComponent(negotiationId)}/versions/${version}/${decision}`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
    revoke: async (negotiationId: string, reason = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/negotiations/${encodeURIComponent(negotiationId)}/revoke`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
    check: async (negotiationId: string, move: NegotiationMove) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/negotiations/${encodeURIComponent(negotiationId)}/check`,
        move,
      );
      return [r.status, r.json] as const;
    },
  };

  /** Supplier contacts, messages and their approval. Recipients come only from contacts a person registers here. */
  readonly communication = {
    contacts: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/contacts`,
      );
      return (r.json.contacts ?? []) as unknown[];
    },
    addContact: async (
      supplierId: string,
      input: { address: string; basis: string },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/suppliers/${encodeURIComponent(supplierId)}/contacts`,
        input,
      );
      return [r.status, r.json] as const;
    },
    blockContact: async (contactId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/contacts/${encodeURIComponent(contactId)}/block`,
        {},
      );
      return [r.status, r.json] as const;
    },
    restoreContact: async (contactId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/contacts/${encodeURIComponent(contactId)}/restore`,
        {},
      );
      return [r.status, r.json] as const;
    },
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/messages`,
      );
      return r.json;
    },
    draft: async (missionId: string, input: MessageDraft) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/messages`,
        input,
      );
      return [r.status, r.json] as const;
    },
    /** Record a supplier's reply. It is stored as untrusted text and triggers nothing. */
    recordReply: async (
      missionId: string,
      input: {
        supplierId: string;
        contactId?: string;
        subject: string;
        body: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/messages/inbound`,
        input,
      );
      return [r.status, r.json] as const;
    },
    approve: async (messageId: string, note = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/messages/${encodeURIComponent(messageId)}/approve`,
        { note },
      );
      return [r.status, r.json] as const;
    },
    reject: async (messageId: string, note = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/messages/${encodeURIComponent(messageId)}/reject`,
        { note },
      );
      return [r.status, r.json] as const;
    },
    send: async (messageId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/messages/${encodeURIComponent(messageId)}/send`,
        {},
      );
      return [r.status, r.json] as const;
    },
    /** Settle a message whose delivery was unknown, after checking with the supplier or the provider. */
    resolve: async (
      messageId: string,
      outcome: "SENT" | "FAILED",
      note: string,
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/messages/${encodeURIComponent(messageId)}/resolve`,
        { outcome, note },
      );
      return [r.status, r.json] as const;
    },
    events: async (messageId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/messages/${encodeURIComponent(messageId)}/events`,
      );
      return (r.json.events ?? []) as unknown[];
    },
  };

  /** What contractor work a mission may look for. The owner approves; one version is in force at a time. */
  readonly talentScopes = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-scopes`,
      );
      return r.json;
    },
    propose: async (
      missionId: string,
      document: Record<string, unknown>,
      idempotencyKey: string,
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-scopes`,
        { document, idempotencyKey },
      );
      return [r.status, r.json] as const;
    },
    approve: async (scopeId: string, reason = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/talent-scopes/${encodeURIComponent(scopeId)}/approve`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
    reject: async (scopeId: string, reason = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/talent-scopes/${encodeURIComponent(scopeId)}/reject`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
    revoke: async (scopeId: string, reason = "") => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/talent-scopes/${encodeURIComponent(scopeId)}/revoke`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Talent sources and candidates. Candidates are claims; importing contacts no one. */
  readonly talentCandidates = {
    sources: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-sources`,
      );
      return r.json;
    },
    list: async (missionId: string, roleId?: string) => {
      const q = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-candidates${q}`,
      );
      return r.json;
    },
    import: async (
      missionId: string,
      body: {
        sourceId: string;
        roleId: string;
        text?: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-candidates/import`,
        body,
      );
      return [r.status, r.json] as const;
    },
    add: async (
      missionId: string,
      body: {
        roleId: string;
        handle: string;
        sourceRef?: string;
        profile: Record<string, unknown>;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/talent-candidates`,
        body,
      );
      return [r.status, r.json] as const;
    },
  };

  /** The multi-vendor view, computed when asked. `maxShareBps` (1..10000, default 5000) is the concentration limit. */
  readonly portfolio = async (missionId: string, maxShareBps?: number) => {
    const q = maxShareBps === undefined ? "" : `?maxShareBps=${maxShareBps}`;
    const r = await this.call(
      "GET",
      `/v1/admin/org/missions/${encodeURIComponent(missionId)}/portfolio${q}`,
    );
    return r.json;
  };

  /** Dates the mission must not forget. Derived dates start from verified facts only. */
  readonly obligations = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/obligations`,
      );
      return r.json;
    },
    /** Derive delivery deadline, return window and warranty end from the quote's terms and the verified delivery date. Safe to repeat. */
    derive: async (orderId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/obligations/derive`,
        {},
      );
      return [r.status, r.json] as const;
    },
    add: async (
      missionId: string,
      obligation: {
        kind?: "CUSTOM" | "RENEWAL" | "PAYMENT_DUE";
        title: string;
        dueDate: string;
        amountMinor?: number;
        orderId?: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/obligations`,
        obligation,
      );
      return [r.status, r.json] as const;
    },
    resolve: async (
      obligationId: string,
      outcome: "DONE" | "WAIVED",
      note = "",
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/obligations/${encodeURIComponent(obligationId)}/resolve`,
        { outcome, note },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Disputes and refunds. Only a person resolves; a refund needs Proof or a provider confirmation. */
  readonly disputes = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/disputes`,
      );
      return r.json;
    },
    open: async (
      orderId: string,
      dispute: {
        ground:
          | "DAMAGED"
          | "WRONG_ITEM"
          | "SHORT_DELIVERY"
          | "OVER_DELIVERY"
          | "NOT_DELIVERED_LATE";
        claimedMinor: number;
        reason: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/disputes`,
        dispute,
      );
      return [r.status, r.json] as const;
    },
    resolve: async (
      disputeId: string,
      resolution:
        | { decision: "NO_REFUND"; note?: string }
        | {
            decision: "REFUND";
            refundMinor: number;
            evidenceKind: "PAYFLOW_PROOF" | "PROVIDER_CONFIRMATION";
            evidenceRef: string;
            note?: string;
          },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/disputes/${encodeURIComponent(disputeId)}/resolve`,
        resolution,
      );
      return [r.status, r.json] as const;
    },
    withdraw: async (disputeId: string, reason: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/disputes/${encodeURIComponent(disputeId)}/withdraw`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Fulfillment: shipments and a person's receipts; the outcome is computed. */
  readonly fulfillment = {
    get: async (orderId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/fulfillment`,
      );
      return r.json;
    },
    shipment: async (
      orderId: string,
      shipment: {
        carrier: string;
        trackingRef: string;
        expectedDelivery?: string;
        verify?: boolean;
        evidenceKind?:
          "NONE" | "OWNER_ATTESTATION" | "DOCUMENT_REF" | "CONNECTOR_CALL";
        evidenceRef?: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/shipments`,
        shipment,
      );
      return [r.status, r.json] as const;
    },
    /** A person's count of what arrived for one purchase-order line. Needs evidence. */
    receipt: async (
      orderId: string,
      receipt: {
        lineIndex: number;
        quantity: number;
        condition: "OK" | "DAMAGED" | "WRONG_ITEM";
        evidenceKind: "OWNER_ATTESTATION" | "DOCUMENT_REF";
        evidenceRef?: string;
        note?: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/receipts`,
        receipt,
      );
      return [r.status, r.json] as const;
    },
  };

  /** Orders: what settled purchases became. Status moves only on a person's evidenced event. */
  readonly orders = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/orders`,
      );
      return r.json;
    },
    create: async (poId: string, idempotencyKey: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/purchase-orders/${encodeURIComponent(poId)}/order`,
        { idempotencyKey },
      );
      return [r.status, r.json] as const;
    },
    /** `verify: true` needs an evidenceKind other than NONE and moves the status/reference/date; otherwise it is a claim. */
    record: async (
      orderId: string,
      event: {
        kind: "STATUS" | "REFERENCE" | "DELIVERY_DATE" | "NOTE";
        status?:
          | "PLACED"
          | "CONFIRMED"
          | "SHIPPED"
          | "DELIVERED"
          | "CANCELLED"
          | "IN_DISPUTE";
        value?: string;
        verify?: boolean;
        evidenceKind?:
          "NONE" | "OWNER_ATTESTATION" | "DOCUMENT_REF" | "CONNECTOR_CALL";
        evidenceRef?: string;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/orders/${encodeURIComponent(orderId)}/events`,
        event,
      );
      return [r.status, r.json] as const;
    },
  };

  /** Purchase orders derived from acceptances, and reconciliation of the payment against them. */
  readonly purchaseOrders = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/purchase-orders`,
      );
      return r.json;
    },
    issue: async (
      acceptanceId: string,
      body: {
        agentId: string;
        category: string;
        purpose: string;
        costCenter?: string;
        invoiceRef?: string;
        ttlMinutes?: number;
        idempotencyKey: string;
      },
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/acceptances/${encodeURIComponent(acceptanceId)}/purchase-order`,
        body,
      );
      return [r.status, r.json] as const;
    },
    reconcile: async (poId: string, proposalId: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/purchase-orders/${encodeURIComponent(poId)}/reconcile`,
        { proposalId },
      );
      return [r.status, r.json] as const;
    },
  };

  /** Acceptance of supplier quotes and the escalations agents raise. Owner only. */
  readonly acceptances = {
    list: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/acceptances`,
      );
      return r.json;
    },
    check: async (quoteId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/quotes/${encodeURIComponent(quoteId)}/acceptance-check`,
      );
      return r.json;
    },
    /** The walk-away cannot be exceeded; a missed term floor needs an overrideReason. */
    accept: async (
      quoteId: string,
      idempotencyKey: string,
      overrideReason?: string,
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/quotes/${encodeURIComponent(quoteId)}/accept`,
        { idempotencyKey, ...(overrideReason ? { overrideReason } : {}) },
      );
      return [r.status, r.json] as const;
    },
    withdraw: async (acceptanceId: string, reason: string) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/acceptances/${encodeURIComponent(acceptanceId)}/withdraw`,
        { reason },
      );
      return [r.status, r.json] as const;
    },
    resolveEscalation: async (
      escalationId: string,
      decision: "ACCEPT" | "DECLINE" | "DISMISS",
      note = "",
      overrideReason?: string,
    ) => {
      const r = await this.call(
        "POST",
        `/v1/admin/org/escalations/${encodeURIComponent(escalationId)}/resolve`,
        { decision, note, ...(overrideReason ? { overrideReason } : {}) },
      );
      return [r.status, r.json] as const;
    },
  };

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

  /** What was compiled from a mission into stored Authorities, and what could not be and why. Read-only: there is no way to ask for an Authority directly. */
  readonly authorities = {
    ofMission: async (missionId: string) => {
      const r = await this.call(
        "GET",
        `/v1/admin/org/missions/${encodeURIComponent(missionId)}/authorities`,
      );
      return r.json as unknown as {
        authorities: readonly {
          authorityId: string;
          agentId: string;
          category: string;
          missionVersion: number;
          allocationMinor: number;
          maxSingleTransactionMinor: number;
          status: "ACTIVE" | "REVOKED";
        }[];
        notCompiled: readonly {
          agentId: string | null;
          category: string | null;
          reason: string;
        }[];
      };
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
