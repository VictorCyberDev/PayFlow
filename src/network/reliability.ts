import { createHash } from "node:crypto";

export interface HealthCheckResult {
  readonly status: "ok" | "degraded" | "fail";
  readonly checks: Readonly<Record<string, "ok" | "fail">>;
}

export function readiness(
  checks: Readonly<Record<string, boolean>>,
): HealthCheckResult {
  const normalized = Object.fromEntries(
    Object.entries(checks).map(([key, value]) => [key, value ? "ok" : "fail"]),
  ) as Readonly<Record<string, "ok" | "fail">>;
  const failures = Object.values(normalized).filter(
    (value) => value === "fail",
  ).length;
  return {
    status:
      failures === 0
        ? "ok"
        : failures === Object.keys(normalized).length
          ? "fail"
          : "degraded",
    checks: normalized,
  };
}

export function safeCorrelationId(seed: string): string {
  return `corr_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24)}`;
}

export function retryDelayMs(
  attempt: number,
  baseMs = 250,
  maxMs = 10_000,
): number {
  if (!Number.isInteger(attempt) || attempt < 0)
    throw new Error("INVALID_RETRY_ATTEMPT");
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 12));
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface RateLimitStore {
  consume(
    bucket: string,
    keyHash: string,
    limit: number,
    windowSeconds: number,
    now: string,
  ): Promise<RateLimitDecision>;
}

export async function enforceRateLimit(
  store: RateLimitStore,
  input: {
    bucket: string;
    subject: string;
    limit: number;
    windowSeconds: number;
    now: string;
  },
): Promise<RateLimitDecision> {
  if (input.limit <= 0 || input.windowSeconds <= 0)
    throw new Error("INVALID_RATE_LIMIT");
  const keyHash = createHash("sha256")
    .update(input.subject, "utf8")
    .digest("hex");
  return store.consume(
    input.bucket,
    keyHash,
    input.limit,
    input.windowSeconds,
    input.now,
  );
}

export interface StructuredAuditEvent {
  readonly eventType: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly organizationId?: string;
  readonly agentId?: string;
  readonly authorityId?: string;
  readonly result:
    "ALLOW" | "DENY" | "ESCALATE" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "INFO";
  readonly reasonCodes: readonly string[];
}

export function auditEvent(event: StructuredAuditEvent): StructuredAuditEvent {
  if (event.eventType.length === 0 || event.correlationId.length === 0) {
    throw new Error("INVALID_AUDIT_EVENT");
  }
  return Object.freeze({
    ...event,
    reasonCodes: Object.freeze([...event.reasonCodes]),
  });
}
