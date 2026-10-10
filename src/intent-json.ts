/** Reject duplicate object keys and prototype-like keys before ordinary JSON.parse.
 * Bounded input at the caller; recursion is independently bounded here.
 */
export function parseIntentJson(text: string): unknown {
  // JSON.parse first enforces JSON lexical syntax (not Javascript/eval).
  const parsed: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  let i = 0;
  function value(depth: number): void {
    if (depth > 24) throw new Error("INVALID_MODEL_OUTPUT");
    const token = tokens[i++];
    if (token === "{") {
      const keys = new Set<string>();
      if (tokens[i] === "}") {
        i++;
        return;
      }
      while (true) {
        const key = JSON.parse(tokens[i++]!) as string;
        if (
          keys.has(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Error("INVALID_MODEL_OUTPUT");
        keys.add(key);
        i++;
        value(depth + 1);
        if (tokens[i++] === "}") return;
      }
    }
    if (token === "[") {
      if (tokens[i] === "]") {
        i++;
        return;
      }
      while (true) {
        value(depth + 1);
        if (tokens[i++] === "]") return;
      }
    }
  }
  value(0);
  return parsed;
}
