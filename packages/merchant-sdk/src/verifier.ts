import { createHash, randomBytes } from "node:crypto";
import {
  verifyPresentation,
  type Presentation,
  type Reason,
  type VerifierEnvironment,
  type AuthorityScope,
} from "../../verifier/src/authority.js";
import { gateMarkModel, type GateMarkModel } from "./index.js";

/**
 * Merchant-side verification, in the order a real checkout needs it:
 *
 *   1. issueChallenge(order)   one random challenge per order, single use, short lived, bound to that order's facts
 *   2. verifyAgent(...)        the agent shows an Authority credential bound to THIS merchant and THIS challenge
 *   3. (the agent pays through PayFlow; the Gateway, not this SDK, decides and moves money)
 *   4. associateProof(...)     a signed Proof of that payment is verified and tied to THIS order, once
 *
 * The SDK only ever answers questions. It never authorises a payment and it never sees a payment credential.
 * An unknown outcome never ships goods and never cancels the order: it holds.
 */
export interface MerchantOrder {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** The merchant's counterparty id as PayFlow knows it. */
  readonly merchantId: string;
  readonly actionKind?: string;
}

const orderDigest = (o: MerchantOrder) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        o.orderId,
        o.amountMinor,
        o.currency,
        o.merchantId,
        o.actionKind ?? "PURCHASE",
      ]),
    )
    .digest("hex");

// ------------------------------------------------------------------ challenges
type Maybe<T> = T | Promise<T>;
export interface ChallengeStore {
  /** True for a store whose methods return promises (a shared database). `issueChallenge` then needs `issue`. */
  readonly async?: true;
  put(
    challenge: string,
    record: { digest: string; expiresAt: number },
    now: number,
  ): Maybe<void>;
  /** Atomic single use: true exactly once, and only for an unexpired challenge bound to this digest. */
  consume(challenge: string, digest: string, now: number): Maybe<boolean>;
  peek(challenge: string, digest: string, now: number): Maybe<boolean>;
}
/** In-process store. A multi-instance merchant must supply a shared one with the same atomic `consume`. */
export class MemoryChallengeStore implements ChallengeStore {
  private readonly map = new Map<
    string,
    { digest: string; expiresAt: number }
  >();
  constructor(private readonly max = 10_000) {}
  put(
    challenge: string,
    record: { digest: string; expiresAt: number },
    now: number,
  ) {
    for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
    if (this.map.size >= this.max) throw new Error("CHALLENGE_STORE_FULL");
    this.map.set(challenge, record);
  }
  peek(challenge: string, digest: string, now: number) {
    const r = this.map.get(challenge);
    return !!r && r.digest === digest && now < r.expiresAt;
  }
  consume(challenge: string, digest: string, now: number) {
    if (!this.peek(challenge, digest, now)) return false;
    this.map.delete(challenge);
    return true;
  }
}

// ------------------------------------------------------------------ results
declare const boundBrand: unique symbol;
/** Only `MerchantVerifier.verifyAgent` can produce one of these, so a Gate Mark cannot be drawn "VERIFIED" from thin air. */
export interface BoundVerification {
  readonly [boundBrand]: true;
  readonly orderId: string;
  readonly verifiedAt: string;
  readonly agent: string;
  readonly issuer: string;
  readonly effective: AuthorityScope;
}
export type AgentVerification =
  | { readonly valid: true; readonly bound: BoundVerification }
  | {
      readonly valid: false;
      readonly reasons: readonly (
        Reason | "UNKNOWN_CHALLENGE" | "STORE_UNAVAILABLE"
      )[];
    };

export type ProofVerdict = "FULFIL" | "HOLD" | "DO_NOT_FULFIL" | "REFUSE";
export interface ProofAssociation {
  readonly verdict: ProofVerdict;
  readonly reason:
    | "PAID_ONCE_MATCHES_ORDER"
    | "OUTCOME_UNKNOWN"
    | "NO_MONEY_MOVED"
    | "PROOF_NOT_AUTHENTIC"
    | "PROOF_DOES_NOT_MATCH_ORDER"
    | "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER"
    | "ORDER_ALREADY_PAID_BY_ANOTHER_PAYMENT"
    | "VERIFIER_UNAVAILABLE";
  readonly mismatches: readonly string[];
  readonly humanSummary: string;
  readonly actionId?: string;
}
export interface ProofCheck {
  readonly verified: boolean;
  readonly authentic: boolean;
  readonly reason: string;
  readonly outcome?: string;
  /** null = UNKNOWN. It is never treated as 0. */
  readonly effectCount?: number | null;
  readonly actionId?: string;
  readonly mismatches: readonly string[];
}
export type ProofVerifier = (
  proof: Record<string, unknown>,
  expect: {
    amountMinor: number;
    currency: string;
    merchantId: string;
    issuer?: string;
  },
) => Promise<ProofCheck>;

