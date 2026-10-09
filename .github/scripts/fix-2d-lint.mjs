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
s = s.replace("async () =>\n        new Response(", "async () => (await Promise.resolve(), new Response(");
s = s.replace("{ status: 200, headers: { \"content-type\": \"application/json\" } },\n        ),\n    );", "{ status: 200, headers: { \"content-type\": \"application/json\" } },\n        )),\n    );");
s = s.replace('async () => new Response("no", { status: 401 })', 'async () => (await Promise.resolve(), new Response("no", { status: 401 }))');
s = s.replace("async (input: string | URL | Request, init?: RequestInit) => {\n        const url = String(input);", "async (input: string | URL | Request, init?: RequestInit) => {\n        await Promise.resolve();\n        const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;");
const oldAmbiguous = `const fetcher = vi.fn(async (input: string | URL | Request) =>\n      String(input).endsWith("/v1/oauth2/token")\n        ? new Response(\n            JSON.stringify({ access_token: "token", expires_in: 3600 }),\n            { status: 200, headers: { "content-type": "application/json" } },\n          )\n        : new Response("oops", { status: 503 }),\n    );`;
const newAmbiguous = `const fetcher = vi.fn(async (input: string | URL | Request) => {\n      await Promise.resolve();\n      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;\n      return url.endsWith("/v1/oauth2/token")\n        ? new Response(\n            JSON.stringify({ access_token: "token", expires_in: 3600 }),\n            { status: 200, headers: { "content-type": "application/json" } },\n          )\n        : new Response("oops", { status: 503 });\n    });`;
s = s.replace(oldAmbiguous, newAmbiguous);
fs.writeFileSync("tests/paypal.test.ts", s);
