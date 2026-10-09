import fs from "node:fs";

let s = fs.readFileSync("src/paypal.ts", "utf8");
s = s.replace("function asRow(v: unknown): Record<string, unknown> {", `function requiredString(value: unknown, name: string): string {\n  if (typeof value !== "string" || value.length === 0) throw new Error(\`MALFORMED_PAYMENT_ATTEMPT_\${name}\`);\n  return value;\n}\n\nfunction asRow(v: unknown): Record<string, unknown> {`);
s = s.replaceAll("String(a.provider_order_id)", 'requiredString(a.provider_order_id, "PROVIDER_ORDER_ID")');
fs.writeFileSync("src/paypal.ts", s);

s = fs.readFileSync("tests/paypal.integration.test.ts", "utf8");
s = s.replace("async createOrder(): Promise<PayPalOrderView> {", "createOrder(): Promise<PayPalOrderView> {");
s = s.replace("return this.order;\n  }\n  async captureOrder", "return Promise.resolve(this.order);\n  }\n  captureOrder");
s = s.replace('throw new PayPalProviderError("AMBIGUOUS", "SIMULATED_RESPONSE_LOSS");', 'return Promise.reject(new PayPalProviderError("AMBIGUOUS", "SIMULATED_RESPONSE_LOSS"));');
s = s.replace("async getOrder(): Promise<PayPalOrderView> {", "getOrder(): Promise<PayPalOrderView> {");
s = s.replace('if (!this.order) throw new Error("ORDER_NOT_FOUND");\n    return this.order;', 'if (!this.order) return Promise.reject(new Error("ORDER_NOT_FOUND"));\n    return Promise.resolve(this.order);');
fs.writeFileSync("tests/paypal.integration.test.ts", s);

s = fs.readFileSync("tests/paypal.test.ts", "utf8");
s = s.replaceAll("fetcher as typeof fetch", "fetcher");
s = s.replaceAll("const url = String(input);", "const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;");
s = s.replaceAll("String(input).endsWith", "(input instanceof Request ? input.url : input instanceof URL ? input.toString() : input).endsWith");
s = s.replaceAll("vi.fn(async () => new Response", "vi.fn(() => Promise.resolve(new Response");
s = s.replaceAll("vi.fn(async (input: string | URL | Request, init?: RequestInit) => {", "vi.fn((input: string | URL | Request, init?: RequestInit) => {");
s = s.replaceAll("vi.fn(async (input: string | URL | Request) =>", "vi.fn((input: string | URL | Request) =>");
fs.writeFileSync("tests/paypal.test.ts", s);