/** Verifies through the hosted Verify endpoint (M21). */
export const hostedProofVerifier =
  (baseUrl: string, fetcher: typeof fetch = fetch): ProofVerifier =>
  async (proof, expect) => {
    const response = await fetcher(new URL("/v1/verify/proofs", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof, expect }),
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (response.status === 429 || response.status >= 500)
      throw new Error("VERIFIER_UNAVAILABLE");
    return (await response.json()) as ProofCheck;
  };

export type ClaimResult =
  | "CLAIMED"
  | "SAME_ORDER_AGAIN"
  | "ACTION_USED_FOR_ANOTHER_ORDER"
  | "ORDER_PAID_BY_ANOTHER_ACTION";
export interface ProofLedger {
  /**
   * Atomic. One payment (action id) pays one order and one order is paid by one payment; claiming the same pair again is
   * fine (a re-check). Either conflict is reported by name, and nothing is recorded.
   */
  claim(actionId: string, orderId: string): Maybe<ClaimResult>;
}
export class MemoryProofLedger implements ProofLedger {
  private readonly owner = new Map<string, string>();
  private readonly paidBy = new Map<string, string>();
  claim(actionId: string, orderId: string): ClaimResult {
    const existing = this.owner.get(actionId);
    if (existing !== undefined)
      return existing === orderId
        ? "SAME_ORDER_AGAIN"
        : "ACTION_USED_FOR_ANOTHER_ORDER";
    if (this.paidBy.has(orderId)) return "ORDER_PAID_BY_ANOTHER_ACTION";
    this.owner.set(actionId, orderId);
    this.paidBy.set(orderId, actionId);
    return "CLAIMED";
  }
}

export interface MerchantVerifierOptions {
  /** Who this merchant is, as agents must name it when presenting (normally its origin). */
  readonly audience: string;
  readonly env: Omit<VerifierEnvironment, "claimNonce">;
  readonly proofVerifier: ProofVerifier;
  readonly challenges?: ChallengeStore;
  readonly proofLedger?: ProofLedger;
  /** Atomic first-use claim for presentation nonces. Defaults to in-process memory. */
  readonly claimNonce?: VerifierEnvironment["claimNonce"];
  readonly now?: () => string;
  readonly challengeTtlSeconds?: number;
}

export class MerchantVerifier {
  private readonly challenges: ChallengeStore;
  private readonly ledger: ProofLedger;
  private readonly now: () => string;
  private readonly ttl: number;
  private readonly seenNonces = new Set<string>();
  /** Every BoundVerification this instance produced. A hand-made one (plain JS) is not in here and gets no mark. */
  private readonly issued = new WeakSet<object>();
  constructor(private readonly options: MerchantVerifierOptions) {
    this.challenges = options.challenges ?? new MemoryChallengeStore();
    this.ledger = options.proofLedger ?? new MemoryProofLedger();
    this.now = options.now ?? (() => new Date().toISOString());
    this.ttl = (options.challengeTtlSeconds ?? 300) * 1000;
  }

  /** In-process stores only. With a shared (async) store use `issue`; this refuses before storing anything. */
  issueChallenge(order: MerchantOrder): {
    challenge: string;
    expiresAt: string;
  } {
    if (this.challenges.async) throw new Error("ASYNC_STORE_USE_ISSUE");
    const challenge = randomBytes(24).toString("base64url");
    const expires = Date.parse(this.now()) + this.ttl;
    void this.challenges.put(
      challenge,
      { digest: orderDigest(order), expiresAt: expires },
      Date.parse(this.now()),
    );
    return { challenge, expiresAt: new Date(expires).toISOString() };
  }

  /** Works with any store. If a shared store is unavailable this throws and NO challenge exists: fail closed. */
  async issue(
    order: MerchantOrder,
  ): Promise<{ challenge: string; expiresAt: string }> {
    const challenge = randomBytes(24).toString("base64url");
    const expires = Date.parse(this.now()) + this.ttl;
    await this.challenges.put(
      challenge,
      { digest: orderDigest(order), expiresAt: expires },
      Date.parse(this.now()),
    );
    return { challenge, expiresAt: new Date(expires).toISOString() };
  }

