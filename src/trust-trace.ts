import { createHash } from "node:crypto";
import { z } from "zod";

const eventSchema = z
  .object({
    id: z.string().min(1).max(200),
    sequence: z.number().int().positive().safe(),
    type: z.string().min(1).max(200),
    occurredAt: z.string().datetime(),
    data: z.record(
      z.union([
        z.string().max(65536),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    ),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Preserve the existing durable ledger's canonical format, including its
// legacy ordering. This verifier does not change historical hashes.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export interface TraceAnchor {
  readonly sequence: number;
  readonly hash: string | null;
}
export interface TraceVerification {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly head: TraceAnchor;
}

/** Read-only verification of a COMPLETE durable ledger, never authorization.
 * An independently trusted anchor is needed to detect removal of a valid tail.
 * Represented relationships are checked; absent provider/signature material
 * cannot be verified, and unknown event types carry no inferred semantics.
 */
export function verifyTrustTrace(
  raw: unknown,
  anchor?: TraceAnchor,
): TraceVerification {
  const invalid = (reason: string): TraceVerification => ({
    valid: false,
    issues: [reason],
    head: { sequence: 0, hash: null },
  });
  if (!Array.isArray(raw) || raw.length > 100000)
    return invalid("TRACE_LIMIT_OR_SHAPE");
  let previous: string | null = null;
  const ids = new Set<string>(),
    reservations = new Set<string>();
  const grants = new Map<string, string>(),
    claimed = new Set<string>();
  const attempts = new Map<string, string>(),
    resolved = new Map<string, string>();
  const committed = new Set<string>();
  const financialReservations = new Set<string>();
  const reviews = new Map<string, string>(),
    confirmed = new Set<string>(),
    activated = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const parsed = eventSchema.safeParse(raw[index]);
    if (!parsed.success) return invalid("MALFORMED_TRACE_EVENT");
    const e = parsed.data;
    if (Object.keys(e.data).length > 100 || canonical(e.data).length > 65536)
      return invalid("TRACE_PAYLOAD_LIMIT");
    const { hash, ...unsigned } = e;
    if (
      e.sequence !== index + 1 ||
      e.previousHash !== previous ||
      ids.has(e.id) ||
      createHash("sha256").update(canonical(unsigned)).digest("hex") !== hash
    )
      return invalid("TRACE_CHAIN_INVALID");
    ids.add(e.id);
    previous = hash;
    const id = (key: string): string =>
      typeof e.data[key] === "string" ? e.data[key] : "";
    const review = id("reviewId"),
      reservation = id("reservationId"),
      grant = id("grantId"),
      attempt = id("paymentAttemptId");
    if (e.type === "INTENT_REVIEW_CREATED") {
      if (
        !review ||
        reviews.has(review) ||
        !id("principalId") ||
        !id("agentId") ||
        !id("draftFingerprint") ||
        !id("reviewedHash")
      )
        return invalid("REVIEW_BINDING_INVALID");
      reviews.set(review, canonical(e.data));
    } else if (e.type === "HUMAN_CONFIRMATION_ACCEPTED") {
      if (reviews.get(review) !== canonical(e.data) || confirmed.has(review))
        return invalid("CONFIRMATION_BINDING_INVALID");
      confirmed.add(review);
    } else if (e.type === "INTENT_MANDATE_ACTIVATED") {
      if (!confirmed.has(review) || activated.has(review) || !id("mandateId"))
        return invalid("ACTIVATION_ORDER_INVALID");
      activated.add(review);
    } else if (e.type === "RESERVATION_CREATED") {
      if (!reservation || reservations.has(reservation) || !id("proposalId"))
        return invalid("RESERVATION_TRACE_INVALID");
      reservations.add(reservation);
    } else if (e.type === "EXECUTION_GRANT_ISSUED") {
      if (
        !grant ||
        grants.has(grant) ||
        !reservations.has(reservation) ||
        !id("proposalDigest")
      )
        return invalid("GRANT_TRACE_INVALID");
      grants.set(grant, reservation);
    } else if (e.type === "EXECUTION_AUTHORITY_CLAIMED") {
      if (grants.get(grant) !== reservation || claimed.has(grant))
        return invalid("CLAIM_TRACE_INVALID");
      claimed.add(grant);
    } else if (e.type === "PAYMENT_ATTEMPT_CREATED") {
      if (
        !attempt ||
        attempts.has(attempt) ||
        !claimed.has(grant) ||
        grants.get(grant) !== reservation
      )
        return invalid("ATTEMPT_TRACE_INVALID");
      attempts.set(attempt, grant);
      financialReservations.add(reservation);
    } else if (
      [
        "RESERVATION_RELEASED",
        "RESERVATION_FAILED",
        "RESERVATION_EXPIRED",
      ].includes(e.type)
    ) {
      if (
        !reservations.has(reservation) ||
        financialReservations.has(reservation)
      )
        return invalid("RESERVATION_OUTCOME_CONFLICT");
    } else if (e.type === "PAYPAL_OPERATION_DISPATCHED") {
      if (
        !attempts.has(attempt) ||
        committed.has(attempt) ||
        !["ORDER_CREATING", "CAPTURE_IN_FLIGHT"].includes(id("status"))
      )
        return invalid("DISPATCH_TRACE_INVALID");
    } else if (e.type === "PAYPAL_RECONCILIATION_RESOLVED") {
      if (
        !attempts.has(attempt) ||
        !id("paypalCaptureId") ||
        resolved.has(attempt)
      )
        return invalid("RESOLUTION_TRACE_INVALID");
      resolved.set(attempt, id("paypalCaptureId"));
    } else if (e.type === "PAYMENT_COMMITTED") {
      if (
        resolved.get(attempt) !== id("paypalCaptureId") ||
        !id("paypalCaptureId") ||
        committed.has(attempt)
      )
        return invalid("COMMIT_TRACE_INVALID");
      committed.add(attempt);
    }
  }
  const head = { sequence: raw.length, hash: previous };
  if (
    anchor &&
    (anchor.sequence !== head.sequence || anchor.hash !== head.hash)
  )
    return invalid("TRACE_ANCHOR_MISMATCH");
  return { valid: true, issues: [], head };
}
