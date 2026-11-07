import { z } from "zod";

/**
 * V3 M37 — pure rules for supplier communication: addresses, legal status moves, and the leak scan for agent-written text.
 */
export const EMAIL =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
export const AddressSchema = z
  .string()
  .max(254)
  .refine((a) => EMAIL.test(a), "not a plain email address");

export type MessageStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "SENDING"
  | "SENT"
  | "DELIVERY_UNKNOWN"
  | "FAILED"
  | "RECEIVED";

/** The only legal moves. Anything else is refused whoever asks. */
export const LEGAL: Readonly<Record<MessageStatus, readonly MessageStatus[]>> =
  {
    PENDING_APPROVAL: ["APPROVED", "REJECTED"],
    APPROVED: ["SENDING", "REJECTED"],
    SENDING: ["SENT", "FAILED", "DELIVERY_UNKNOWN"],
    DELIVERY_UNKNOWN: ["SENT", "FAILED"],
    REJECTED: [],
    SENT: [],
    FAILED: [],
    RECEIVED: [],
  };
export const canMove = (from: MessageStatus, to: MessageStatus) =>
  LEGAL[from].includes(to);

const digitsOf = (text: string) =>
  [...text.matchAll(/\d[\d,._]*/gu)].map((m) =>
    m[0].replace(/[,_]/gu, "").replace(/[.]$/u, ""),
  );

/** The ways one amount (in minor units) could be written: 50000 / 500.00 / 500. */
export function renderings(minor: number): string[] {
  const out = new Set<string>([String(minor), (minor / 100).toFixed(2)]);
  if (minor % 100 === 0) out.add(String(minor / 100));
  return [...out];
}

export interface Secrets {
  /** Amounts that must not appear (minor units): the budget, limits, walk-away, target, what remains. */
  readonly amountsMinor: readonly number[];
  /** Amounts that may appear because they are the offer being made. */
  readonly allowedMinor: readonly number[];
  /** Names that must not appear: other suppliers' references and display names. */
  readonly names: readonly string[];
}
/**
 * Findings for text an AGENT wrote. It looks for the exact amounts and names it was told to keep private. It is a deterministic
 * tripwire, not a judge of meaning: it can over-block (a quantity that equals a limit written in major units) and it cannot catch a
 * paraphrase, which is why every outbound message is also approved by a person.
 */
export function leakFindings(text: string, s: Secrets): string[] {
  const findings: string[] = [];
  const tokens = new Set(digitsOf(text));
  const allowed = new Set(s.allowedMinor.flatMap(renderings));
  for (const a of s.amountsMinor)
    for (const r of renderings(a))
      if (tokens.has(r) && !allowed.has(r)) findings.push(`AMOUNT:${r}`);
  const lower = text.toLowerCase();
  for (const n of s.names)
    if (n.trim().length >= 3 && lower.includes(n.toLowerCase()))
      findings.push(`NAME:${n}`);
  return [...new Set(findings)].sort();
}