  async verifyAgent(
    presentation: unknown,
    order: MerchantOrder,
  ): Promise<AgentVerification> {
    const at = this.now();
    // The challenge comes from our own store keyed by what the agent presented, never trusted for its own sake.
    const challenge = (presentation as Presentation | null)?.proof?.challenge;
    const digest = orderDigest(order);
    if (typeof challenge !== "string")
      return { valid: false, reasons: ["UNKNOWN_CHALLENGE"] };
    try {
      if (!(await this.challenges.peek(challenge, digest, Date.parse(at))))
        return { valid: false, reasons: ["UNKNOWN_CHALLENGE"] };
    } catch {
      // A store that cannot answer is never read as "valid".
      return { valid: false, reasons: ["STORE_UNAVAILABLE"] };
    }
    let verdict;
    try {
      verdict = await verifyPresentation(
        presentation,
        {
          aud: this.options.audience,
          challenge,
          now: at,
          action: {
            kind: order.actionKind ?? "PURCHASE",
            currency: order.currency,
            counterpartyId: order.merchantId,
            amountMinor: order.amountMinor,
          },
        },
        {
          ...this.options.env,
          claimNonce:
            this.options.claimNonce ??
            ((scope, nonce) => {
              const k = `${scope}:${nonce}`;
              if (this.seenNonces.has(k)) return false;
              this.seenNonces.add(k);
              return true;
            }),
        },
      );
    } catch {
      // The nonce store (or another dependency) could not answer: never read as valid.
      return { valid: false, reasons: ["STORE_UNAVAILABLE"] };
    }
    if (
      !verdict.valid ||
      !verdict.effective ||
      !verdict.agent ||
      !verdict.issuer
    )
      return { valid: false, reasons: verdict.reasons };
    // Spent only now, on success, and only if it was still ours to spend (a concurrent use loses).
    try {
      if (!(await this.challenges.consume(challenge, digest, Date.parse(at))))
        return { valid: false, reasons: ["UNKNOWN_CHALLENGE"] };
    } catch {
      return { valid: false, reasons: ["STORE_UNAVAILABLE"] };
    }
    const bound = {
      orderId: order.orderId,
      verifiedAt: at,
      agent: verdict.agent,
      issuer: verdict.issuer,
      effective: verdict.effective,
    } as BoundVerification;
    this.issued.add(bound);
    return { valid: true, bound };
  }

  /** After payment: is this Proof authentic, does it match THIS order, and has it not been used for another? */
  async associateProof(
    proof: Record<string, unknown>,
    order: MerchantOrder,
  ): Promise<ProofAssociation> {
    let check: ProofCheck;
    try {
      check = await this.options.proofVerifier(proof, {
        amountMinor: order.amountMinor,
        currency: order.currency,
        merchantId: order.merchantId,
      });
    } catch {
      return {
        verdict: "HOLD",
        reason: "VERIFIER_UNAVAILABLE",
        mismatches: [],
        humanSummary:
          "The Proof could not be checked right now. Do not ship and do not cancel; try again.",
      };
    }
    if (!check.authentic)
      return {
        verdict: "REFUSE",
        reason: "PROOF_NOT_AUTHENTIC",
        mismatches: check.mismatches,
        humanSummary: "This Proof is not authentic. Treat it as no payment.",
      };
    if (check.mismatches.length > 0 || !check.verified)
      return {
        verdict: "REFUSE",
        reason: "PROOF_DOES_NOT_MATCH_ORDER",
        mismatches: check.mismatches,
        humanSummary: `This Proof is genuine but does not match this order (${check.mismatches.join(", ") || "unspecified"}).`,
      };
    // UNKNOWN is a state of its own: never shipped, never cancelled.
    if (
      check.outcome === "UNKNOWN" ||
      check.effectCount === null ||
      check.effectCount === undefined
    )
      return {
        verdict: "HOLD",
        reason: "OUTCOME_UNKNOWN",
        mismatches: [],
        humanSummary:
          "PayFlow cannot yet say whether money moved. Do not ship and do not cancel; check again later.",
        ...(check.actionId ? { actionId: check.actionId } : {}),
      };
    if (check.outcome === "FAILED" || check.effectCount === 0)
      return {
        verdict: "DO_NOT_FULFIL",
        reason: "NO_MONEY_MOVED",
        mismatches: [],
        humanSummary: "The Proof shows no money moved. Do not ship.",
        ...(check.actionId ? { actionId: check.actionId } : {}),
      };
    if (
      check.outcome !== "SUCCEEDED" ||
      check.effectCount !== 1 ||
      !check.actionId
    )
      return {
        verdict: "REFUSE",
        reason: "PROOF_DOES_NOT_MATCH_ORDER",
        mismatches: ["outcome"],
        humanSummary: "The Proof is in a form this merchant does not accept.",
      };
    let claim: ClaimResult;
    try {
      claim = await this.ledger.claim(check.actionId, order.orderId);
    } catch {
      // Cannot record the claim: hold. Shipping without the record would allow double fulfilment.
      return {
        verdict: "HOLD",
        reason: "VERIFIER_UNAVAILABLE",
        mismatches: [],
        humanSummary:
          "The merchant's payment ledger is unavailable. Do not ship and do not cancel; try again.",
        actionId: check.actionId,
      };
    }
    if (claim === "ACTION_USED_FOR_ANOTHER_ORDER")
      return {
        verdict: "REFUSE",
        reason: "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER",
        mismatches: [],
        humanSummary: "This payment already paid for a different order.",
        actionId: check.actionId,
      };
    if (claim === "ORDER_PAID_BY_ANOTHER_ACTION")
      return {
        verdict: "REFUSE",
        reason: "ORDER_ALREADY_PAID_BY_ANOTHER_PAYMENT",
        mismatches: [],
        humanSummary:
          "This order is already paid by a different payment. Do not ship twice; consider refunding the duplicate.",
        actionId: check.actionId,
      };
    return {
      verdict: "FULFIL",
      reason: "PAID_ONCE_MATCHES_ORDER",
      mismatches: [],
      humanSummary: "Paid once, and it matches this order.",
      actionId: check.actionId,
    };
  }

