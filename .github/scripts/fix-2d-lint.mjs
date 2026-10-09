import fs from "node:fs";

let s = fs.readFileSync("src/paypal.ts", "utf8");
s = s.replace("function asRow(v: unknown): Record<string, unknown> {", `function requiredString(value: unknown, name: string): string {\n  if (typeof value !== "string" || value.length === 0) throw new Error(\`MALFORMED_PAYMENT_ATTEMPT_\${name}\`);\n  return value;\n}\n\nfunction asRow(v: unknown): Record<string, unknown> {`);
s = s.replaceAll("String(a.provider_order_id)", 'requiredString(a.provider_order_id, "PROVIDER_ORDER_ID")');
fs.writeFileSync("src/paypal.ts", s);

s = fs.readFileSync("tests/paypal.integration.test.ts", "utf8");
s = s.replace("async createOrder(): Promise<PayPalOrderView> {", "async createOrder(): Promise<PayPalOrderView> {\n    await Promise.resolve();");
s = s.replace("async captureOrder(): Promise<PayPalOrderView> {", "async captureOrder(): Promise<PayPalOrderView> {\n    await Promise.resolve();");
s = s.replace("async getOrder(): Promise<PayPalOrderView> {", "async getOrder(): Promise<PayPalOrderView> {\n    await Promise.resolve();");
fs.writeFileSync("tests/paypal.integration.test.ts", s);

s = fs.readFileSync("tests/paypal.test.ts", "utf8");
s = s.replaceAll("fetcher as typeof fetch", "fetcher");
s = s.replaceAll("const url = String(input);", "const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;");
s = s.replaceAll("String(input).endsWith", "(input instanceof Request ? input.url : input instanceof URL ? input.toString() : input).endsWith");
s = s.replace("const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: \"token\", expires_in: 60 })", "const fetcher = vi.fn(async () => { await Promise.resolve(); return new Response(JSON.stringify({ access_token: \"token\", expires_in: 60 })");
s = s.replace("headers: { \"content-type\": \"application/json\" } }));\n    const oauth = new PayPalOAuthClient(\"client\", \"secret\", fetcher", "headers: { \"content-type\": \"application/json\" } }); });\n    const oauth = new PayPalOAuthClient(\"client\", \"secret\", fetcher");
s = s.replace("const fetcher = vi.fn(async () => new Response(\"no\", { status: 401 }));", "const fetcher = vi.fn(async () => { await Promise.resolve(); return new Response(\"no\", { status: 401 }); });");
s = s.replace("const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {", "const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {\n      await Promise.resolve();");
s = s.replace("const fetcher = vi.fn(async (input: string | URL | Request) =>", "const fetcher = vi.fn(async (input: string | URL | Request) => { await Promise.resolve(); return");
s = s.replace(": new Response(\"oops\", { status: 503 }));", ": new Response(\"oops\", { status: 503 }); });");
fs.writeFileSync("tests/paypal.test.ts", s);
