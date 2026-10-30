import type { PayFlowMcpToolName } from "./mcp.js";

export type ExpectedSelection = PayFlowMcpToolName | "NO_TOOL" | "CLARIFY";

export interface ToolSelectionCase {
  readonly id: string;
  readonly prompt: string;
  readonly expected: ExpectedSelection;
}

export const TOOL_SELECTION_GOLDEN_SET: readonly ToolSelectionCase[] = [
  {
    id: "p1",
    prompt: "Can this agent spend $80 at vendor X under authority A?",
    expected: "check_financial_authority",
  },
  {
    id: "p2",
    prompt: "Submit this exact approved invoice payment for authorization.",
    expected: "request_authorized_action",
  },
  {
    id: "p3",
    prompt: "Merchant wants to verify the signed authority presentation.",
    expected: "verify_authority",
  },
  {
    id: "p4",
    prompt: "Did this payment actually capture or is the proof tampered?",
    expected: "verify_financial_proof",
  },
  {
    id: "p5",
    prompt:
      "The provider timed out after capture may have happened. Check the existing attempt.",
    expected: "reconcile_financial_action",
  },
  {
    id: "p6",
    prompt:
      "Check whether the delegated procurement limit covers this purchase.",
    expected: "check_financial_authority",
  },
  {
    id: "p7",
    prompt: "Verify this agent is still authorized for this merchant.",
    expected: "verify_authority",
  },
  { id: "n1", prompt: "What is compound interest?", expected: "NO_TOOL" },
  { id: "n2", prompt: "Summarize this finance article.", expected: "NO_TOOL" },
  { id: "n3", prompt: "What is today's exchange rate?", expected: "NO_TOOL" },
  { id: "n4", prompt: "Explain what an invoice is.", expected: "NO_TOOL" },
  { id: "a1", prompt: "Pay a vendor for me.", expected: "CLARIFY" },
  {
    id: "a2",
    prompt: "My agent can buy something, do it.",
    expected: "CLARIFY",
  },
  {
    id: "a3",
    prompt: "Retry the payment because the first call timed out.",
    expected: "reconcile_financial_action",
  },
] as const;

export type ToolSelector = (prompt: string) => ExpectedSelection;

export function referenceSafeSelector(prompt: string): ExpectedSelection {
  const text = prompt.toLowerCase();
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("retry")
  ) {
    return "reconcile_financial_action";
  }
  if (text.includes("proof") || text.includes("actually capture"))
    return "verify_financial_proof";
  if (
    text.includes("verify") &&
    (text.includes("authority") || text.includes("authorized"))
  ) {
    return "verify_authority";
  }
  if (
    text.includes("submit") &&
    (text.includes("authorization") || text.includes("approved"))
  ) {
    return "request_authorized_action";
  }
  if (
    text.includes("can this") ||
    text.includes("check whether") ||
    text.includes("limit covers")
  ) {
    return "check_financial_authority";
  }
  if (
    (text.includes("pay ") || text.includes("buy ")) &&
    !text.includes("exact")
  )
    return "CLARIFY";
  return "NO_TOOL";
}

export function runToolSelectionEval(
  selector: ToolSelector = referenceSafeSelector,
) {
  const cases = TOOL_SELECTION_GOLDEN_SET.map((entry) => {
    const actual = selector(entry.prompt);
    return { ...entry, actual, pass: actual === entry.expected };
  });
  return {
    version: "tool-selection-eval/v1",
    total: cases.length,
    passed: cases.filter((entry) => entry.pass).length,
    failed: cases.filter((entry) => !entry.pass).length,
    cases,
  } as const;
}
