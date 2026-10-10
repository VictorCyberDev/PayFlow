import {
  type IntentInterpretation,
  intentMinorUnits,
  IntentFieldSchema,
} from "./intent.js";

/** Deliberately small, conservative English checks, NOT arbitrary-language proof.
 * Never rewrites model states, derives trusted reviewBounds or grants authority.
 */
export function semanticIntentIssues(
  input: IntentInterpretation,
  source: string,
): string[] {
  const c = input.constraints;
  const issues = new Set<string>();
  const problem = (field: string) =>
    issues.add(`${field}:SEMANTIC_SUPPORT_REQUIRED`);
  const quotes = (field: keyof typeof c): string[] => {
    const value = c[field];
    return value.state === "EXPLICIT" ? value.evidence.map((e) => e.quote) : [];
  };
  const supported = (
    field: keyof typeof c,
    check: (quote: string) => boolean,
  ) => {
    if (c[field].state === "EXPLICIT" && !quotes(field).some(check))
      problem(field);
  };
  const moneyPattern =
    /^(under|less than|at most|maximum(?: of)?|no more than)\s+(?:\$)?([0-9]+(?:\.[0-9]+)?)(?:\s+(USD|EUR|GBP|AUD|CAD|JPY))?$/i;
  supported("maximum", (quote) => {
    const match = quote.trim().match(moneyPattern);
    if (
      !match ||
      c.maximum.state !== "EXPLICIT" ||
      c.currency.state !== "EXPLICIT"
    )
      return false;
    try {
      return (
        intentMinorUnits(match[2]!, c.currency.value) ===
          intentMinorUnits(c.maximum.value.decimal, c.currency.value) &&
        c.maximum.value.bound ===
          (/^(under|less than)$/i.test(match[1]!)
            ? "EXCLUSIVE"
            : "INCLUSIVE") &&
        (!match[3] || match[3].toUpperCase() === c.currency.value)
      );
    } catch {
      return false;
    }
  });
  const amounts = [
    ...source.matchAll(
      /\b(?:under|less than|at most|maximum(?: of)?|no more than)\s+\$?([0-9]+(?:\.[0-9]+)?)/gi,
    ),
  ].map((m) => m[1]);
  if (
    new Set(amounts).size > 1 ||
    /\b(around|roughly|about|near|exactly)\s+\$?[0-9]/i.test(source)
  )
    problem("maximum");
  supported(
    "currency",
    (quote) =>
      c.currency.state === "EXPLICIT" && quote.trim() === c.currency.value,
  );
  if (new Set(source.match(/\b(?:USD|EUR|GBP|AUD|CAD|JPY)\b/g)).size > 1)
    problem("currency");
  supported("quantity", (quote) => {
    if (c.quantity.state !== "EXPLICIT") return false;
    const match = quote
      .trim()
      .match(
        /^(?:quantity\s+|buy\s+)([1-9][0-9]*|one|two|three|four|five)(?:\s+items?)?$/i,
      );
    const words: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
    };
    return (
      !!match &&
      (words[match[1]!.toLowerCase()] ?? Number(match[1])) === c.quantity.value
    );
  });
  if (/\b(a few|some)\s+(?:items|keyboards|headphones)/i.test(source))
    problem("quantity");
  if (/\b(?:not|no)\s+(?:new|refurbished|used)\b/i.test(source))
    problem("conditions");
  if (/\b(?:not|no)\s+(?:USD|EUR|GBP|AUD|CAD|JPY)\b/i.test(source))
    problem("currency");
  const quantities = [
    ...source.matchAll(
      /\b(?:quantity|buy)\s+([1-9][0-9]*|one|two|three|four|five)\b/gi,
    ),
  ].map((m) => m[1]!.toLowerCase());
  if (new Set(quantities).size > 1) problem("quantity");
  supported("conditions", (quote) => {
    if (c.conditions.state !== "EXPLICIT") return false;
    const values = quote
      .trim()
      .toUpperCase()
      .replace(/\s+ONLY$/, "")
      .split(/\s*,\s*/);
    return (
      values.every((v) => ["NEW", "REFURBISHED", "USED"].includes(v)) &&
      [...new Set(values)].sort().join() ===
        [...new Set(c.conditions.value)].sort().join()
    );
  });
  if (
    /\b(unclear condition|like new|any condition|good condition)\b/i.test(
      source,
    )
  )
    problem("conditions");
  supported("merchants", (quote) => {
    if (c.merchants.state !== "EXPLICIT") return false;
    const merchant = c.merchants.value;
    if (merchant.mode === "ANY")
      return /^(any merchant|unrestricted merchants)$/i.test(quote.trim());
    const match = quote
      .trim()
      .match(/^(?:only|merchant|merchants)\s+([A-Za-z0-9._:, -]+)$/i);
    return (
      !!match &&
      match[1]!
        .split(/\s*,\s*/)
        .sort()
        .join() === [...new Set(merchant.ids)].sort().join()
    );
  });
  if (/\b(or (?:somewhere )?similar|any good merchant)\b/i.test(source))
    problem("merchants");
  const merchantScopes = [
    ...source.matchAll(
      /\b(?:only|merchant|merchants)\s+([A-Za-z0-9._:-]+)(?:\s*[,;.]|$)/gi,
    ),
  ].map((m) => m[1]);
  if (new Set(merchantScopes).size > 1) problem("merchants");
  if (
    /\b(?:not|no|never)\s+autonomous purchase\b/i.test(source) &&
    c.autonomousPurchase.state === "EXPLICIT" &&
    c.autonomousPurchase.value
  )
    problem("autonomousPurchase");
  const expiryInstants =
    source.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
  if (new Set(expiryInstants).size > 1) problem("expiresAt");
  const autonomous =
    /^(?:autonomous purchase|you (?:do not|don't) need to ask again if it stays within those rules)$/i;
  const confirm =
    /^(?:ask me before purchasing|confirmation required|no autonomous purchase)$/i;
  supported(
    "autonomousPurchase",
    (quote) =>
      c.autonomousPurchase.state === "EXPLICIT" &&
      (c.autonomousPurchase.value ? autonomous : confirm).test(
        quote.trim().replace(/\.$/, ""),
      ),
  );
  supported(
    "confirmationRequired",
    (quote) =>
      c.confirmationRequired.state === "EXPLICIT" &&
      (c.confirmationRequired.value
        ? confirm
        : /^(?:no additional confirmation|you (?:do not|don't) need to ask again if it stays within those rules)$/i
      ).test(quote.trim().replace(/\.$/, "")),
  );
  if (
    /\b(?:ask me before purchasing|confirmation required)\b/i.test(source) &&
    /\b(?:autonomous purchase|don't need to ask again|no additional confirmation)\b/i.test(
      source,
    )
  ) {
    problem("autonomousPurchase");
    problem("confirmationRequired");
  }
  supported(
    "expiresAt",
    (quote) =>
      c.expiresAt.state === "EXPLICIT" && quote.trim() === c.expiresAt.value,
  );
  if (/\b(?:buy it soon|expires? soon|sometime|vague expiry)\b/i.test(source))
    problem("expiresAt");
  supported(
    "capabilities",
    (quote) =>
      c.capabilities.state === "EXPLICIT" &&
      [...new Set(quote.trim().split(/\s+/))].sort().join() ===
        [...new Set(c.capabilities.value)].sort().join(),
  );
  // Every explicit critical field must independently carry its own recognized support.
  // Item/category meaning and omitted arbitrary restrictions still need human review.
  return [...issues].sort();
}
const questions: Record<string, string> = {
  item: "What item do you want?",
  category: "What product category should apply?",
  maximum:
    "What is the strict maximum amount, and must the price be below it or may it equal it?",
  currency: "Which currency applies to the spending limit?",
  quantity: "How many items may be purchased?",
  conditions: "Which item conditions are permitted?",
  merchants:
    "Which exact merchants are permitted, or may any merchant be used?",
  autonomousPurchase:
    "May purchases proceed within the stated rules, or must you approve each purchase?",
  confirmationRequired:
    "Must you confirm each purchase within the stated rules?",
  expiresAt: "When exactly should these proposed permissions expire?",
  capabilities: "Which supported commerce capabilities are being proposed?",
};
export function clarificationQuestions(
  issues: readonly string[],
): readonly string[] {
  const fields = new Set(issues.map((issue) => issue.split(":")[0]));
  return Object.freeze([
    ...new Set([
      ...IntentFieldSchema.options
        .filter((f) => fields.has(f))
        .map((f) => questions[f]!),
      ...(fields.has("PURCHASE_PERMISSION_MISSING")
        ? [questions.autonomousPurchase!]
        : []),
    ]),
  ]);
}