  /**
   * The Gate Mark rules, in code. `VERIFIED` is only reachable from a BoundVerification this instance produced for
   * THIS order, and only while it is fresh; an old verification decays to UNKNOWN rather than staying green.
   */
  gateMark(
    input: AgentVerification | undefined,
    order: MerchantOrder,
    verificationUrl?: string,
    maxAgeSeconds = 300,
  ): GateMarkModel | null {
    if (input === undefined)
      return gateMarkModel("SUPPORTED", safeUrl(verificationUrl));
    if (input.valid) {
      if (!this.issued.has(input.bound)) return null;
      const age = Date.parse(this.now()) - Date.parse(input.bound.verifiedAt);
      if (
        input.bound.orderId !== order.orderId ||
        !(age >= -60_000 && age < maxAgeSeconds * 1000)
      )
        return gateMarkModel("UNKNOWN", safeUrl(verificationUrl));
      return gateMarkModel("VERIFIED", safeUrl(verificationUrl));
    }
    const r = input.reasons;
    if (r.includes("REVOKED"))
      return gateMarkModel("REVOKED", safeUrl(verificationUrl));
    if (r.includes("EXPIRED"))
      return gateMarkModel("EXPIRED", safeUrl(verificationUrl));
    // Could not tell (no/stale revocation data): unresolved, and visibly so.
    if (
      r.includes("STATUS_LIST_MISSING") ||
      r.includes("STATUS_LIST_STALE") ||
      r.includes("STATUS_LIST_INVALID")
    )
      return gateMarkModel("UNKNOWN", safeUrl(verificationUrl));
    // A failed check (bad signature, wrong verifier, out of scope...) is NOT "unknown": show no mark at all.
    return null;
  }
}

const safeUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ||
      ["localhost", "127.0.0.1"].includes(u.hostname)
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

/** Static markup for the mark. State is carried by shape AND words, never colour alone; every value is escaped. */
export function renderGateMarkHtml(model: GateMarkModel): string {
  const shape: Record<GateMarkModel["geometry"], string> = {
    GATE_OUTLINE:
      '<path d="M4 20V8l8-5 8 5v12" fill="none" stroke="currentColor" stroke-width="2"/>',
    GATE_COMMITTED:
      '<path d="M4 20V8l8-5 8 5v12z" fill="currentColor"/><path d="M8 12l3 3 5-6" fill="none" stroke="#fff" stroke-width="2"/>',
    GATE_BLOCKED:
      '<path d="M4 20V8l8-5 8 5v12z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2"/>',
    GATE_UNRESOLVED:
      '<path d="M4 20V8l8-5 8 5v12z" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><text x="12" y="16" text-anchor="middle" font-size="9" fill="currentColor">?</text>',
  };
  const body = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${shape[model.geometry]}</svg><span>${esc(model.label)}</span>`;
  const wrap = (inner: string) =>
    `<span class="payflow-gate-mark" data-state="${esc(model.state)}" role="group" aria-label="${esc(model.ariaLabel)}">${inner}</span>`;
  return wrap(
    model.verificationUrl
      ? `<a href="${esc(model.verificationUrl)}" rel="noopener noreferrer">${body}</a>`
      : body,
  );
}
