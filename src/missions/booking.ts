import { z } from "zod";

/**
 * V3 M53 — authorized booking and deposits. Pure and deterministic.
 *
 * A booking intent records what the owner APPROVED to attempt for one workspace listing, with the liability frozen at approval.
 * PayFlow never says a space is reserved or a deposit is paid on its own word: those words appear only when authentic evidence is
 * attached by a person (a provider confirmation reference or a document the person attests to). Until then the honest state is
 * "waiting for the provider". An unclear outcome is UNKNOWN and is never retried automatically.
 */
export const BOOKING_STATES = [
  "PROPOSED", // an agent or person drafted it; nothing approved
  "APPROVED", // the owner approved the attempt; budget is held; nothing has been sent to a provider
  "HANDED_OFF", // the person was given what is needed to book with the provider (or PayFlow submitted it); no confirmation yet
  "CONFIRMED", // authentic evidence of the provider's confirmation is attached
  "UNKNOWN", // a person says an attempt was made and the outcome is unclear; budget stays held
  "DECLINED", // the provider refused or the owner abandoned before any confirmation
  "CANCELLED", // cancelled after confirmation, under the provider's terms
  "EXPIRED", // not confirmed before its deadline
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

const FORWARD: Record<BookingState, readonly BookingState[]> = {
  PROPOSED: ["APPROVED", "DECLINED", "EXPIRED"],
  APPROVED: ["HANDED_OFF", "DECLINED", "EXPIRED"],
  HANDED_OFF: ["CONFIRMED", "UNKNOWN", "DECLINED", "EXPIRED"],
  UNKNOWN: ["CONFIRMED", "DECLINED"], // only evidence resolves it
  CONFIRMED: ["CANCELLED"],
  DECLINED: [],
  CANCELLED: [],
  EXPIRED: [],
};
export const canMoveBooking = (from: BookingState, to: BookingState) =>
  FORWARD[from].includes(to);
export const isTerminalBooking = (s: BookingState) => FORWARD[s].length === 0;
/** States in which budget for the booking is held. */
export const holdsBudget = (s: BookingState) =>
  s === "APPROVED" ||
  s === "HANDED_OFF" ||
  s === "UNKNOWN" ||
  s === "CONFIRMED";

export const EVIDENCE_KINDS = [
  "PROVIDER_CONFIRMATION_REF", // the provider's own confirmation/booking reference
  "DOCUMENT_REF", // a confirmation email/PDF the person attests to
  "OWNER_ATTESTATION", // the person says so; weakest: shown as such, never as provider-confirmed
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const ConfirmSchema = z
  .object({
    evidenceKind: z.enum(EVIDENCE_KINDS),
    /** The provider's reference or the document name. Required for everything except owner attestation. */
    evidenceRef: z.string().trim().min(1).max(300).optional(),
    note: z.string().trim().max(300).default(""),
  })
  .strict()
  .refine(
    (c) =>
      c.evidenceKind === "OWNER_ATTESTATION" || c.evidenceRef !== undefined,
    {
      message: "evidence reference required",
    },
  );
export type Confirmation = z.infer<typeof ConfirmSchema>;

/** What a screen may SAY about a booking. The strongest claim each state and evidence supports, and no stronger. */
export function claim(
  state: BookingState,
  evidence: EvidenceKind | null,
): {
  headline: string;
  reserved:
    | "YES_PROVIDER_CONFIRMED"
    | "YES_DOCUMENTED"
    | "OWNER_SAYS_SO"
    | "NO"
    | "UNKNOWN";
} {
  switch (state) {
    case "CONFIRMED":
      return evidence === "PROVIDER_CONFIRMATION_REF"
        ? {
            headline: "Confirmed by the provider",
            reserved: "YES_PROVIDER_CONFIRMED",
          }
        : evidence === "DOCUMENT_REF"
          ? {
              headline: "Confirmed in a document you attached",
              reserved: "YES_DOCUMENTED",
            }
          : {
              headline: "You told us this is confirmed. PayFlow has no proof.",
              reserved: "OWNER_SAYS_SO",
            };
    case "UNKNOWN":
      return {
        headline: "Checking what happened. Don't book again yet.",
        reserved: "UNKNOWN",
      };
    case "HANDED_OFF":
      return {
        headline: "Waiting for the provider. Nothing is reserved yet.",
        reserved: "NO",
      };
    case "APPROVED":
      return {
        headline: "Approved to attempt. Nothing is reserved yet.",
        reserved: "NO",
      };
    case "PROPOSED":
      return {
        headline: "Proposed. Nothing is approved or reserved.",
        reserved: "NO",
      };
    case "CANCELLED":
      return { headline: "Cancelled", reserved: "NO" };
    case "DECLINED":
      return { headline: "Not booked", reserved: "NO" };
    case "EXPIRED":
      return {
        headline: "Expired without confirmation. Nothing is reserved.",
        reserved: "NO",
      };
  }
}

export type DepositState =
  | "NOT_REQUIRED"
  | "NOT_PAID"
  | "PAID_CONFIRMED"
  | "PAID_UNCONFIRMED"
  | "REFUNDED";
/**
 * Deposit wording is separate from the booking's. A deposit is "paid" only with provider evidence; a person's attestation alone is
 * "paid, unconfirmed". PayFlow records the deposit; it does not move it (no payout or deposit rail is commissioned).
 */
export function depositState(
  depositMinor: number | null,
  paid: { evidence: EvidenceKind } | null,
  refunded: boolean,
): DepositState {
  if (depositMinor === 0) return "NOT_REQUIRED";
  if (refunded && paid) return "REFUNDED";
  if (!paid) return "NOT_PAID";
  return paid.evidence === "OWNER_ATTESTATION"
    ? "PAID_UNCONFIRMED"
    : "PAID_CONFIRMED";
}

/** Budget a booking holds in each state: total cost + deposit while it could still be owed, nothing once it ends without confirmation. */
export function heldMinor(
  state: BookingState,
  frozen: { totalCostMinor: number; depositMinor: number },
  cancellationExposureMinor: number,
): number {
  if (state === "CANCELLED") return cancellationExposureMinor;
  return holdsBudget(state) ? frozen.totalCostMinor + frozen.depositMinor : 0;
}
