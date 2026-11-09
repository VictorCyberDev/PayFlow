import { describe, expect, it } from "vitest";
import {
  BOOKING_STATES,
  ConfirmSchema,
  canMoveBooking,
  claim,
  depositState,
  heldMinor,
  holdsBudget,
  isTerminalBooking,
  type BookingState,
} from "../src/missions/booking.js";

/** V3 M53 — booking claims are only as strong as their evidence; the state machine only moves forward; UNKNOWN is resolved only by evidence. Pure. */
describe("M53 booking state machine", () => {
  it("every move that exists is forward-only, terminal states have none, and nothing skips the owner's approval", () => {
    const moves: [BookingState, BookingState][] = [];
    for (const a of BOOKING_STATES)
      for (const b of BOOKING_STATES)
        if (canMoveBooking(a, b)) moves.push([a, b]);
    for (const [a, b] of moves) expect(a).not.toBe(b);
    for (const s of ["DECLINED", "CANCELLED", "EXPIRED"] as const)
      expect(isTerminalBooking(s)).toBe(true);
    // never CONFIRMED without passing APPROVED and HANDED_OFF (or UNKNOWN, itself reached only after HANDED_OFF)
    expect(canMoveBooking("PROPOSED", "CONFIRMED")).toBe(false);
    expect(canMoveBooking("APPROVED", "CONFIRMED")).toBe(false);
    expect(canMoveBooking("PROPOSED", "HANDED_OFF")).toBe(false);
    expect(canMoveBooking("HANDED_OFF", "CONFIRMED")).toBe(true);
    // UNKNOWN only resolves to CONFIRMED or DECLINED; it cannot expire or be cancelled away
    expect(
      BOOKING_STATES.filter((t) => canMoveBooking("UNKNOWN", t)).sort(),
    ).toEqual(["CONFIRMED", "DECLINED"]);
    // a confirmed booking can only be cancelled
    expect(
      BOOKING_STATES.filter((t) => canMoveBooking("CONFIRMED", t)),
    ).toEqual(["CANCELLED"]);
    // reachability: every non-initial state is reachable from PROPOSED
    const seen = new Set<BookingState>(["PROPOSED"]);
    for (let i = 0; i < 8; i++)
      for (const [a, b] of moves) if (seen.has(a)) seen.add(b);
    expect([...seen].sort()).toEqual([...BOOKING_STATES].sort());
  });
});

describe("M53 claims never outrun evidence", () => {
  it("only provider evidence says 'confirmed by the provider'; a document or the owner's word is labelled as such", () => {
    expect(claim("CONFIRMED", "PROVIDER_CONFIRMATION_REF")).toMatchObject({
      reserved: "YES_PROVIDER_CONFIRMED",
    });
    expect(claim("CONFIRMED", "DOCUMENT_REF")).toMatchObject({
      reserved: "YES_DOCUMENTED",
    });
    const weak = claim("CONFIRMED", "OWNER_ATTESTATION");
    expect(weak.reserved).toBe("OWNER_SAYS_SO");
    expect(weak.headline).toContain("no proof");
    expect(claim("CONFIRMED", null).reserved).toBe("OWNER_SAYS_SO");
  });
  it("no state other than CONFIRMED ever says reserved; UNKNOWN says don't book again", () => {
    for (const s of BOOKING_STATES.filter(
      (x) => x !== "CONFIRMED" && x !== "UNKNOWN",
    ))
      for (const e of [
        null,
        "PROVIDER_CONFIRMATION_REF",
        "DOCUMENT_REF",
        "OWNER_ATTESTATION",
      ] as const)
        expect(claim(s, e).reserved, `${s}/${String(e)}`).toBe("NO");
    expect(claim("UNKNOWN", null)).toMatchObject({ reserved: "UNKNOWN" });
    expect(claim("UNKNOWN", null).headline).toContain("Don't book again");
    for (const s of BOOKING_STATES)
      expect(claim(s, null).headline).not.toMatch(/!/u);
  });
  it("provider and document evidence need a reference; only the owner's own word may go without", () => {
    expect(
      ConfirmSchema.safeParse({ evidenceKind: "PROVIDER_CONFIRMATION_REF" })
        .success,
    ).toBe(false);
    expect(
      ConfirmSchema.safeParse({
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "  ",
      }).success,
    ).toBe(false);
    expect(
      ConfirmSchema.safeParse({
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "confirmation.pdf",
      }).success,
    ).toBe(true);
    expect(
      ConfirmSchema.safeParse({ evidenceKind: "OWNER_ATTESTATION" }).success,
    ).toBe(true);
    expect(
      ConfirmSchema.safeParse({ evidenceKind: "OWNER_ATTESTATION", extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("M53 deposits and held budget", () => {
  it("a deposit is paid-and-confirmed only with provider-grade evidence; attestation alone is unconfirmed; none required is not 'unpaid'", () => {
    expect(depositState(0, null, false)).toBe("NOT_REQUIRED");
    expect(depositState(50_000, null, false)).toBe("NOT_PAID");
    expect(
      depositState(50_000, { evidence: "PROVIDER_CONFIRMATION_REF" }, false),
    ).toBe("PAID_CONFIRMED");
    expect(depositState(50_000, { evidence: "DOCUMENT_REF" }, false)).toBe(
      "PAID_CONFIRMED",
    );
    expect(depositState(50_000, { evidence: "OWNER_ATTESTATION" }, false)).toBe(
      "PAID_UNCONFIRMED",
    );
    expect(depositState(50_000, { evidence: "DOCUMENT_REF" }, true)).toBe(
      "REFUNDED",
    );
    expect(depositState(50_000, null, true)).toBe("NOT_PAID"); // a refund of nothing is nothing
    expect(depositState(null, null, false)).toBe("NOT_PAID");
  });
  it("budget is held while a booking could still be owed and released when it ends without confirmation; cancellation keeps only its exposure", () => {
    const f = { totalCostMinor: 86_500, depositMinor: 50_000 };
    for (const s of [
      "APPROVED",
      "HANDED_OFF",
      "UNKNOWN",
      "CONFIRMED",
    ] as const) {
      expect(holdsBudget(s)).toBe(true);
      expect(heldMinor(s, f, 10)).toBe(136_500);
    }
    for (const s of ["PROPOSED", "DECLINED", "EXPIRED"] as const)
      expect(heldMinor(s, f, 10)).toBe(0);
    expect(heldMinor("CANCELLED", f, 43_250)).toBe(43_250);
  });
});
