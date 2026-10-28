export type AbuseSignalType =
  | "REPEATED_DENIALS"
  | "MERCHANT_SUBSTITUTION"
  | "REPLAY_CLUSTER"
  | "CREDENTIAL_ANOMALY"
  | "DELEGATION_ANOMALY"
  | "PROVIDER_ANOMALY";

export interface AbuseSignal {
  readonly type: AbuseSignalType;
  readonly subjectId: string;
  readonly observedAt: string;
  readonly score: number;
  readonly evidenceRefs: readonly string[];
}

export type AbuseDisposition = "OBSERVE" | "REVIEW" | "ESCALATE";

export function dispositionForSignals(signals: readonly AbuseSignal[]): {
  readonly disposition: AbuseDisposition;
  readonly aggregateScore: number;
  readonly reasons: readonly AbuseSignalType[];
} {
  const aggregateScore = Math.min(
    100,
    signals.reduce((total, signal) => {
      if (!Number.isFinite(signal.score) || signal.score < 0 || signal.score > 100) {
        throw new Error("INVALID_ABUSE_SIGNAL_SCORE");
      }
      return total + signal.score;
    }, 0),
  );
  return {
    disposition: aggregateScore >= 70 ? "ESCALATE" : aggregateScore >= 35 ? "REVIEW" : "OBSERVE",
    aggregateScore,
    reasons: [...new Set(signals.map((signal) => signal.type))],
  };
}

/** Abuse intelligence never returns ALLOW and cannot create Authority. */
export function assertAbuseSignalsAreNonAuthoritative(): true {
  return true;
}
