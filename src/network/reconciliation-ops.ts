import type {
  FinancialRailAdapter,
  NormalizedRailEvidence,
} from "./rail.js";

export type ReconciliationCaseState =
  | "PENDING"
  | "INVESTIGATING"
  | "RESOLVED_SUCCEEDED"
  | "RESOLVED_FAILED"
  | "UNRESOLVED";

export interface ReconciliationCase {
  readonly id: string;
  readonly attemptId: string;
  readonly railId: string;
  readonly idempotencyKey: string;
  readonly state: ReconciliationCaseState;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly evidence: readonly NormalizedRailEvidence[];
  readonly humanNote?: string;
}

export interface ReconciliationRepository {
  load(caseId: string): Promise<ReconciliationCase | null>;
  compareAndSet(
    caseId: string,
    expectedUpdatedAt: string,
    next: ReconciliationCase,
  ): Promise<boolean>;
}

export function deriveReconciliationState(
  evidence: NormalizedRailEvidence,
): ReconciliationCaseState {
  if (evidence.state === "SUCCEEDED" && evidence.effectCount === 1) {
    return "RESOLVED_SUCCEEDED";
  }
  if (evidence.state === "FAILED" && evidence.effectCount === 0) {
    return "RESOLVED_FAILED";
  }
  return "UNRESOLVED";
}

export class ReconciliationOperationsCenter {
  constructor(
    private readonly repo: ReconciliationRepository,
    private readonly rails: ReadonlyMap<string, FinancialRailAdapter>,
  ) {}

  /**
   * Observes provider truth only. It never calls rail.execute(), so investigation
   * cannot create a duplicate financial effect.
   */
  async investigate(caseId: string, now: string): Promise<ReconciliationCase> {
    const current = await this.repo.load(caseId);
    if (!current) throw new Error("RECONCILIATION_CASE_NOT_FOUND");
    if (current.state === "RESOLVED_SUCCEEDED" || current.state === "RESOLVED_FAILED") {
      return current;
    }
    const rail = this.rails.get(current.railId);
    if (!rail) throw new Error("RECONCILIATION_RAIL_UNAVAILABLE");
    const observed = await rail.lookup(current.idempotencyKey, now);
    const next: ReconciliationCase = {
      ...current,
      state: deriveReconciliationState(observed),
      updatedAt: now,
      evidence: [...current.evidence, observed],
    };
    const updated = await this.repo.compareAndSet(caseId, current.updatedAt, next);
    if (!updated) throw new Error("RECONCILIATION_CONCURRENT_UPDATE");
    return next;
  }

  async addHumanNote(caseId: string, note: string, now: string): Promise<ReconciliationCase> {
    const current = await this.repo.load(caseId);
    if (!current) throw new Error("RECONCILIATION_CASE_NOT_FOUND");
    if (note.trim().length < 3) throw new Error("RECONCILIATION_NOTE_TOO_SHORT");
    const next = { ...current, humanNote: note.trim(), updatedAt: now };
    const updated = await this.repo.compareAndSet(caseId, current.updatedAt, next);
    if (!updated) throw new Error("RECONCILIATION_CONCURRENT_UPDATE");
    return next;
  }
}
