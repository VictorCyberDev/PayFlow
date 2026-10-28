import { createHash } from "node:crypto";
import type { FinancialAction } from "./financial-action.js";

export type RailEffectState = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface BoundedRailGrant {
  readonly grantId: string;
  readonly authorityId: string;
  readonly actionDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
}

export interface RailExecutionRequest {
  readonly action: FinancialAction;
  readonly grant: BoundedRailGrant;
  readonly now: string;
}

export interface NormalizedRailEvidence {
  readonly rail: string;
  readonly idempotencyKey: string;
  readonly state: RailEffectState;
  readonly providerReference?: string;
  readonly effectCount: 0 | 1 | null;
  readonly observedAt: string;
  readonly reason: string;
}

export interface FinancialRailAdapter {
  readonly railId: string;
  execute(request: RailExecutionRequest): Promise<NormalizedRailEvidence>;
  lookup(idempotencyKey: string, now: string): Promise<NormalizedRailEvidence>;
}

export function financialActionDigest(action: FinancialAction): string {
  return createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
}

function validateGrant(request: RailExecutionRequest): void {
  if (Date.parse(request.now) >= Date.parse(request.grant.expiresAt)) {
    throw new Error("EXECUTION_GRANT_EXPIRED");
  }
  if (request.grant.idempotencyKey !== request.action.idempotencyKey) {
    throw new Error("EXECUTION_GRANT_IDEMPOTENCY_MISMATCH");
  }
  if (request.grant.actionDigest !== financialActionDigest(request.action)) {
    throw new Error("EXECUTION_GRANT_ACTION_MISMATCH");
  }
}

export type FakeRailMode =
  | "SUCCESS"
  | "DECLINE"
  | "TIMEOUT_BEFORE_EFFECT"
  | "TIMEOUT_AFTER_EFFECT";

/**
 * High-fidelity local rail simulator. It preserves one effect per idempotency
 * key and intentionally models provider ambiguity. It is never evidence of a
 * real provider capture.
 */
export class DeterministicFakeRail implements FinancialRailAdapter {
  private readonly effects = new Map<string, NormalizedRailEvidence>();

  constructor(
    readonly railId: string,
    private readonly mode: FakeRailMode,
  ) {}

  async execute(request: RailExecutionRequest): Promise<NormalizedRailEvidence> {
    validateGrant(request);
    const existing = this.effects.get(request.action.idempotencyKey);
    if (existing) return existing;
    const providerReference = `${this.railId}:${request.action.id}`;
    if (this.mode === "SUCCESS") {
      const evidence: NormalizedRailEvidence = {
        rail: this.railId,
        idempotencyKey: request.action.idempotencyKey,
        state: "SUCCEEDED",
        providerReference,
        effectCount: 1,
        observedAt: request.now,
        reason: "SIMULATED_PROVIDER_CONFIRMED",
      };
      this.effects.set(request.action.idempotencyKey, evidence);
      return evidence;
    }
    if (this.mode === "DECLINE") {
      const evidence: NormalizedRailEvidence = {
        rail: this.railId,
        idempotencyKey: request.action.idempotencyKey,
        state: "FAILED",
        providerReference,
        effectCount: 0,
        observedAt: request.now,
        reason: "SIMULATED_PROVIDER_DECLINED",
      };
      this.effects.set(request.action.idempotencyKey, evidence);
      return evidence;
    }
    if (this.mode === "TIMEOUT_BEFORE_EFFECT") {
      return {
        rail: this.railId,
        idempotencyKey: request.action.idempotencyKey,
        state: "UNKNOWN",
        effectCount: null,
        observedAt: request.now,
        reason: "SIMULATED_TIMEOUT_BEFORE_PROVIDER_TRUTH",
      };
    }
    const durableEffect: NormalizedRailEvidence = {
      rail: this.railId,
      idempotencyKey: request.action.idempotencyKey,
      state: "SUCCEEDED",
      providerReference,
      effectCount: 1,
      observedAt: request.now,
      reason: "SIMULATED_PROVIDER_CONFIRMED_AFTER_TIMEOUT",
    };
    this.effects.set(request.action.idempotencyKey, durableEffect);
    return {
      rail: this.railId,
      idempotencyKey: request.action.idempotencyKey,
      state: "UNKNOWN",
      effectCount: null,
      observedAt: request.now,
      reason: "SIMULATED_NETWORK_LOSS_AFTER_EFFECT",
    };
  }

  async lookup(idempotencyKey: string, now: string): Promise<NormalizedRailEvidence> {
    return (
      this.effects.get(idempotencyKey) ?? {
        rail: this.railId,
        idempotencyKey,
        state: "UNKNOWN",
        effectCount: null,
        observedAt: now,
        reason: "SIMULATED_PROVIDER_HAS_NO_TERMINAL_RECORD",
      }
    );
  }
}

export async function reconcileWithoutReexecution(
  rail: FinancialRailAdapter,
  idempotencyKey: string,
  now: string,
): Promise<NormalizedRailEvidence> {
  return rail.lookup(idempotencyKey, now);
}
